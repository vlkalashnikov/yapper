import * as vscode from "vscode";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent, Raw } from "telegram/events";
import { EditedMessage, EditedMessageEvent } from "telegram/events/EditedMessage";
import { DeletedMessage, DeletedMessageEvent } from "telegram/events/DeletedMessage";
import { LogLevel } from "telegram/extensions/Logger";
import { getPeerId } from "telegram/Utils";
import type { EntityLike } from "telegram/define";
import {
  Chat,
  Folder,
  GlobalHit,
  MediaFile,
  Member,
  Message,
  Messenger,
  Profile,
  Topic,
} from "../types";
import { TelegramStorage } from "./storage";
import { promptCredentials, promptPassword } from "./auth";
import { QrLoginPanel, QrLoginText } from "../../ui/QrLoginPanel";
import {
  canSendTo,
  chatIcon,
  extFromMime,
  extOf,
  isMuted,
  mapEntities,
  matchesFolderFlags,
} from "./helpers";

// Fetch effectively all dialogs: the list and folders classify only loaded
// chats, so a small cap would hide chats beyond the most-recent ones (BUG-001).
const DIALOG_LIMIT = 1000;
const HISTORY_LIMIT = 50;

/**
 * Telegram backend built on GramJS. Handles login (phone / code / 2FA),
 * session persistence, reading dialogs and history, sending, and realtime
 * incoming messages.
 */
export class TelegramProvider implements Messenger {
  readonly id = "telegram";
  readonly name = "Telegram";
  readonly historyPageSize = HISTORY_LIMIT;

  private client?: TelegramClient;
  /** Cache of chatId -> entity, populated from getDialogs to resolve sends/history. */
  private readonly entities = new Map<string, EntityLike>();
  /** Cache of chatId -> avatar data URL (undefined = fetched, none available). */
  private readonly avatars = new Map<string, string | undefined>();
  /** Cache of chatId -> big (profile) avatar data URL. */
  private readonly bigAvatars = new Map<string, string | undefined>();
  /** Cache of "chatId:messageId" -> Api.Message, so media can be downloaded lazily. */
  private readonly messageCache = new Map<string, Api.Message>();
  /** Cache of "chatId:messageId" -> media data URL. */
  private readonly mediaCache = new Map<string, string | undefined>();
  /** Cache of chatId -> highest own message id the peer has read (private chats). */
  private readonly readOutbox = new Map<string, number>();
  /** Cache of chatId -> muted, kept current via getChats + UpdateNotifySettings. */
  private readonly mutedChats = new Map<string, boolean>();

  private readonly _onMessage = new vscode.EventEmitter<Message>();
  /** Fires when a new message arrives in any chat. */
  readonly onMessage = this._onMessage.event;

  private readonly _onMessageEdited = new vscode.EventEmitter<Message>();
  /** Fires when a message is edited. */
  readonly onMessageEdited = this._onMessageEdited.event;

  private readonly _onMessagesDeleted = new vscode.EventEmitter<{
    chatId?: string;
    ids: string[];
  }>();
  /** Fires when messages are deleted (chatId may be unknown for private chats). */
  readonly onMessagesDeleted = this._onMessagesDeleted.event;

  private readonly _onConnectionChange = new vscode.EventEmitter<boolean>();
  /** Fires true after login/reconnect, false after logout. */
  readonly onConnectionChange = this._onConnectionChange.event;

  private readonly _onReadOutbox = new vscode.EventEmitter<{
    chatId: string;
    maxId: number;
  }>();
  /** Fires when the peer reads our messages up to maxId (read receipts). */
  readonly onReadOutbox = this._onReadOutbox.event;

  constructor(private readonly storage: TelegramStorage) {}

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  /** Reconnect a previously saved session on startup. Silent no-op if not logged in. */
  async init(): Promise<void> {
    const [saved, creds] = await Promise.all([
      this.storage.getSession(),
      this.storage.getCredentials(),
    ]);
    if (!saved || !creds) {
      return;
    }

    const client = this.createClient(saved, creds.apiId, creds.apiHash);
    try {
      await client.connect();
      if (!(await client.checkAuthorization())) {
        await client.disconnect();
        return;
      }
    } catch (err) {
      console.error("[Yapper] Telegram reconnect failed:", err);
      return;
    }

    this.attach(client);
  }

  /** Interactive login via QR code. Prompts for API credentials once, then
   *  shows a QR to scan from the mobile Telegram app; asks for the 2FA
   *  password only if the account has one. */
  async login(): Promise<void> {
    // Only ask for api_id/api_hash the first time. Once stored, login is QR-only.
    let creds = await this.storage.getCredentials();
    if (!creds) {
      creds = await promptCredentials();
      if (!creds) {
        return;
      }
      await this.storage.setCredentials(creds);
    }

    const client = this.createClient("", creds.apiId, creds.apiHash);
    const qr = new QrLoginPanel(telegramQrText());

    try {
      await client.connect();
      // Race the sign-in against the user closing the QR panel.
      await Promise.race([
        client.signInUserWithQrCode(
          { apiId: creds.apiId, apiHash: creds.apiHash },
          {
            qrCode: (token) => qr.render(loginUrl(token.token)),
            password: promptPassword,
            onError: (err) => {
              console.error("[Yapper] QR login error:", err);
            },
          }
        ),
        qr.onCancel,
      ]);
    } catch (err) {
      await client.disconnect().catch(() => undefined);
      throw err;
    } finally {
      qr.close();
    }

    await this.storage.setSession(client.session.save() as unknown as string);
    this.attach(client);
  }

  async logout(): Promise<void> {
    await this.client?.disconnect().catch(() => undefined);
    this.client = undefined;
    this.entities.clear();
    this.avatars.clear();
    this.bigAvatars.clear();
    this.messageCache.clear();
    this.mediaCache.clear();
    this.readOutbox.clear();
    this.mutedChats.clear();
    await this.storage.clearSession();
    this._onConnectionChange.fire(false);
  }

  async getChats(): Promise<Chat[]> {
    if (!this.client) {
      return [];
    }
    const dialogs = await this.client.getDialogs({ limit: DIALOG_LIMIT });
    const chats: Chat[] = [];
    for (const dialog of dialogs) {
      if (!dialog.entity || dialog.id === undefined) {
        continue;
      }
      const id = dialog.id.toString();
      this.entities.set(id, dialog.entity);
      const raw = dialog.dialog instanceof Api.Dialog ? dialog.dialog : undefined;
      if (raw) {
        this.readOutbox.set(id, raw.readOutboxMaxId ?? 0);
      }
      const muted = isMuted(raw?.notifySettings);
      this.mutedChats.set(id, muted);
      chats.push({
        id,
        title: dialog.title || dialog.name || "—",
        lastMessage: dialog.message?.message || undefined,
        unreadCount: dialog.unreadCount || 0,
        isForum:
          dialog.entity instanceof Api.Channel && dialog.entity.forum === true,
        canSend: canSendTo(dialog.entity),
        muted,
        archived: dialog.archived,
        icon: chatIcon(dialog.entity),
      });
    }
    return chats;
  }

  async getMessages(chatId: string, topicId?: string): Promise<Message[]> {
    return this.loadHistory(chatId, undefined, topicId);
  }

  async getMessagesBefore(
    chatId: string,
    beforeMessageId: string,
    topicId?: string
  ): Promise<Message[]> {
    return this.loadHistory(chatId, Number(beforeMessageId), topicId);
  }

  async markAsRead(chatId: string, topicId?: string): Promise<void> {
    // Per-topic read isn't wired yet; skip so we don't clear sibling topics.
    if (!this.client || topicId) {
      return;
    }
    const entity = await this.resolveEntity(chatId);
    if (!entity) {
      return;
    }
    try {
      await this.client.markAsRead(entity);
    } catch (err) {
      console.error("[Yapper] markAsRead failed:", err);
    }
  }

  /** Messages around a specific message (a window for jump-to-message), oldest
   *  first, so a search/reply target loads with context even if far back. */
  async getMessagesAround(
    chatId: string,
    messageId: string,
    topicId?: string
  ): Promise<Message[]> {
    // addOffset shifts the window so ~half the page is newer than the target.
    return this.loadHistory(
      chatId,
      Number(messageId),
      topicId,
      -Math.floor(HISTORY_LIMIT / 2)
    );
  }

  /** A page of messages newer than the given id (forward pagination after a
   *  jump, so the user can scroll down toward the latest message). */
  async getMessagesAfter(
    chatId: string,
    afterMessageId: string,
    topicId?: string
  ): Promise<Message[]> {
    return this.loadHistory(chatId, Number(afterMessageId), topicId, -HISTORY_LIMIT);
  }

  /** Load up to HISTORY_LIMIT messages, optionally older than offsetId (or, with
   *  addOffset, a window around it), optionally filtered to a forum topic. */
  private async loadHistory(
    chatId: string,
    offsetId?: number,
    topicId?: string,
    addOffset?: number
  ): Promise<Message[]> {
    if (!this.client) {
      return [];
    }
    const entity = await this.resolveEntity(chatId);
    if (!entity) {
      return [];
    }
    const history = await this.client.getMessages(entity, {
      limit: HISTORY_LIMIT,
      ...(offsetId ? { offsetId } : {}),
      ...(addOffset ? { addOffset } : {}),
      ...(topicId ? { replyTo: Number(topicId) } : {}),
    });
    // GramJS returns newest-first; present oldest-first.
    const ordered = history
      .reverse()
      .filter((m): m is Api.Message => m instanceof Api.Message);

    // Fetch replied-to messages (for reply previews) not already cached.
    const missing = new Set<number>();
    for (const m of ordered) {
      const rid = m.replyToMsgId;
      if (rid && !this.messageCache.has(`${chatId}:${rid}`)) {
        missing.add(rid);
      }
    }
    if (missing.size > 0) {
      try {
        const fetched = await this.client.getMessages(entity, { ids: [...missing] });
        for (const fm of fetched) {
          if (fm instanceof Api.Message) {
            this.messageCache.set(`${chatId}:${fm.id}`, fm);
          }
        }
      } catch (err) {
        console.error("[Yapper] reply fetch failed:", err);
      }
    }

    const result: Message[] = [];
    for (const m of ordered) {
      this.messageCache.set(`${chatId}:${m.id}`, m);
      const msg = this.toMessage(chatId, m);
      // Incoming messages carry the sender's own avatar (matters in groups).
      if (!msg.outgoing) {
        msg.avatar = await this.avatarForSender(m);
      }
      msg.reply = this.buildReply(chatId, m);
      result.push(msg);
    }
    return result;
  }

  /** Build a reply preview for a message, if it replies to another. */
  private buildReply(chatId: string, m: Api.Message): Message["reply"] {
    const rid = m.replyToMsgId;
    if (!rid) {
      return undefined;
    }
    const target = this.messageCache.get(`${chatId}:${rid}`);
    if (!target) {
      return { id: String(rid), author: "", text: vscode.l10n.t("Message") };
    }
    return {
      id: String(rid),
      author: target.out ? vscode.l10n.t("You") : senderName(target),
      text: replySnippet(target),
    };
  }

  /** Download a message's image thumbnail as a data URL (lazy, cached). */
  async getMedia(chatId: string, messageId: string): Promise<string | undefined> {
    const key = `${chatId}:${messageId}`;
    if (this.mediaCache.has(key)) {
      return this.mediaCache.get(key);
    }
    const m = this.messageCache.get(key);
    if (!this.client || !m) {
      return undefined;
    }
    try {
      // Prefer a small thumbnail; fall back to the smallest available.
      let buf = await this.client
        .downloadMedia(m, { thumb: 1 })
        .catch(() => undefined);
      if (!buf) {
        buf = await this.client.downloadMedia(m, { thumb: 0 }).catch(() => undefined);
      }
      const dataUrl =
        typeof buf !== "string" && buf && buf.length
          ? `data:image/jpeg;base64,${buf.toString("base64")}`
          : undefined;
      this.mediaCache.set(key, dataUrl);
      return dataUrl;
    } catch (err) {
      console.error("[Yapper] media download failed:", err);
      this.mediaCache.set(key, undefined);
      return undefined;
    }
  }

  /** Search chat members for @-mention autocomplete. */
  async searchMembers(chatId: string, query: string): Promise<Member[]> {
    if (!this.client) {
      return [];
    }
    const entity = await this.resolveEntity(chatId);
    if (!entity) {
      return [];
    }
    try {
      const users = await this.client.getParticipants(entity, {
        search: query,
        limit: 8,
      });
      return users
        .filter((u): u is Api.User => u instanceof Api.User && !u.deleted && !u.bot)
        .map((u) => ({
          id: u.id.toString(),
          name:
            [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
            u.username ||
            "—",
          username: u.username || undefined,
        }));
    } catch (err) {
      // Private chats / broadcast channels have no searchable participants.
      console.error("[Yapper] searchMembers failed:", err);
      return [];
    }
  }

  /** Search messages within a chat (newest first), optionally a forum topic. */
  async searchMessages(
    chatId: string,
    query: string,
    topicId?: string
  ): Promise<Message[]> {
    if (!this.client) {
      return [];
    }
    const entity = await this.resolveEntity(chatId);
    if (!entity) {
      return [];
    }
    try {
      const found = await this.client.getMessages(entity, {
        search: query,
        limit: 30,
        ...(topicId ? { replyTo: Number(topicId) } : {}),
      });
      const result: Message[] = [];
      for (const m of found) {
        if (!(m instanceof Api.Message)) {
          continue;
        }
        this.messageCache.set(`${chatId}:${m.id}`, m);
        result.push(this.toMessage(chatId, m));
      }
      return result;
    } catch (err) {
      console.error("[Yapper] searchMessages failed:", err);
      return [];
    }
  }

  /** Search messages across all chats (global search), most relevant first. */
  async searchGlobal(query: string): Promise<GlobalHit[]> {
    if (!this.client) {
      return [];
    }
    try {
      const res = await this.client.invoke(
        new Api.messages.SearchGlobal({
          q: query,
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: 0,
          maxDate: 0,
          offsetRate: 0,
          offsetPeer: new Api.InputPeerEmpty(),
          offsetId: 0,
          limit: 40,
        })
      );
      if (!("messages" in res)) {
        return [];
      }
      // Resolve each hit's chat title from the returned chats/users.
      const byId = new Map<string, EntityLike>();
      for (const c of res.chats) {
        byId.set(getPeerId(c).toString(), c);
      }
      for (const u of res.users) {
        byId.set(getPeerId(u).toString(), u);
      }
      const hits: GlobalHit[] = [];
      for (const m of res.messages) {
        if (!(m instanceof Api.Message)) {
          continue;
        }
        const chatId = getPeerId(m.peerId).toString();
        const entity = byId.get(chatId);
        if (entity) {
          this.entities.set(chatId, entity); // so the chat can be opened on click
        }
        this.messageCache.set(`${chatId}:${m.id}`, m);
        hits.push({
          chatId,
          chatTitle: entityTitle(entity),
          messageId: String(m.id),
          snippet: messageText(m).replace(/\s+/g, " ").trim(),
          timestamp: (m.date ?? 0) * 1000,
        });
      }
      return hits;
    } catch (err) {
      console.error("[Yapper] searchGlobal failed:", err);
      return [];
    }
  }

  /** Download full-resolution media for opening in a viewer/player. */
  async getMediaFile(chatId: string, messageId: string): Promise<MediaFile | undefined> {
    const m = this.messageCache.get(`${chatId}:${messageId}`);
    if (!this.client || !m) {
      return undefined;
    }
    try {
      const buf = await this.client.downloadMedia(m);
      if (typeof buf === "string" || !buf || !buf.length) {
        return undefined;
      }
      const rawDoc =
        m.media instanceof Api.MessageMediaDocument &&
        m.media.document instanceof Api.Document
          ? m.media.document
          : undefined;

      // Plain documents (files/audio/voice) keep their real name and mime type.
      const doc = documentInfo(m);
      if (doc) {
        const mime = rawDoc?.mimeType || "application/octet-stream";
        return {
          data: buf,
          filename: doc.name,
          extension: extOf(doc.name) || extFromMime(mime) || "bin",
          mime,
          kind: "file",
        };
      }
      // Video / gif: carry the document's real container so the audio track
      // survives (hardcoding mp4 could mislabel a webm/mov and drop sound).
      const kind = mediaKind(m);
      if (kind === "video" || kind === "gif") {
        const mime = rawDoc?.mimeType || "video/mp4";
        const extension = extFromMime(mime) || "mp4";
        return { data: buf, filename: `${messageId}.${extension}`, extension, mime, kind: "video" };
      }
      // Photos / stickers.
      const extension = kind === "sticker" ? "webp" : "jpg";
      const mime = kind === "sticker" ? "image/webp" : "image/jpeg";
      return { data: buf, filename: `${messageId}.${extension}`, extension, mime, kind: "image" };
    } catch (err) {
      console.error("[Yapper] full media download failed:", err);
      return undefined;
    }
  }

  /** Forum topics of a forum group. */
  async getTopics(chatId: string): Promise<Topic[]> {
    if (!this.client) {
      return [];
    }
    const entity = await this.resolveEntity(chatId);
    if (!entity) {
      return [];
    }
    try {
      const res = await this.client.invoke(
        new Api.channels.GetForumTopics({
          channel: entity,
          limit: 100,
          offsetDate: 0,
          offsetId: 0,
          offsetTopic: 0,
        })
      );
      return res.topics
        .filter((t): t is Api.ForumTopic => t instanceof Api.ForumTopic)
        .map((t) => ({
          id: String(t.id),
          title: t.title,
          unreadCount: t.unreadCount || 0,
          closed: t.closed === true,
        }));
    } catch (err) {
      console.error("[Yapper] getTopics failed:", err);
      return [];
    }
  }

  /** User's folders (dialog filters) with their member chat ids. `chats` must
   *  come from a prior getChats() so entities are already populated (avoids a
   *  second getDialogs round-trip). */
  async getFolders(chats: Chat[]): Promise<Folder[]> {
    if (!this.client) {
      return [];
    }
    const response = await this.client.invoke(new Api.messages.GetDialogFilters());
    const filters = response.filters ?? [];

    const folders: Folder[] = [];
    for (const f of filters) {
      if (!(f instanceof Api.DialogFilter)) {
        continue; // skip "All chats" default and shared chat-list folders
      }
      const include = new Set(
        [...f.pinnedPeers, ...f.includePeers].map((p) => getPeerId(p))
      );
      const exclude = new Set(f.excludePeers.map((p) => getPeerId(p)));

      const chatIds: string[] = [];
      for (const chat of chats) {
        if (chat.archived) {
          continue; // archived chats belong only to the Archive folder
        }
        const entity = this.entities.get(chat.id);
        if (!entity) {
          continue;
        }
        const mid = getPeerId(entity);
        if (exclude.has(mid)) {
          continue;
        }
        if (include.has(mid) || matchesFolderFlags(f, entity)) {
          chatIds.push(chat.id);
        }
      }

      folders.push({
        id: f.id,
        title: folderTitle(f.title),
        chatIds,
      });
    }
    return folders;
  }

  /** Resolve a username or known chat id to a chat (t.me links, global search). */
  async resolveChat(query: string): Promise<Chat | undefined> {
    if (!this.client) {
      return undefined;
    }
    try {
      // A known chat id (e.g. from global search) is already cached.
      const entity = this.entities.get(query) ?? (await this.client.getEntity(query));
      const id = getPeerId(entity).toString();
      this.entities.set(id, entity);
      return {
        id,
        title: entityTitle(entity),
        isForum: entity instanceof Api.Channel && entity.forum === true,
        canSend: canSendTo(entity),
      };
    } catch (err) {
      console.error("[Yapper] resolveChat failed:", err);
      return undefined;
    }
  }

  /** Chat avatar (used for the conversation header). */
  async getAvatar(chatId: string): Promise<string | undefined> {
    if (!this.client) {
      return undefined;
    }
    const entity = await this.resolveEntity(chatId);
    if (!entity) {
      return undefined;
    }
    return this.avatarFor(chatId, entity);
  }

  /** Profile info (name, bio/description, status/members) — no avatar, so the
   *  card renders instantly; the avatar is streamed separately via getProfileAvatar. */
  async getProfile(chatId: string): Promise<Profile | undefined> {
    if (!this.client) {
      return undefined;
    }
    const entity = await this.resolveEntity(chatId);
    if (!entity) {
      return undefined;
    }
    try {
      if (entity instanceof Api.User) {
        const full = await this.client.invoke(
          new Api.users.GetFullUser({ id: entity })
        );
        return {
          kind: "user",
          title:
            [entity.firstName, entity.lastName].filter(Boolean).join(" ").trim() ||
            entity.username ||
            "—",
          username: entity.username || undefined,
          usernameUrl: entity.username ? `https://t.me/${entity.username}` : undefined,
          bio: full.fullUser.about || undefined,
          phone: entity.phone ? `+${entity.phone}` : undefined,
          subtitle: userStatusText(entity.status),
          commonChats: full.fullUser.commonChatsCount || undefined,
        };
      }
      if (entity instanceof Api.Channel) {
        const full = await this.client.invoke(
          new Api.channels.GetFullChannel({ channel: entity })
        );
        const fc = full.fullChat;
        const count = fc instanceof Api.ChannelFull ? fc.participantsCount : undefined;
        return {
          kind: entity.broadcast ? "channel" : "group",
          title: entity.title,
          username: entity.username || undefined,
          usernameUrl: entity.username ? `https://t.me/${entity.username}` : undefined,
          bio: fc.about || undefined,
          subtitle: membersText(count, entity.broadcast === true),
          inviteLink: inviteLinkOf(fc.exportedInvite),
        };
      }
      if (entity instanceof Api.Chat) {
        const full = await this.client.invoke(
          new Api.messages.GetFullChat({ chatId: entity.id })
        );
        return {
          kind: "group",
          title: entity.title,
          bio: full.fullChat.about || undefined,
          subtitle: membersText(entity.participantsCount, false),
          inviteLink: inviteLinkOf(full.fullChat.exportedInvite),
        };
      }
    } catch (err) {
      console.error("[Yapper] getProfile failed:", err);
    }
    return undefined;
  }

  /** The big profile avatar, fetched separately so the card need not wait for it. */
  async getProfileAvatar(chatId: string): Promise<string | undefined> {
    if (this.bigAvatars.has(chatId)) {
      return this.bigAvatars.get(chatId);
    }
    if (!this.client) {
      return undefined;
    }
    const entity = await this.resolveEntity(chatId);
    if (!entity) {
      return undefined;
    }
    const url = await this.bigAvatar(entity);
    this.bigAvatars.set(chatId, url);
    return url;
  }

  /** Shared media of a chat: photos/videos ("media") or documents ("files"). */
  async getSharedMedia(
    chatId: string,
    kind: "media" | "files",
    topicId?: string
  ): Promise<Message[]> {
    if (!this.client) {
      return [];
    }
    const entity = await this.resolveEntity(chatId);
    if (!entity) {
      return [];
    }
    const filter =
      kind === "files"
        ? new Api.InputMessagesFilterDocument()
        : new Api.InputMessagesFilterPhotoVideo();
    try {
      const found = await this.client.getMessages(entity, {
        limit: 60,
        filter,
        ...(topicId ? { replyTo: Number(topicId) } : {}),
      });
      const result: Message[] = [];
      for (const m of found) {
        if (!(m instanceof Api.Message)) {
          continue;
        }
        this.messageCache.set(`${chatId}:${m.id}`, m);
        result.push(this.toMessage(chatId, m));
      }
      return result;
    } catch (err) {
      console.error("[Yapper] getSharedMedia failed:", err);
      return [];
    }
  }

  /** Mute or unmute notifications for a chat. */
  async setMuted(chatId: string, muted: boolean): Promise<void> {
    if (!this.client) {
      return;
    }
    const entity = await this.resolveEntity(chatId);
    if (!entity) {
      return;
    }
    try {
      const peer = await this.client.getInputEntity(entity);
      await this.client.invoke(
        new Api.account.UpdateNotifySettings({
          peer: new Api.InputNotifyPeer({ peer }),
          // A far-future muteUntil mutes "forever"; 0 unmutes.
          settings: new Api.InputPeerNotifySettings({
            muteUntil: muted ? 2147483647 : 0,
          }),
        })
      );
      this.mutedChats.set(chatId, muted);
    } catch (err) {
      console.error("[Yapper] setMuted failed:", err);
    }
  }

  /** Whether a chat is currently muted (kept live via getChats + realtime). */
  isChatMuted(chatId: string): boolean {
    return this.mutedChats.get(chatId) ?? false;
  }

  /** Download a large profile photo as a data URL (not cached — profile only). */
  private async bigAvatar(entity: EntityLike): Promise<string | undefined> {
    if (!this.client) {
      return undefined;
    }
    try {
      const buf = await this.client.downloadProfilePhoto(entity, { isBig: true });
      return typeof buf !== "string" && buf && buf.length
        ? `data:image/jpeg;base64,${buf.toString("base64")}`
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Download an entity's avatar as a data URL, cached by its id. */
  private async avatarFor(
    id: string,
    entity: EntityLike
  ): Promise<string | undefined> {
    if (this.avatars.has(id)) {
      return this.avatars.get(id);
    }
    if (!this.client) {
      return undefined;
    }
    try {
      const buf = await this.client.downloadProfilePhoto(entity, { isBig: false });
      const dataUrl =
        typeof buf !== "string" && buf && buf.length
          ? `data:image/jpeg;base64,${buf.toString("base64")}`
          : undefined;
      this.avatars.set(id, dataUrl);
      return dataUrl;
    } catch (err) {
      console.error("[Yapper] avatar download failed:", err);
      this.avatars.set(id, undefined);
      return undefined;
    }
  }

  /** Avatar of a message's sender (for per-author avatars in group chats). */
  private async avatarForSender(m: Api.Message): Promise<string | undefined> {
    const sender = m.sender;
    const id = m.senderId?.toString();
    if (!sender || !id) {
      return undefined;
    }
    return this.avatarFor(id, sender);
  }

  async sendMessage(
    chatId: string,
    text: string,
    replyToId?: string,
    topicId?: string
  ): Promise<Message> {
    if (!this.client) {
      throw new Error(vscode.l10n.t("Not connected to Telegram"));
    }
    const entity = await this.resolveEntity(chatId);
    if (!entity) {
      throw new Error(vscode.l10n.t("Chat not found"));
    }
    const sent = await this.client.sendMessage(entity, {
      message: text,
      ...(replyToId ? { replyTo: Number(replyToId) } : {}),
      ...(topicId ? { topMsgId: Number(topicId) } : {}),
    });
    this.messageCache.set(`${chatId}:${sent.id}`, sent);
    const msg = this.toMessage(chatId, sent);
    msg.reply = this.buildReply(chatId, sent);
    return msg;
  }

  async sendCode(
    chatId: string,
    text: string,
    language?: string,
    topicId?: string
  ): Promise<Message> {
    if (!this.client) {
      throw new Error(vscode.l10n.t("Not connected to Telegram"));
    }
    const entity = await this.resolveEntity(chatId);
    if (!entity) {
      throw new Error(vscode.l10n.t("Chat not found"));
    }
    const lang = (language ?? "").replace(/[^a-z0-9-]/gi, "");
    const langAttr = lang ? ` class="language-${lang}"` : "";
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const sent = await this.client.sendMessage(entity, {
      // An HTML <pre> block renders as a code block AND suppresses the
      // @mention / #hashtag auto-parsing that plain diff text would trigger.
      message: `<pre><code${langAttr}>${escaped}</code></pre>`,
      parseMode: "html",
      ...(topicId ? { topMsgId: Number(topicId) } : {}),
    });
    this.messageCache.set(`${chatId}:${sent.id}`, sent);
    const msg = this.toMessage(chatId, sent);
    msg.reply = this.buildReply(chatId, sent);
    return msg;
  }

  async sendFile(
    chatId: string,
    filePath: string,
    filename?: string,
    topicId?: string
  ): Promise<Message> {
    if (!this.client) {
      throw new Error(vscode.l10n.t("Not connected to Telegram"));
    }
    const entity = await this.resolveEntity(chatId);
    if (!entity) {
      throw new Error(vscode.l10n.t("Chat not found"));
    }
    const sent = await this.client.sendFile(entity, {
      file: filePath,
      // Force a document so source files aren't reinterpreted as photo/video.
      forceDocument: true,
      ...(filename
        ? { attributes: [new Api.DocumentAttributeFilename({ fileName: filename })] }
        : {}),
      ...(topicId ? { replyTo: Number(topicId) } : {}),
    });
    this.messageCache.set(`${chatId}:${sent.id}`, sent);
    const msg = this.toMessage(chatId, sent);
    msg.reply = this.buildReply(chatId, sent);
    return msg;
  }

  async sendImage(
    chatId: string,
    filePath: string,
    caption?: string,
    topicId?: string
  ): Promise<Message> {
    if (!this.client) {
      throw new Error(vscode.l10n.t("Not connected to Telegram"));
    }
    const entity = await this.resolveEntity(chatId);
    if (!entity) {
      throw new Error(vscode.l10n.t("Chat not found"));
    }
    // No forceDocument: Telegram sends it as an inline photo, not a file.
    const sent = await this.client.sendFile(entity, {
      file: filePath,
      ...(caption ? { caption } : {}),
      ...(topicId ? { replyTo: Number(topicId) } : {}),
    });
    this.messageCache.set(`${chatId}:${sent.id}`, sent);
    const msg = this.toMessage(chatId, sent);
    msg.reply = this.buildReply(chatId, sent);
    return msg;
  }

  dispose(): void {
    void this.client?.disconnect().catch(() => undefined);
    this._onMessage.dispose();
    this._onMessageEdited.dispose();
    this._onMessagesDeleted.dispose();
    this._onConnectionChange.dispose();
    this._onReadOutbox.dispose();
  }

  // --- internals ---

  private createClient(session: string, apiId: number, apiHash: string): TelegramClient {
    const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: 5,
    });
    client.setLogLevel(LogLevel.ERROR);
    return client;
  }

  private attach(client: TelegramClient): void {
    this.client = client;
    client.addEventHandler((event: NewMessageEvent) => {
      void this.handleIncoming(event, this._onMessage);
    }, new NewMessage({}));
    client.addEventHandler((event: EditedMessageEvent) => {
      void this.handleIncoming(event, this._onMessageEdited);
    }, new EditedMessage({}));
    client.addEventHandler((event: DeletedMessageEvent) => {
      this._onMessagesDeleted.fire({
        chatId: event.chatId?.toString(),
        ids: event.deletedIds.map(String),
      });
    }, new DeletedMessage({}));
    // Read receipts arrive as raw updates, not as high-level events.
    client.addEventHandler((update) => this.handleRawUpdate(update), new Raw({}));
    this._onConnectionChange.fire(true);
  }

  /** Handle raw updates: read receipts (✓ → ✓✓) and mute changes. */
  private handleRawUpdate(update: Api.TypeUpdate): void {
    if (update instanceof Api.UpdateReadHistoryOutbox) {
      const chatId = getPeerId(update.peer).toString();
      this.readOutbox.set(chatId, update.maxId);
      this._onReadOutbox.fire({ chatId, maxId: update.maxId });
    } else if (
      update instanceof Api.UpdateNotifySettings &&
      update.peer instanceof Api.NotifyPeer
    ) {
      // Mute/unmute (from any client) — keep the muted state current.
      const chatId = getPeerId(update.peer.peer).toString();
      this.mutedChats.set(chatId, isMuted(update.notifySettings));
    }
  }

  /** Shared handler for new and edited messages (they carry the same payload). */
  private async handleIncoming(
    event: NewMessageEvent,
    emitter: vscode.EventEmitter<Message>
  ): Promise<void> {
    const message = event.message;
    const chatId = message.chatId?.toString();
    if (!chatId) {
      return;
    }
    this.messageCache.set(`${chatId}:${message.id}`, message);
    const msg = this.toMessage(chatId, message);
    if (!msg.outgoing) {
      msg.avatar = await this.avatarForSender(message);
    }
    msg.reply = this.buildReply(chatId, message);
    emitter.fire(msg);
  }

  private async resolveEntity(chatId: string): Promise<EntityLike | undefined> {
    const cached = this.entities.get(chatId);
    if (cached) {
      return cached;
    }
    try {
      const entity = await this.client!.getEntity(chatId);
      this.entities.set(chatId, entity);
      return entity;
    } catch {
      return undefined;
    }
  }

  private toMessage(chatId: string, m: Api.Message): Message {
    const outgoing = m.out ?? false;
    const file = documentInfo(m);
    const hasCaption = !!(m.message ?? "").trim();
    // A file chip carries the name, so a bare "📎 Файл" placeholder is dropped.
    const text = file && !hasCaption ? "" : messageText(m);
    // Entities only align when text is the raw message (not a media placeholder).
    const entities = text && text === m.message ? mapEntities(text, m.entities) : undefined;
    const senderId = m.senderId?.toString();
    // Cache the sender entity so their profile can be resolved on click.
    if (senderId && m.sender) {
      this.entities.set(senderId, m.sender);
    }
    return {
      id: String(m.id),
      chatId,
      author: outgoing ? vscode.l10n.t("You") : senderName(m),
      senderId: outgoing ? undefined : senderId,
      text,
      timestamp: (m.date ?? 0) * 1000,
      outgoing,
      hasImage: isImageMedia(m),
      mediaKind: mediaKind(m),
      file,
      entities,
      topicId: topicOf(m),
      edited: !!m.editDate,
      status: this.outgoingStatus(chatId, outgoing, m.id),
    };
  }

  /** Delivery status for an outgoing message: "sent" (✓) once on the server,
   *  "read" (✓✓) once the peer's read receipt covers it. Broadcast channels use
   *  view counts rather than read receipts, so they get no status. */
  private outgoingStatus(
    chatId: string,
    outgoing: boolean,
    messageId: number
  ): Message["status"] {
    if (!outgoing) {
      return undefined;
    }
    const entity = this.entities.get(chatId);
    if (entity instanceof Api.Channel && entity.broadcast) {
      return undefined;
    }
    const maxRead = this.readOutbox.get(chatId) ?? 0;
    return messageId <= maxRead ? "read" : "sent";
  }
}

/** Build the tg://login URL Telegram encodes into the QR code. */
function loginUrl(token: Buffer): string {
  return `tg://login?token=${token.toString("base64url")}`;
}

/** Localized copy for the Telegram QR sign-in panel. */
function telegramQrText(): QrLoginText {
  return {
    title: vscode.l10n.t("Sign in to Telegram"),
    heading: vscode.l10n.t("Sign in to Telegram with a QR code"),
    steps: [
      vscode.l10n.t("Open Telegram on your phone"),
      vscode.l10n.t(
        "Settings → Devices → {0}",
        "<b>" + vscode.l10n.t("Link Desktop Device") + "</b>"
      ),
      vscode.l10n.t("Point the camera at this QR code"),
    ],
    hint: vscode.l10n.t(
      "The code refreshes automatically. Keep this window open until you sign in."
    ),
  };
}

/** True when a message carries a downloadable image thumbnail. */
function isImageMedia(m: Api.Message): boolean {
  const media = m.media;
  if (media instanceof Api.MessageMediaPhoto) {
    return true;
  }
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document;
    const attrs = doc instanceof Api.Document ? doc.attributes : [];
    return attrs.some(
      (a) =>
        a instanceof Api.DocumentAttributeVideo ||
        a instanceof Api.DocumentAttributeAnimated ||
        a instanceof Api.DocumentAttributeSticker
    );
  }
  return false;
}

/** The forum topic id a message belongs to, if it is in a forum thread. */
function topicOf(m: Api.Message): string | undefined {
  const r = m.replyTo;
  if (r instanceof Api.MessageReplyHeader && r.forumTopic) {
    const id = r.replyToTopId ?? r.replyToMsgId;
    return id ? String(id) : undefined;
  }
  return undefined;
}

/** Classify a message's media so the UI can badge and open it correctly. */
function mediaKind(m: Api.Message): Message["mediaKind"] {
  const media = m.media;
  if (media instanceof Api.MessageMediaPhoto) {
    return "photo";
  }
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document;
    const attrs = doc instanceof Api.Document ? doc.attributes : [];
    if (attrs.some((a) => a instanceof Api.DocumentAttributeSticker)) {
      return "sticker";
    }
    if (attrs.some((a) => a instanceof Api.DocumentAttributeAnimated)) {
      return "gif";
    }
    if (attrs.some((a) => a instanceof Api.DocumentAttributeVideo)) {
      return "video";
    }
  }
  return undefined;
}

/** A downloadable document (file/audio/voice) — not shown as an inline image.
 *  Video/gif/sticker are excluded: those render as thumbnails, not file chips. */
function documentInfo(m: Api.Message): { name: string; size?: number } | undefined {
  const media = m.media;
  if (!(media instanceof Api.MessageMediaDocument)) {
    return undefined;
  }
  const doc = media.document;
  if (!(doc instanceof Api.Document)) {
    return undefined;
  }
  const attrs = doc.attributes;
  const inline = attrs.some(
    (a) =>
      a instanceof Api.DocumentAttributeVideo ||
      a instanceof Api.DocumentAttributeAnimated ||
      a instanceof Api.DocumentAttributeSticker
  );
  if (inline) {
    return undefined;
  }
  const size = doc.size !== undefined ? Number(doc.size.toString()) : undefined;
  return { name: documentName(attrs), size };
}

/** Pick a filename for a document: its own name, or a synthesized one. */
function documentName(attrs: Api.TypeDocumentAttribute[]): string {
  const named = attrs.find(
    (a): a is Api.DocumentAttributeFilename =>
      a instanceof Api.DocumentAttributeFilename
  );
  if (named?.fileName) {
    return named.fileName;
  }
  const audio = attrs.find(
    (a): a is Api.DocumentAttributeAudio => a instanceof Api.DocumentAttributeAudio
  );
  if (audio?.voice) {
    return vscode.l10n.t("Voice message.ogg");
  }
  if (audio) {
    const title = [audio.performer, audio.title].filter(Boolean).join(" - ");
    return `${title || vscode.l10n.t("Audio")}.mp3`;
  }
  return vscode.l10n.t("File");
}

/** A human-readable last-seen / online line for a user's status. */
function userStatusText(status?: Api.TypeUserStatus): string | undefined {
  if (status instanceof Api.UserStatusOnline) {
    return vscode.l10n.t("online");
  }
  if (status instanceof Api.UserStatusOffline) {
    const when = new Date(status.wasOnline * 1000).toLocaleString(vscode.env.language);
    return vscode.l10n.t("last seen {0}", when);
  }
  if (status instanceof Api.UserStatusRecently) {
    return vscode.l10n.t("last seen recently");
  }
  if (status instanceof Api.UserStatusLastWeek) {
    return vscode.l10n.t("last seen within a week");
  }
  if (status instanceof Api.UserStatusLastMonth) {
    return vscode.l10n.t("last seen within a month");
  }
  return undefined;
}

/** The invite link string from an exported chat invite, if any. */
function inviteLinkOf(invite?: Api.TypeExportedChatInvite): string | undefined {
  return invite instanceof Api.ChatInviteExported ? invite.link : undefined;
}

/** A member/subscriber count line for a group or channel. */
function membersText(count: number | undefined, broadcast: boolean): string | undefined {
  if (count === undefined) {
    return undefined;
  }
  return broadcast
    ? vscode.l10n.t("{0} subscribers", count)
    : vscode.l10n.t("{0} members", count);
}

/** Folder titles are TextWithEntities in recent layers; fall back to a plain string. */
function folderTitle(title: Api.TypeTextWithEntities | string): string {
  if (typeof title === "string") {
    return title;
  }
  return title?.text || vscode.l10n.t("Folder");
}

/** A short single-line snippet of a message, for reply previews. */
function replySnippet(m: Api.Message): string {
  const text = messageText(m).replace(/\s+/g, " ").trim();
  if (text) {
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  }
  return mediaLabel(m) ?? vscode.l10n.t("Attachment");
}

/** Display text for a message: caption if present, else a media placeholder.
 *  Returns the raw caption (untrimmed) so formatting entity offsets stay aligned. */
function messageText(m: Api.Message): string {
  const raw = m.message ?? "";
  if (raw.trim()) {
    return raw;
  }
  // Images are shown as thumbnails, so they need no text placeholder.
  if (isImageMedia(m)) {
    return "";
  }
  return mediaLabel(m) ?? "";
}

/** A short labelled placeholder for a media message that has no caption. */
function mediaLabel(m: Api.Message): string | undefined {
  const media = m.media;
  if (!media) {
    return undefined;
  }
  if (media instanceof Api.MessageMediaPhoto) {
    return vscode.l10n.t("🖼 Photo");
  }
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document;
    const attrs = doc instanceof Api.Document ? doc.attributes : [];
    if (attrs.some((a) => a instanceof Api.DocumentAttributeSticker)) {
      return vscode.l10n.t("🖼 Sticker");
    }
    if (attrs.some((a) => a instanceof Api.DocumentAttributeAudio && a.voice)) {
      return vscode.l10n.t("🎤 Voice message");
    }
    if (attrs.some((a) => a instanceof Api.DocumentAttributeAudio)) {
      return vscode.l10n.t("🎵 Audio");
    }
    if (attrs.some((a) => a instanceof Api.DocumentAttributeAnimated)) {
      return vscode.l10n.t("🎬 GIF");
    }
    if (attrs.some((a) => a instanceof Api.DocumentAttributeVideo)) {
      return vscode.l10n.t("🎥 Video");
    }
    return vscode.l10n.t("📎 File");
  }
  if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive) {
    return vscode.l10n.t("📍 Location");
  }
  if (media instanceof Api.MessageMediaContact) {
    return vscode.l10n.t("👤 Contact");
  }
  if (media instanceof Api.MessageMediaPoll) {
    return vscode.l10n.t("📊 Poll");
  }
  return vscode.l10n.t("📎 Attachment");
}

/** Display title for an entity (user full name / chat or channel title). */
function entityTitle(e?: EntityLike): string {
  if (e instanceof Api.User) {
    return (
      [e.firstName, e.lastName].filter(Boolean).join(" ").trim() ||
      e.username ||
      "—"
    );
  }
  if (e instanceof Api.Channel || e instanceof Api.Chat) {
    return e.title;
  }
  return "—";
}

function senderName(m: Api.Message): string {
  const sender = m.sender as
    | { firstName?: string; lastName?: string; title?: string; username?: string }
    | undefined;
  if (!sender) {
    return "—";
  }
  const fullName = [sender.firstName, sender.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return fullName || sender.title || sender.username || "—";
}

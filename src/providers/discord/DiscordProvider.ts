import * as vscode from "vscode";
import type { Client } from "discord.js-selfbot-youtsuho-v13";
import type {
  Chat,
  Folder,
  MediaFile,
  Message,
  Messenger,
  Profile,
  Topic,
} from "../types";
import { DiscordStorage } from "./storage";
import {
  toMessage,
  guildFolderId,
  attachmentInfo,
  extFromMime,
  channelMuted,
  DiscordMessageLike,
  GuildSettingsLike,
} from "./helpers";
import { QrLoginPanel, QrLoginText } from "../../ui/QrLoginPanel";

/** Guild channel types we surface as chats (text-ish); voice/categories skipped. */
const SUPPORTED_GUILD_TYPES = new Set(["GUILD_TEXT", "GUILD_NEWS", "GUILD_FORUM"]);

/** A text-ish guild channel the current user can actually view. */
function isVisibleGuildChannel(ch: { type: string; viewable?: boolean }): boolean {
  return SUPPORTED_GUILD_TYPES.has(ch.type) && ch.viewable !== false;
}

/* Narrow structural views of the discord.js channel/guild objects, so the
 * provider reads them without wrestling the library's channel-union types.
 * Real objects are cast in via `as unknown as …`. */
interface MessagesLike {
  fetch(query?: {
    limit?: number;
    before?: string;
    after?: string;
    around?: string;
  }): Promise<{ values(): Iterable<unknown> }>;
  /** In-channel search (guild endpoint for server channels, channel endpoint for
   *  DMs). Present on real channels; optional so the mock/narrow view is happy. */
  search?(options: {
    content?: string;
    has?: string[];
    limit?: number;
    channels?: string[];
    sortBy?: string;
    sortOrder?: string;
  }): Promise<{ messages: { values(): Iterable<unknown> } }>;
}
interface ThreadLike {
  id: string;
  name: string;
  archived?: boolean;
  locked?: boolean;
}
interface ChannelLike {
  id: string;
  type: string;
  name?: string | null;
  /** Set on guild channels/threads (their parent guild); absent on DMs. Drives
   *  whether search uses the guild-scoped endpoint. */
  guildId?: string | null;
  /** Guild channels: whether the current user can view it (false → skip/hide). */
  viewable?: boolean;
  recipient?: { globalName?: string | null; username: string; displayAvatarURL(): string };
  guild?: { iconURL(): string | null };
  messages?: MessagesLike;
  threads?: { fetchActive(): Promise<{ threads: { values(): Iterable<ThreadLike> } }> };
  send?(options: unknown): Promise<unknown>;
}
interface GuildLike {
  id: string;
  name: string;
  channels: { cache: { values(): Iterable<ChannelLike> } };
  /** Per-user notification settings (mute), read-only. See ADR-021. */
  settings?: GuildSettingsLike;
}
/** A message attachment as we cache it for lazy media loading. */
interface RawAttachment {
  url: string;
  proxyURL?: string;
  contentType?: string | null;
  name?: string | null;
  size?: number;
}
/** User fields we read for a profile card. */
interface ProfileUserLike {
  username: string;
  globalName?: string | null;
  discriminator?: string;
  bio?: string | null;
  displayAvatarURL?(o?: { size?: number }): string;
}
/** Channel fields we read for a profile card. */
interface ProfileChannelLike {
  type: string;
  name?: string | null;
  topic?: string | null;
  recipient?: ProfileUserLike;
  recipients?: { size?: number };
  iconURL?(o?: { size?: number }): string | null;
  guild?: {
    name?: string;
    memberCount?: number;
    iconURL?(o?: { size?: number }): string | null;
  };
}
/** A message's author/member, for resolving the per-message avatar. */
interface RawAuthorLike {
  author?: { id?: string; displayAvatarURL?(o?: { size?: number }): string };
  member?: { displayAvatarURL?(o?: { size?: number }): string } | null;
}
/** The bits of a raw message we read directly (attachment url isn't exposed to
 *  the pure mapper). */
interface RawMessageLike {
  id?: string;
  attachments?: { first(): RawAttachment | undefined };
  messageSnapshots?: {
    first(): { attachments?: { first(): RawAttachment | undefined } } | undefined;
  };
}

type DiscordLib = typeof import("discord.js-selfbot-youtsuho-v13");
let cachedLib: DiscordLib | undefined;

/** Lazy-load the library, swallowing the ASCII banner it unconditionally prints
 *  to the console on first require (there's no option to disable it). Lazy so an
 *  account that never uses Discord doesn't pay the load. */
function loadDiscord(): DiscordLib {
  if (!cachedLib) {
    const log = console.log;
    console.log = () => undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- lazy load to suppress the banner and defer the heavy import
      cachedLib = require("discord.js-selfbot-youtsuho-v13") as DiscordLib;
    } finally {
      console.log = log;
    }
  }
  return cachedLib;
}

/**
 * Discord provider — a user-account ("self-bot") client over
 * discord.js-selfbot-youtsuho-v13, signed in by QR remote-auth. Mirrors the
 * WhatsAppProvider shape (event-driven, BETA, own caches).
 *
 * Phase 2 (this file): auth lifecycle — QR sign-in, token in SecretStorage,
 * reconnect on startup. Reading (Phase 3), realtime (Phase 4), sending (Phase 5)
 * and media (Phase 6) are stubs, filled in next.
 *
 * ⚠️ Automating a user account is against Discord's Terms of Service and can get
 * the account banned — accepted consciously (like WhatsApp/Baileys), hence BETA.
 */
export class DiscordProvider implements Messenger {
  readonly id = "discord";
  readonly name = "Discord";
  readonly beta = true;
  readonly historyPageSize = 50;
  readonly maxMessageLength = 2000;
  // DMs go in a "Direct Messages" folder and each server in its own, so the
  // tree needs no catch-all "All chats" node.
  readonly groupsOnly = true;

  private client?: Client;
  private open = false;

  /** Stable numeric folder ids per guild snowflake (see guildFolderId). */
  private readonly guildIds = new Map<string, number>();
  /** Avatar data-URL cache by chat id (includes misses, so they aren't refetched). */
  private readonly avatars = new Map<string, string | undefined>();
  /** Ids of messages we sent ourselves, to swallow their realtime echo (Phase 5). */
  private readonly sentIds = new Set<string>();
  /** Live unread count per chat — incremented on incoming, cleared on open.
   *  Client-side only (Discord's read state isn't synced back); starts empty
   *  each session, so it tracks messages seen while running, not historical. */
  private readonly unreadCounts = new Map<string, number>();
  /** Attachment (CDN url) per message id, for lazy media loading. Filled when
   *  messages are mapped; Discord attachment urls are directly fetchable. */
  private readonly mediaCache = new Map<string, RawAttachment>();
  /** Per-author avatar (data URL) by user id — so group/server messages show
   *  each sender's picture. Cached (incl. misses) to avoid refetching. */
  private readonly authorAvatars = new Map<string, string | undefined>();

  private readonly _onMessage = new vscode.EventEmitter<Message>();
  readonly onMessage = this._onMessage.event;
  private readonly _onMessageEdited = new vscode.EventEmitter<Message>();
  readonly onMessageEdited = this._onMessageEdited.event;
  private readonly _onMessagesDeleted = new vscode.EventEmitter<{
    chatId?: string;
    ids: string[];
  }>();
  readonly onMessagesDeleted = this._onMessagesDeleted.event;
  private readonly _onConnectionChange = new vscode.EventEmitter<boolean>();
  readonly onConnectionChange = this._onConnectionChange.event;

  constructor(private readonly storage: DiscordStorage) {}

  get connected(): boolean {
    return this.open;
  }

  // --- Lifecycle ---

  /** Reconnect a saved token on startup (silent no-op if not signed in). */
  async init(): Promise<void> {
    const token = await this.storage.getToken();
    if (!token) {
      return;
    }
    const client = this.buildClient();
    try {
      await client.login(token);
    } catch {
      // Token expired or revoked — forget it and stay signed out.
      client.destroy();
      this.client = undefined;
      await this.storage.clearToken();
    }
  }

  /** Interactive QR sign-in: render Discord's remote-auth QR, and on success
   *  persist the token and log the client in. */
  async login(): Promise<void> {
    if (this.open) {
      return;
    }
    const { DiscordAuthWebsocket } = loadDiscord();
    const qr = new QrLoginPanel(discordQrText());
    const client = this.buildClient();
    const auth = new DiscordAuthWebsocket();
    let token = "";
    auth.on("ready", () => void qr.render(auth.AuthURL));
    auth.on("finish", (t: string) => {
      token = t;
    });
    try {
      // connect(client) resolves after the QR is approved and the client logs
      // in; qr.onCancel rejects (AuthCancelled) if the user closes the panel.
      await Promise.race([auth.connect(client), qr.onCancel]);
    } catch (err) {
      auth.destroy();
      client.destroy();
      this.client = undefined;
      throw err;
    } finally {
      qr.close();
    }
    if (token) {
      await this.storage.setToken(token);
    }
  }

  async logout(): Promise<void> {
    this.client?.destroy();
    this.client = undefined;
    this.open = false;
    this.avatars.clear();
    this.guildIds.clear();
    this.sentIds.clear();
    this.unreadCounts.clear();
    this.mediaCache.clear();
    this.authorAvatars.clear();
    await this.storage.clearToken();
    this._onConnectionChange.fire(false);
  }

  dispose(): void {
    this.client?.destroy();
    this._onMessage.dispose();
    this._onMessageEdited.dispose();
    this._onMessagesDeleted.dispose();
    this._onConnectionChange.dispose();
  }

  /** Create a client and wire its lifecycle events. */
  private buildClient(): Client {
    const { Client } = loadDiscord();
    const client = new Client();
    this.client = client;
    this.bindEvents(client);
    return client;
  }

  private bindEvents(client: Client): void {
    client.on("ready", () => {
      if (this.client !== client) {
        return; // a newer client superseded this one
      }
      this.open = true;
      this._onConnectionChange.fire(true);
    });
    // Token revoked (e.g. password change / logged out elsewhere).
    client.on("invalidated", () => {
      if (this.client !== client) {
        return;
      }
      this.open = false;
      this.client = undefined;
      void this.storage.clearToken();
      this._onConnectionChange.fire(false);
    });
    // Swallow gateway/shard errors so an unhandled EventEmitter "error" can't
    // take down the extension host (this is an unofficial, best-effort library).
    client.on("error", (err) =>
      console.warn("[Yapper/Discord] client error:", (err as Error)?.message)
    );
    client.on("shardError", (err) =>
      console.warn("[Yapper/Discord] shard error:", (err as Error)?.message)
    );

    // --- Realtime ---
    client.on("messageCreate", async (m) => {
      if (this.client !== client) {
        return;
      }
      const raw = m as unknown as { id?: string };
      if (raw.id && this.sentIds.has(raw.id)) {
        this.sentIds.delete(raw.id); // our own send — already shown optimistically
        return;
      }
      const msg = this.mapRealtime(m);
      if (msg) {
        await this.applyAuthorAvatars([m], [msg]);
        if (!msg.outgoing) {
          // Bump unread; if the user is viewing this chat, markAsRead clears it.
          this.unreadCounts.set(msg.chatId, (this.unreadCounts.get(msg.chatId) ?? 0) + 1);
        }
        this._onMessage.fire(msg);
      }
    });
    client.on("messageUpdate", (_old, m) => {
      if (this.client !== client || !m) {
        return;
      }
      const msg = this.mapRealtime(m);
      if (msg) {
        this._onMessageEdited.fire(msg);
      }
    });
    client.on("messageDelete", (m) => {
      if (this.client !== client) {
        return;
      }
      const d = m as unknown as { id?: string; channelId?: string };
      if (d.id) {
        this._onMessagesDeleted.fire({ chatId: d.channelId, ids: [d.id] });
      }
    });
    client.on("messageDeleteBulk", (coll) => {
      if (this.client !== client) {
        return;
      }
      const c = coll as unknown as {
        values(): Iterable<{ id?: string; channelId?: string }>;
      };
      const arr = [...c.values()];
      const ids = arr.map((x) => x.id).filter((v): v is string => !!v);
      if (ids.length) {
        this._onMessagesDeleted.fire({ chatId: arr[0]?.channelId, ids });
      }
    });
  }

  /** Map a realtime message, resolving thread messages to (parent, topic). */
  private mapRealtime(m: unknown): Message | undefined {
    try {
      const msg = toMessage(m as unknown as DiscordMessageLike, this.client?.user?.id);
      this.cacheAttachment(m);
      const raw = m as unknown as {
        channel?: { isThread?(): boolean; parentId?: string | null };
      };
      if (raw.channel?.isThread?.() && raw.channel.parentId) {
        msg.topicId = msg.chatId;
        msg.chatId = raw.channel.parentId;
      }
      return msg;
    } catch {
      return undefined;
    }
  }

  // --- Data ---

  async getChats(): Promise<Chat[]> {
    const client = this.client;
    if (!client) {
      return [];
    }
    const chats: Chat[] = [];
    const channels = client.channels.cache as unknown as {
      values(): Iterable<ChannelLike>;
    };
    for (const ch of channels.values()) {
      if (ch.type === "DM" || ch.type === "GROUP_DM") {
        chats.push(this.dmChat(ch));
      }
    }
    const guilds = client.guilds.cache as unknown as {
      values(): Iterable<GuildLike>;
    };
    const now = Date.now();
    for (const g of guilds.values()) {
      for (const ch of g.channels.cache.values()) {
        if (isVisibleGuildChannel(ch)) {
          chats.push(this.guildChat(ch, channelMuted(g.settings, ch.id, now)));
        }
      }
    }
    return chats;
  }

  /** One folder per guild, holding that guild's (loaded) channels. DMs stay
   *  ungrouped — the tree surfaces them under its synthesized "All chats". */
  async getFolders(chats: Chat[]): Promise<Folder[]> {
    const client = this.client;
    if (!client) {
      return [];
    }
    const known = new Set(chats.map((c) => c.id));
    const folders: Folder[] = [];

    // Direct Messages (DMs + group DMs) as their own folder, separate from servers.
    const channels = client.channels.cache as unknown as {
      values(): Iterable<ChannelLike>;
    };
    const dmIds: string[] = [];
    for (const ch of channels.values()) {
      if ((ch.type === "DM" || ch.type === "GROUP_DM") && known.has(ch.id)) {
        dmIds.push(ch.id);
      }
    }
    if (dmIds.length) {
      folders.push({ id: 1, title: vscode.l10n.t("Direct Messages"), chatIds: dmIds });
    }

    const guilds = client.guilds.cache as unknown as {
      values(): Iterable<GuildLike>;
    };
    for (const g of guilds.values()) {
      const chatIds: string[] = [];
      for (const ch of g.channels.cache.values()) {
        if (isVisibleGuildChannel(ch) && known.has(ch.id)) {
          chatIds.push(ch.id);
        }
      }
      if (chatIds.length) {
        folders.push({ id: guildFolderId(g.id, this.guildIds), title: g.name, chatIds });
      }
    }
    return folders;
  }

  async getTopics(chatId: string): Promise<Topic[]> {
    const ch = await this.resolveChannel(chatId);
    if (!ch?.threads) {
      return [];
    }
    const active = await ch.threads.fetchActive().catch(() => undefined);
    if (!active) {
      return [];
    }
    return [...active.threads.values()].map((t) => ({
      id: t.id,
      title: t.name,
      closed: t.locked || t.archived || undefined,
    }));
  }

  async getMessages(chatId: string, topicId?: string): Promise<Message[]> {
    return this.fetchPage(chatId, topicId, {});
  }

  async getMessagesBefore(
    chatId: string,
    beforeMessageId: string,
    topicId?: string
  ): Promise<Message[]> {
    return this.fetchPage(chatId, topicId, { before: beforeMessageId });
  }

  async getMessagesAfter(
    chatId: string,
    afterMessageId: string,
    topicId?: string
  ): Promise<Message[]> {
    return this.fetchPage(chatId, topicId, { after: afterMessageId });
  }

  async getMessagesAround(
    chatId: string,
    messageId: string,
    topicId?: string
  ): Promise<Message[]> {
    return this.fetchPage(chatId, topicId, { around: messageId });
  }

  /** Search messages within a chat (or a forum thread), newest first. Uses
   *  Discord's channel search: the guild endpoint scoped to this channel for
   *  server channels, the channel endpoint for DMs. */
  async searchMessages(
    chatId: string,
    query: string,
    topicId?: string
  ): Promise<Message[]> {
    const targetId = topicId ?? chatId;
    const target = await this.resolveChannel(targetId);
    if (!target?.messages?.search) {
      return [];
    }
    let found: { messages: { values(): Iterable<unknown> } };
    try {
      found = await target.messages.search({
        content: query,
        // Discord caps message search at 25 per page.
        limit: 25,
        // Scope a server search to this channel; DM search is already channel-scoped.
        ...(target.guildId ? { channels: [targetId] } : {}),
        sortBy: "timestamp",
        sortOrder: "desc",
      });
    } catch (err) {
      // e.g. Missing Access, or search unavailable — show no results (but log,
      // so a real API error isn't indistinguishable from "no matches").
      console.warn("[Yapper/Discord] searchMessages failed:", (err as Error)?.message);
      return [];
    }
    const { msgs, raws } = this.mapSearchHits(
      found,
      targetId,
      chatId,
      topicId,
      !!target.guildId
    );
    await this.applyAuthorAvatars(raws, msgs);
    msgs.sort((a, b) => b.timestamp - a.timestamp);
    return msgs;
  }

  /** Shared media of a chat/thread, newest first: "media" = photos+videos,
   *  "files" = documents. Built on the same channel search with a `has` filter
   *  (image/video are separate searches — Discord ANDs multiple `has` values). */
  async getSharedMedia(
    chatId: string,
    kind: "media" | "files",
    topicId?: string
  ): Promise<Message[]> {
    const targetId = topicId ?? chatId;
    const target = await this.resolveChannel(targetId);
    if (!target?.messages?.search) {
      return [];
    }
    const search = target.messages.search.bind(target.messages);
    const isGuild = !!target.guildId;
    const scope = isGuild ? { channels: [targetId] } : {};
    const hasSets = kind === "files" ? [["file"]] : [["image"], ["video"]];
    const pages = await Promise.all(
      hasSets.map((has) =>
        search({ has, limit: 25, ...scope, sortBy: "timestamp", sortOrder: "desc" }).catch(
          (err) => {
            console.warn(
              "[Yapper/Discord] getSharedMedia failed:",
              (err as Error)?.message
            );
            return undefined;
          }
        )
      )
    );
    const byId = new Map<string, Message>();
    for (const found of pages) {
      if (!found) {
        continue;
      }
      const { msgs } = this.mapSearchHits(found, targetId, chatId, topicId, isGuild);
      for (const m of msgs) {
        // `has=file` returns every attachment (images included); keep only the
        // kind this tab wants (mapping sets `hasImage` vs `file` per attachment).
        if (kind === "files" ? !!m.file : !!m.hasImage) {
          byId.set(m.id, m);
        }
      }
    }
    return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Map a channel-search result collection into messages: applies the guild
   *  channel-scope safety filter (a guild search can echo other channels' hits
   *  if the library dropped the channel filter; DM search is single-channel and
   *  may omit channelId, so never filter it), remaps thread hits to
   *  (chat, topic), and caches attachments for lazy media. */
  private mapSearchHits(
    found: { messages: { values(): Iterable<unknown> } },
    targetId: string,
    chatId: string,
    topicId: string | undefined,
    isGuild: boolean
  ): { msgs: Message[]; raws: unknown[] } {
    const me = this.client?.user?.id;
    const msgs: Message[] = [];
    const raws: unknown[] = [];
    for (const raw of found.messages.values()) {
      const rc = (raw as { channelId?: string }).channelId;
      if (isGuild && rc && rc !== targetId) {
        continue;
      }
      try {
        const msg = toMessage(raw as unknown as DiscordMessageLike, me);
        if (topicId) {
          msg.chatId = chatId;
          msg.topicId = topicId;
        }
        this.cacheAttachment(raw);
        raws.push(raw);
        msgs.push(msg);
      } catch {
        // One malformed hit shouldn't drop the whole result set.
      }
    }
    return { msgs, raws };
  }

  async getAvatar(chatId: string): Promise<string | undefined> {
    if (this.avatars.has(chatId)) {
      return this.avatars.get(chatId);
    }
    const ch = await this.resolveChannel(chatId);
    const url = ch?.recipient
      ? ch.recipient.displayAvatarURL()
      : ch?.guild?.iconURL() ?? undefined;
    const data = url ? await fetchAsDataUrl(url) : undefined;
    this.avatars.set(chatId, data);
    return data;
  }

  /** Profile card for a DM (the recipient), group DM, guild channel, or a
   *  sender (a user id, e.g. clicking an author in a server channel). */
  async getProfile(id: string): Promise<Profile | undefined> {
    const client = this.client;
    if (!client) {
      return undefined;
    }
    const cached = client.channels.cache.get(id);
    const ch = (cached ??
      (await client.channels.fetch(id).catch(() => null))) as unknown as
      | ProfileChannelLike
      | null;

    if (ch?.type === "DM" && ch.recipient) {
      return this.userProfile(ch.recipient);
    }
    if (ch?.type === "GROUP_DM") {
      return {
        kind: "group",
        title: ch.name || vscode.l10n.t("Group chat"),
        subtitle: memberSubtitle(ch.recipients?.size),
        avatar: await toDataUrl(ch.iconURL?.({ size: 256 })),
      };
    }
    if (ch?.guild) {
      return {
        kind: "channel",
        title: "#" + (ch.name ?? ""),
        bio: ch.topic || undefined,
        subtitle:
          [ch.guild.name, memberSubtitle(ch.guild.memberCount)]
            .filter(Boolean)
            .join(" · ") || undefined,
        avatar: await toDataUrl(ch.guild.iconURL?.({ size: 256 })),
      };
    }
    const user = (await client.users.fetch(id).catch(() => undefined)) as unknown as
      | ProfileUserLike
      | undefined;
    return user ? this.userProfile(user) : undefined;
  }

  private async userProfile(u: ProfileUserLike): Promise<Profile> {
    // The webview prepends "@" itself, so store the bare handle.
    const handle =
      u.discriminator && u.discriminator !== "0"
        ? `${u.username}#${u.discriminator}`
        : u.username;
    return {
      kind: "user",
      title: u.globalName || u.username,
      username: handle,
      bio: u.bio || undefined,
      avatar: await toDataUrl(u.displayAvatarURL?.({ size: 256 })),
    };
  }

  /** A lightweight image preview (resized via Discord's media proxy). Video/
   *  other kinds have no cheap thumbnail — the UI shows a play badge instead. */
  async getMedia(_chatId: string, messageId: string): Promise<string | undefined> {
    const ref = this.mediaCache.get(messageId);
    if (!ref || !(ref.contentType ?? "").startsWith("image/")) {
      return undefined;
    }
    const base = ref.proxyURL || ref.url;
    const sep = base.includes("?") ? "&" : "?";
    return fetchAsDataUrl(`${base}${sep}width=400`);
  }

  /** Download the full attachment for the lightbox / a file save. */
  async getMediaFile(
    _chatId: string,
    messageId: string
  ): Promise<MediaFile | undefined> {
    const ref = this.mediaCache.get(messageId);
    if (!ref) {
      return undefined;
    }
    try {
      const res = await fetch(ref.url);
      if (!res.ok) {
        return undefined;
      }
      const data = new Uint8Array(await res.arrayBuffer());
      const mime = ref.contentType ?? res.headers.get("content-type") ?? "application/octet-stream";
      const info = attachmentInfo(ref);
      const kind: MediaFile["kind"] = info.hasImage
        ? info.mediaKind === "video" || info.mediaKind === "gif"
          ? "video"
          : "image"
        : "file";
      const extension = ref.name?.split(".").pop()?.toLowerCase() || extFromMime(mime);
      const filename = ref.name || `file.${extension}`;
      return { data, filename, extension, mime, kind };
    } catch {
      return undefined;
    }
  }

  // --- Sending ---

  async sendMessage(
    chatId: string,
    text: string,
    replyToId?: string,
    topicId?: string
  ): Promise<Message> {
    return this.send(chatId, topicId, {
      content: text,
      ...(replyToId
        ? { reply: { messageReference: replyToId, failIfNotExists: false } }
        : {}),
    });
  }

  async sendCode(
    chatId: string,
    text: string,
    language?: string,
    topicId?: string
  ): Promise<Message> {
    // Fenced code block; the returned message maps back through toMessage, which
    // parses the fence into a `pre` entity (the webview renders a code block).
    const fenced = "```" + (language ?? "") + "\n" + text + "\n```";
    return this.send(chatId, topicId, { content: fenced });
  }

  async sendFile(
    chatId: string,
    filePath: string,
    filename?: string,
    topicId?: string
  ): Promise<Message> {
    return this.send(chatId, topicId, {
      files: [{ attachment: filePath, name: filename }],
    });
  }

  async sendImage(
    chatId: string,
    filePath: string,
    caption?: string,
    topicId?: string
  ): Promise<Message> {
    return this.send(chatId, topicId, {
      ...(caption ? { content: caption } : {}),
      files: [{ attachment: filePath }],
    });
  }

  /** Resolve the target channel/thread, send, and map the created message
   *  (recording its id so its realtime echo is swallowed). */
  private async send(
    chatId: string,
    topicId: string | undefined,
    payload: unknown
  ): Promise<Message> {
    const target = await this.resolveChannel(topicId ?? chatId);
    if (!target?.send) {
      throw new Error(vscode.l10n.t("Not connected to Discord"));
    }
    let sent: unknown;
    try {
      sent = await target.send(payload);
    } catch (err) {
      // Discord CAPTCHA-gates sends from self-bots (especially new devices).
      // Surface an actionable message instead of the raw solver error.
      if (/CAPTCHA/i.test((err as Error)?.message ?? "")) {
        throw new Error(
          vscode.l10n.t(
            "Discord asked for a CAPTCHA to send from here. Send one message from the official Discord app first to trust this device, then try again."
          )
        );
      }
      throw err;
    }
    const s = sent as { id?: string };
    if (s.id) {
      this.sentIds.add(s.id);
    }
    const msg = toMessage(sent as DiscordMessageLike, this.client?.user?.id);
    if (topicId) {
      msg.chatId = chatId;
      msg.topicId = topicId;
    }
    return msg;
  }

  /** Clear a chat's unread (opening/viewing it). Client-side only — Discord has
   *  no `acknowledge` in this library, so read state isn't synced back. */
  async markAsRead(chatId: string): Promise<void> {
    this.unreadCounts.delete(chatId);
  }

  /** Whether a chat is muted, read live from Discord's notification settings
   *  (set in the official app). Guild channels only — DMs aren't covered, since
   *  Discord doesn't sync their mute state to this library. See ADR-021.
   *  Synchronous (reads the channel cache), as the Messenger interface requires. */
  isChatMuted(chatId: string): boolean {
    const ch = this.client?.channels.cache.get(chatId) as unknown as
      | { guild?: { settings?: GuildSettingsLike } }
      | undefined;
    return channelMuted(ch?.guild?.settings, chatId, Date.now());
  }

  // --- internals ---

  private dmChat(ch: ChannelLike): Chat {
    const isGroup = ch.type === "GROUP_DM";
    const title = isGroup
      ? ch.name || vscode.l10n.t("Group chat")
      : ch.recipient
      ? ch.recipient.globalName || ch.recipient.username
      : ch.id;
    return {
      id: ch.id,
      title,
      unreadCount: this.unreadCounts.get(ch.id),
      icon: isGroup ? "organization" : "account",
    };
  }

  private guildChat(ch: ChannelLike, muted: boolean): Chat {
    const isForum = ch.type === "GUILD_FORUM";
    return {
      id: ch.id,
      title: ch.name || ch.id,
      isForum: isForum || undefined,
      unreadCount: this.unreadCounts.get(ch.id),
      // Text/news channels get Discord's "#" glyph; forums stay expandable.
      icon: isForum ? undefined : "symbol-number",
      muted: muted || undefined,
    };
  }

  private async fetchPage(
    chatId: string,
    topicId: string | undefined,
    query: { before?: string; after?: string; around?: string }
  ): Promise<Message[]> {
    const target = await this.resolveChannel(topicId ?? chatId);
    if (!target?.messages) {
      return [];
    }
    let coll: { values(): Iterable<unknown> } | undefined;
    try {
      coll = await target.messages.fetch({ limit: this.historyPageSize, ...query });
    } catch {
      // e.g. Missing Access (50001) on a channel we can't read — show it empty.
      return [];
    }
    if (!coll) {
      return [];
    }
    const me = this.client?.user?.id;
    const raws = [...coll.values()];
    const msgs: Message[] = [];
    for (const raw of raws) {
      try {
        const msg = toMessage(raw as unknown as DiscordMessageLike, me);
        if (topicId) {
          // In a thread, discord's channelId is the thread id — keep the parent
          // as the chat and the thread as the topic.
          msg.chatId = chatId;
          msg.topicId = topicId;
        }
        this.cacheAttachment(raw);
        msgs.push(msg);
      } catch {
        // One malformed message shouldn't drop the whole page.
      }
    }
    await this.applyAuthorAvatars(raws, msgs);
    // Discord returns newest-first; the UI wants oldest-first.
    msgs.sort((a, b) => a.timestamp - b.timestamp);
    return msgs;
  }

  /** Remember a message's first attachment (own, or a forward's) so getMedia /
   *  getMediaFile can fetch it later by message id. */
  private cacheAttachment(raw: unknown): void {
    const m = raw as RawMessageLike;
    if (!m.id) {
      return;
    }
    const att =
      m.attachments?.first() ?? m.messageSnapshots?.first()?.attachments?.first();
    if (att?.url) {
      this.mediaCache.set(m.id, att);
    }
  }

  /** Fetch each message author's avatar (deduped, cached) and set it on the
   *  mapped messages, so group/server chats show real sender pictures. */
  private async applyAuthorAvatars(raws: unknown[], msgs: Message[]): Promise<void> {
    const toFetch = new Map<string, string>();
    for (const raw of raws) {
      const r = raw as RawAuthorLike;
      const id = r.author?.id;
      if (!id || this.authorAvatars.has(id) || toFetch.has(id)) {
        continue;
      }
      const url =
        r.member?.displayAvatarURL?.({ size: 64 }) ??
        r.author?.displayAvatarURL?.({ size: 64 });
      if (url) {
        toFetch.set(id, url);
      } else {
        this.authorAvatars.set(id, undefined);
      }
    }
    await Promise.all(
      [...toFetch].map(async ([id, url]) => {
        this.authorAvatars.set(id, await fetchAsDataUrl(url));
      })
    );
    for (const msg of msgs) {
      if (msg.senderId && !msg.avatar) {
        const avatar = this.authorAvatars.get(msg.senderId);
        if (avatar) {
          msg.avatar = avatar;
        }
      }
    }
  }

  private async resolveChannel(id: string): Promise<ChannelLike | undefined> {
    const client = this.client;
    if (!client) {
      return undefined;
    }
    const cached = client.channels.cache.get(id);
    if (cached) {
      return cached as unknown as ChannelLike;
    }
    const fetched = await client.channels.fetch(id).catch(() => null);
    return (fetched ?? undefined) as unknown as ChannelLike | undefined;
  }
}

/** Fetch an (optional) URL as a data URL — for profile avatars/icons. */
async function toDataUrl(url?: string | null): Promise<string | undefined> {
  return url ? fetchAsDataUrl(url) : undefined;
}

/** Localized "N members" subtitle, or undefined when unknown. */
function memberSubtitle(count?: number): string | undefined {
  return count ? vscode.l10n.t("{0} members", count) : undefined;
}

/** Fetch a URL and return it as a base64 data URL (for avatars/media), or
 *  undefined on failure. */
async function fetchAsDataUrl(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return undefined;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get("content-type") ?? "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** Localized copy for the QR sign-in panel. */
function discordQrText(): QrLoginText {
  return {
    title: vscode.l10n.t("Sign in to Discord"),
    heading: vscode.l10n.t("Sign in to Discord with a QR code"),
    steps: [
      vscode.l10n.t("Open Discord on your phone"),
      vscode.l10n.t("Settings → <b>Scan QR Code</b>"),
      vscode.l10n.t("Point the camera at this QR code"),
    ],
    hint: vscode.l10n.t(
      "The code refreshes automatically. Keep this window open until you sign in."
    ),
  };
}

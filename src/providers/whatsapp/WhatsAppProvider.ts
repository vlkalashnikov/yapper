import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import type {
  Contact,
  WAMessage,
  WAMessageKey,
  WASocket,
} from "@whiskeysockets/baileys";
import { Chat, MediaFile, Message, Messenger } from "../types";
import { QrLoginPanel, QrLoginText } from "../../ui/QrLoginPanel";
import { AuthCancelled } from "../../util/AuthCancelled";
import {
  chatTitle,
  extFromMime,
  extOf,
  isGroupJid,
  isRenderable,
  isSupportedJid,
  mapStatus,
  mimeOf,
  muteActive,
  toMessage,
  toNum,
  unwrapContent,
} from "./helpers";

// Baileys logs verbosely via pino; a silent logger keeps the extension host clean.
const silentLogger = {
  level: "silent",
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

/** Normalized chat metadata, kept in our own persisted store. */
interface StoredChat {
  id: string;
  name?: string;
  unreadCount: number;
  /** Newest-activity time, ms. */
  ts: number;
  /** WhatsApp's mute-end time (0/absent = not muted, future = muted, <0 =
   *  forever). Read-only: honored for notification suppression. */
  mutedUntil?: number;
}

/** Normalized contact, for display-name resolution. */
interface StoredContact {
  id: string;
  name?: string;
  notify?: string;
  verifiedName?: string;
  /** Profile-picture URL delivered with the contact sync, if any. */
  imgUrl?: string;
}

/** Max messages persisted to disk per chat (bounds the store file). In memory a
 *  chat may hold more during a session as older history is paged in. */
const MESSAGE_CAP = 60;

/** Minimum gap between manual re-syncs (Refresh button), so rapid clicks don't
 *  hammer the connection — reconnecting too often risks WhatsApp throttling. */
const RESYNC_COOLDOWN_MS = 15_000;

/** Messages returned per pagination step (also the UI's history page size — a
 *  shorter page signals the end of history). */
const HISTORY_PAGE = 25;

/** Messages requested from the server per on-demand history sync. Larger than
 *  HISTORY_PAGE so the surplus is served locally on the next step and the
 *  end-of-history heuristic only trips when the server really has no more. */
const HISTORY_FETCH = 50;

/** How long to wait for an on-demand history sync to land before giving up. */
const HISTORY_SYNC_TIMEOUT_MS = 8000;

/** Cap on fetching a chat avatar. It's off the critical path (streamed into the
 *  header after load), so this is generous — 1:1 picture queries can be slow. */
const AVATAR_TIMEOUT_MS = 15_000;

/**
 * WhatsApp backend on Baileys (WebSocket, no browser). Data is event-driven:
 * chats/contacts/history arrive via events. WhatsApp only pushes the full chat
 * list once (at QR registration), so we persist a normalized store to disk and
 * reload it on reconnect — otherwise chats would vanish after a restart.
 * Text-only MVP.
 */
export class WhatsAppProvider implements Messenger {
  readonly id = "whatsapp";
  readonly name = "WhatsApp";
  readonly beta = true; // text-only MVP — tagged BETA in the UI
  readonly historyPageSize = HISTORY_PAGE;

  private sock?: WASocket;
  private open = false;
  private readonly chats = new Map<string, StoredChat>();
  private readonly contacts = new Map<string, StoredContact>();
  /** jid -> normalized messages, oldest-first. */
  private readonly messages = new Map<string, Message[]>();
  /** LID jid -> phone-number jid, so a contact addressed both ways (WhatsApp's
   *  LID migration) collapses to one canonical chat instead of duplicating. */
  private readonly lidToPn = new Map<string, string>();
  /** Ids we sent ourselves, to skip the realtime echo. */
  private readonly sentIds = new Set<string>();
  /** Raw media messages, by message id, so media can be downloaded lazily.
   *  In-memory only (media keys aren't persisted) — like Telegram's cache. */
  private readonly rawMessages = new Map<string, WAMessage>();
  /** Chat avatars as data URLs, by jid. Caches misses (undefined) too, so a
   *  chat without a picture isn't re-fetched every open. */
  private readonly avatars = new Map<string, string | undefined>();
  /** Pending on-demand history fetches: chatId -> resolver, released when the
   *  requested older messages arrive (or the request times out). */
  private readonly historyWaiters = new Map<
    string,
    { resolve: () => void; timer: NodeJS.Timeout }
  >();
  private readonly storeFile: string;
  private refreshTimer?: NodeJS.Timeout;
  private persistTimer?: NodeJS.Timeout;
  /** Debounce state for resync(): a reconnect in flight, and the last start. */
  private resyncing = false;
  private lastResyncAt = 0;

  private readonly _onMessage = new vscode.EventEmitter<Message>();
  readonly onMessage = this._onMessage.event;
  private readonly _onMessageEdited = new vscode.EventEmitter<Message>();
  readonly onMessageEdited = this._onMessageEdited.event;
  private readonly _onConnectionChange = new vscode.EventEmitter<boolean>();
  readonly onConnectionChange = this._onConnectionChange.event;

  constructor(private readonly authDir: string) {
    this.storeFile = path.join(authDir, "store.json");
    this.loadStore();
  }

  get connected(): boolean {
    return this.open;
  }

  /** Reconnect a saved session on startup (silent — no QR). No-op if none. */
  async init(): Promise<void> {
    if (!this.hasSession()) {
      return;
    }
    await this.openSocket(undefined).catch((err) => {
      console.error("[Yapper] WhatsApp init failed:", err);
    });
  }

  /** Force a re-sync by reconnecting the socket, which makes WhatsApp re-deliver
   *  messages that arrived while offline. Guarded against rapid Refresh clicks:
   *  skipped if signed out, already reconnecting, or within the cooldown. */
  async resync(): Promise<void> {
    if (!this.hasSession() || this.resyncing) {
      return;
    }
    const now = Date.now();
    if (now - this.lastResyncAt < RESYNC_COOLDOWN_MS) {
      return;
    }
    this.lastResyncAt = now;
    this.resyncing = true;
    try {
      await this.openSocket(undefined);
    } catch (err) {
      console.error("[Yapper] WhatsApp resync failed:", err);
    } finally {
      this.resyncing = false;
    }
  }

  /** Interactive QR sign-in: show the code, resolve once connected. */
  async login(): Promise<void> {
    if (this.open) {
      return; // already signed in — avoid spawning a competing socket
    }
    const qr = new QrLoginPanel(whatsappQrText());
    try {
      await this.openSocket(qr);
    } finally {
      qr.close();
    }
  }

  async logout(): Promise<void> {
    try {
      await this.sock?.logout();
    } catch {
      // already gone — fall through to clearing local state
    }
    this.sock?.end(undefined);
    this.sock = undefined;
    this.open = false;
    this.clearStore();
    this.clearSession();
    this._onConnectionChange.fire(false);
  }

  async getChats(): Promise<Chat[]> {
    const rows: Array<{ chat: Chat; ts: number }> = [];
    for (const [jid, c] of this.chats) {
      if (!isSupportedJid(jid)) {
        continue;
      }
      const msgs = this.messages.get(jid);
      const last = msgs && msgs.length ? msgs[msgs.length - 1] : undefined;
      const ts = Math.max(c.ts, last?.timestamp ?? 0);
      rows.push({
        chat: {
          id: jid,
          title: chatTitle(jid, c.name, this.contacts.get(jid)),
          lastMessage: last ? this.previewOf(last) || undefined : undefined,
          unreadCount: c.unreadCount,
          canSend: true,
          muted: muteActive(c.mutedUntil ?? 0, Date.now()),
        },
        ts,
      });
    }
    rows.sort((a, b) => b.ts - a.ts);
    return rows.map((r) => r.chat);
  }

  async getMessages(chatId: string): Promise<Message[]> {
    return this.withReceiptDefaults(chatId, [
      ...(this.messages.get(chatId) ?? []),
    ]);
  }

  /** Historical outgoing messages (persisted before receipts, or without a
   *  synced status) have no tick. In a 1:1 chat such a message was delivered,
   *  so default it to ✓✓ for display — the store is left untouched, and a live
   *  status update still takes precedence when one arrives. */
  private withReceiptDefaults(chatId: string, msgs: Message[]): Message[] {
    if (isGroupJid(chatId)) {
      return msgs;
    }
    return msgs.map((m) =>
      m.outgoing && !m.status ? { ...m, status: "read" } : m
    );
  }

  /** A page of messages older than `beforeMessageId`. Serves from the local
   *  store when it holds older messages; otherwise pulls a chunk of history
   *  from the server on demand and returns whatever lands. An empty result
   *  tells the UI we've reached the start of history. */
  async getMessagesBefore(
    chatId: string,
    beforeMessageId: string
  ): Promise<Message[]> {
    const arr = this.messages.get(chatId) ?? [];
    const idx = arr.findIndex((m) => m.id === beforeMessageId);
    if (idx > 0) {
      // Older messages are already cached (e.g. surplus from a prior fetch).
      return this.withReceiptDefaults(
        chatId,
        arr.slice(Math.max(0, idx - HISTORY_PAGE), idx)
      );
    }
    if (idx !== 0) {
      // Anchor isn't our oldest cached message — nothing reliable to page.
      return [];
    }
    return this.withReceiptDefaults(chatId, await this.fetchOlder(chatId, arr[0]));
  }

  async sendMessage(chatId: string, text: string): Promise<Message> {
    if (!this.sock) {
      throw new Error(vscode.l10n.t("Not connected to WhatsApp"));
    }
    const sent = await this.sock.sendMessage(chatId, { text });
    if (!sent) {
      throw new Error(vscode.l10n.t("Failed to send"));
    }
    if (sent.key.id) {
      this.sentIds.add(sent.key.id);
    }
    const msg = this.storeMessage(sent);
    // Reaching the server is at least "sent" — show the ✓ immediately (1:1 only)
    // rather than waiting for the first delivery event.
    if (msg && !isGroupJid(chatId) && !msg.status) {
      msg.status = "sent";
    }
    this.schedulePersist();
    return msg ?? toMessage(chatId, sent, this.mediaLabel());
  }

  /** Send a code block. WhatsApp monospace is triple-backtick, so we send that
   *  for the recipient, but store the raw code with a `pre` entity so our own
   *  webview renders a code block rather than literal backticks. */
  async sendCode(chatId: string, text: string, language?: string): Promise<Message> {
    if (!this.sock) {
      throw new Error(vscode.l10n.t("Not connected to WhatsApp"));
    }
    const sent = await this.sock.sendMessage(chatId, { text: "```" + text + "```" });
    if (!sent) {
      throw new Error(vscode.l10n.t("Failed to send"));
    }
    return this.recordOutgoing(chatId, sent, {
      text,
      entities: [{ type: "pre", offset: 0, length: text.length, language }],
    });
  }

  /** Send a local file as a document (upload from disk). */
  async sendFile(
    chatId: string,
    filePath: string,
    filename?: string
  ): Promise<Message> {
    if (!this.sock) {
      throw new Error(vscode.l10n.t("Not connected to WhatsApp"));
    }
    const data = fs.readFileSync(filePath);
    const name = filename ?? path.basename(filePath);
    const sent = await this.sock.sendMessage(chatId, {
      document: data,
      fileName: name,
      mimetype: mimeOf(name),
    });
    if (!sent) {
      throw new Error(vscode.l10n.t("Failed to send"));
    }
    return this.recordOutgoing(chatId, sent, {
      file: { name, size: data.length },
    });
  }

  /** Record a message we built ourselves (code block / document) into the store,
   *  suppress its realtime echo, and return it for the UI to append. */
  private recordOutgoing(
    chatId: string,
    sent: WAMessage,
    extra: Partial<Message>
  ): Message {
    if (sent.key.id) {
      this.sentIds.add(sent.key.id);
    }
    const canon = this.canonical(chatId);
    const msg = this.insertMessage({
      id: sent.key.id ?? "",
      chatId: canon,
      author: "",
      text: "",
      timestamp: toNum(sent.messageTimestamp) * 1000,
      outgoing: true,
      status: isGroupJid(canon) ? undefined : "sent",
      ...extra,
    });
    this.schedulePersist();
    return msg;
  }

  /** A message's inline thumbnail as a data URL (lazy, called by the UI for
   *  messages with hasImage). Uses the embedded jpegThumbnail; stickers have
   *  none, so the (small) full sticker is downloaded instead. */
  async getMedia(_chatId: string, messageId: string): Promise<string | undefined> {
    const raw = this.rawMessages.get(messageId);
    const c = raw && unwrapContent(raw.message);
    if (!raw || !c) {
      return undefined;
    }
    const thumb =
      c.imageMessage?.jpegThumbnail ??
      c.videoMessage?.jpegThumbnail ??
      c.documentMessage?.jpegThumbnail;
    if (thumb && thumb.length) {
      return "data:image/jpeg;base64," + Buffer.from(thumb).toString("base64");
    }
    if (c.stickerMessage) {
      const data = await this.download(raw);
      if (data) {
        const mime = c.stickerMessage.mimetype || "image/webp";
        return `data:${mime};base64,` + Buffer.from(data).toString("base64");
      }
    }
    return undefined;
  }

  /** Download a message's full media for opening in a viewer or saving. */
  async getMediaFile(
    _chatId: string,
    messageId: string
  ): Promise<MediaFile | undefined> {
    const raw = this.rawMessages.get(messageId);
    const c = raw && unwrapContent(raw.message);
    if (!raw || !c) {
      return undefined;
    }
    const data = await this.download(raw);
    if (!data) {
      return undefined;
    }
    const make = (
      mime: string,
      fallbackExt: string,
      kind: MediaFile["kind"],
      filename?: string
    ): MediaFile => {
      const ext = (filename && extOf(filename)) || extFromMime(mime) || fallbackExt;
      return { data, filename: filename || `file.${ext}`, extension: ext, mime, kind };
    };
    if (c.imageMessage) {
      return make(c.imageMessage.mimetype || "image/jpeg", "jpg", "image");
    }
    if (c.videoMessage) {
      return make(c.videoMessage.mimetype || "video/mp4", "mp4", "video");
    }
    if (c.stickerMessage) {
      return make(c.stickerMessage.mimetype || "image/webp", "webp", "image", "sticker.webp");
    }
    if (c.documentMessage) {
      const d = c.documentMessage;
      return make(d.mimetype || "application/octet-stream", "bin", "file", d.fileName || undefined);
    }
    if (c.audioMessage) {
      const ext = extFromMime(c.audioMessage.mimetype || "audio/ogg") || "ogg";
      return make(
        c.audioMessage.mimetype || "audio/ogg",
        "ogg",
        "file",
        `${c.audioMessage.ptt ? "voice" : "audio"}.${ext}`
      );
    }
    return undefined;
  }

  /** Download a raw media message to a Buffer, re-uploading if its URL expired. */
  private async download(raw: WAMessage): Promise<Buffer | undefined> {
    if (!this.sock) {
      return undefined;
    }
    const sock = this.sock;
    try {
      return await downloadMediaMessage(raw, "buffer", {}, {
        // Bound wrapper: passing the bare method loses `this`, so re-uploading an
        // expired-URL media (common after a re-login / history sync) would throw.
        reuploadRequest: (msg) => sock.updateMediaMessage(msg),
        logger: silentLogger as never,
      });
    } catch (err) {
      console.error("[Yapper] WhatsApp media download failed:", err);
      return undefined;
    }
  }

  /** The chat's profile picture as a data URL (for the conversation header), or
   *  undefined if it has none. Prefers the picture URL delivered with the contact
   *  sync (reliable); otherwise queries profilePictureUrl, which is flaky for 1:1
   *  chats (frequent timeouts / item-not-found). The result — including a miss —
   *  is cached so a flaky photo isn't re-queried on every open; a fresh contact
   *  imgUrl clears the cache (see storeContact) so it re-resolves. */
  async getAvatar(chatId: string): Promise<string | undefined> {
    const jid = this.canonical(chatId);
    if (this.avatars.has(jid)) {
      return this.avatars.get(jid);
    }
    let url = this.contacts.get(jid)?.imgUrl;
    if (!url) {
      // Not connected yet (opened during startup/reconnect): retry later,
      // without caching a miss that would blank the avatar for the session.
      if (!this.sock || !this.open) {
        return undefined;
      }
      try {
        url =
          (await this.sock.profilePictureUrl(jid, "preview", AVATAR_TIMEOUT_MS)) ??
          undefined;
      } catch {
        this.avatars.set(jid, undefined); // timeout / not found — no picture
        return undefined;
      }
    }
    let dataUrl: string | undefined;
    if (url) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
        });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          const mime = res.headers.get("content-type") || "image/jpeg";
          dataUrl = `data:${mime};base64,` + buf.toString("base64");
        }
      } catch {
        // fetch failed/timed out — cache the miss below.
      }
    }
    this.avatars.set(jid, dataUrl);
    return dataUrl;
  }

  /** Resolve a clicked @mention (a phone number in WhatsApp) to its 1:1 chat,
   *  so the UI can open it. Returns the stored chat if we have one, else a
   *  minimal chat for the number's jid. */
  async resolveChat(query: string): Promise<Chat | undefined> {
    const digits = query.replace(/\D/g, "");
    if (!digits) {
      return undefined;
    }
    const jid = this.canonical(`${digits}@s.whatsapp.net`);
    const stored = this.chats.get(jid);
    return {
      id: jid,
      title: chatTitle(jid, stored?.name, this.contacts.get(jid)),
      canSend: true,
    };
  }

  /** One-line chat-list preview: text, else a localized media/file label. */
  private previewOf(m: Message): string {
    if (m.text) {
      return m.text;
    }
    if (m.file) {
      return `📎 ${m.file.name}`;
    }
    switch (m.mediaKind) {
      case "photo":
        return vscode.l10n.t("🖼 Photo");
      case "video":
      case "gif":
        return vscode.l10n.t("🎥 Video");
      case "sticker":
        return vscode.l10n.t("🖼 Sticker");
      default:
        return "";
    }
  }

  isChatMuted(chatId: string): boolean {
    const c = this.chats.get(this.canonical(chatId));
    return c ? muteActive(c.mutedUntil ?? 0, Date.now()) : false;
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    for (const jid of [...this.historyWaiters.keys()]) {
      this.resolveHistory(jid);
    }
    this.persistNow();
    this.sock?.end(undefined);
    this._onMessage.dispose();
    this._onMessageEdited.dispose();
    this._onConnectionChange.dispose();
  }

  // --- internals ---

  /** Open a socket and wire events. With a QR panel, resolves once connected
   *  and rejects on cancel/failure; without one (reconnect), resolves at once
   *  and keeps the connection live in the background. */
  private async openSocket(qr?: QrLoginPanel): Promise<void> {
    // Never run two connections at once (a second socket causes QR conflicts /
    // "invalid link" / connectionReplaced). Tear down any existing socket first.
    this.sock?.end(undefined);
    this.sock = undefined;

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const sock = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu("Yapper"),
      syncFullHistory: false,
      logger: silentLogger as never,
    });
    this.sock = sock;
    sock.ev.on("creds.update", () => void saveCreds());
    this.bindDataEvents(sock);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      sock.ev.on("connection.update", (u) => {
        if (this.sock !== sock) {
          return; // superseded by a newer socket — ignore stale events
        }
        if (u.qr && qr) {
          void qr.render(u.qr);
        }
        if (u.connection === "open") {
          this.open = true;
          this._onConnectionChange.fire(true);
          settle(resolve);
        } else if (u.connection === "close") {
          this.open = false;
          this._onConnectionChange.fire(false);
          const code = (
            u.lastDisconnect?.error as
              | { output?: { statusCode?: number } }
              | undefined
          )?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) {
            this.clearSession();
            settle(() =>
              reject(new Error(vscode.l10n.t("Signed out of WhatsApp")))
            );
          } else if (code === DisconnectReason.restartRequired) {
            // Expected right after QR pairing: Baileys asks for a restart to
            // actually come online. Reconnect (no QR — creds are saved now) and
            // treat sign-in as done.
            void this.openSocket(undefined).catch((err) =>
              console.error("[Yapper] WhatsApp restart failed:", err)
            );
            settle(resolve);
          } else if (settled) {
            // An established connection dropped — reconnect in the background.
            void this.openSocket(undefined).catch((err) =>
              console.error("[Yapper] WhatsApp reconnect failed:", err)
            );
          } else {
            settle(() =>
              reject(new Error(vscode.l10n.t("WhatsApp connection failed")))
            );
          }
        }
      });

      if (qr) {
        qr.onCancel.catch(() =>
          settle(() => {
            this.sock?.end(undefined);
            reject(new AuthCancelled());
          })
        );
      } else {
        // Background reconnect: don't block the caller on the socket opening.
        settle(resolve);
      }
    });
  }

  /** Populate the store from history and realtime events. */
  private bindDataEvents(sock: WASocket): void {
    // Ignore events from a socket that has been superseded by a newer one.
    const stale = (): boolean => this.sock !== sock;

    sock.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
      if (stale()) {
        return;
      }
      for (const c of chats) {
        this.storeChat(c);
      }
      for (const ct of contacts) {
        this.storeContact(ct);
      }
      // Track which chats gained messages so pending on-demand fetches (which
      // request older history via `messaging-history.set`) can be released.
      const touched = new Set<string>();
      for (const m of messages) {
        const stored = this.storeMessage(m);
        if (stored) {
          touched.add(stored.chatId);
        }
      }
      this.schedulePersist();
      this.scheduleRefresh();
      for (const jid of touched) {
        this.resolveHistory(jid);
      }
    });

    sock.ev.on("chats.upsert", (chats) => {
      if (stale()) {
        return;
      }
      for (const c of chats) {
        this.storeChat(c);
      }
      this.schedulePersist();
      this.scheduleRefresh();
    });

    sock.ev.on("chats.update", (updates) => {
      if (stale()) {
        return;
      }
      for (const u of updates) {
        this.storeChat(u);
      }
      this.schedulePersist();
      this.scheduleRefresh();
    });

    sock.ev.on("contacts.upsert", (contacts) => {
      if (stale()) {
        return;
      }
      for (const ct of contacts) {
        this.storeContact(ct);
      }
      this.schedulePersist();
      this.scheduleRefresh();
    });

    sock.ev.on("lid-mapping.update", (m) => {
      if (stale()) {
        return;
      }
      this.learnMapping(m.lid, m.pn);
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (stale()) {
        return;
      }
      let changed = false;
      const touched = new Set<string>();
      for (const m of messages) {
        const jid = m.key.remoteJid;
        if (!jid || !isSupportedJid(jid)) {
          continue;
        }
        const msg = this.storeMessage(m);
        if (!msg) {
          continue;
        }
        changed = true;
        touched.add(msg.chatId);
        // Fire only for realtime ("notify") messages, and skip our own echoes.
        if (type === "notify" && !(m.key.id && this.sentIds.has(m.key.id))) {
          this._onMessage.fire(msg);
        }
      }
      if (changed) {
        this.schedulePersist();
      }
      // On-demand history may arrive here (non-realtime) rather than via
      // `messaging-history.set` — release any pending page fetch for those chats.
      if (type !== "notify") {
        for (const jid of touched) {
          this.resolveHistory(jid);
        }
      }
    });

    // Read receipts arrive two ways: an aggregate delivery status on
    // `messages.update` (SERVER_ACK/DELIVERY_ACK/READ), and per-peer receipts on
    // `message-receipt.update` (read/played timestamps) — which is how 1:1 reads
    // usually come. Both advance the tick ✓ → ✓✓ via applyStatus.
    sock.ev.on("messages.update", (updates) => {
      if (stale()) {
        return;
      }
      let changed = false;
      for (const { key, update } of updates) {
        const next = mapStatus(update.status);
        if (next && this.applyStatus(key, next)) {
          changed = true;
        }
      }
      if (changed) {
        this.schedulePersist();
      }
    });

    sock.ev.on("message-receipt.update", (updates) => {
      if (stale()) {
        return;
      }
      // Any per-peer receipt (delivered or read) means the message reached the
      // recipient → ✓✓, matching the delivery-based tick used above.
      let changed = false;
      for (const { key, receipt } of updates) {
        const reached =
          toNum(receipt.readTimestamp) > 0 ||
          toNum(receipt.playedTimestamp) > 0 ||
          toNum(receipt.receiptTimestamp) > 0 ||
          (receipt.deliveredDeviceJid?.length ?? 0) > 0;
        if (reached && this.applyStatus(key, "read")) {
          changed = true;
        }
      }
      if (changed) {
        this.schedulePersist();
      }
    });
  }

  /** Advance a stored outgoing message's read-receipt state and re-emit it so
   *  the UI updates the tick. 1:1 only (mirrors Telegram); forward-only
   *  (undefined → sent → read, never downgraded). Returns true if it changed.
   *  Keys off the stored message being outgoing rather than `key.fromMe`, which
   *  isn't reliably set on `message-receipt.update` keys. */
  private applyStatus(key: WAMessageKey, next: "sent" | "read"): boolean {
    const jid = key.remoteJid;
    if (!jid || !isSupportedJid(jid) || isGroupJid(jid)) {
      return false;
    }
    const arr = this.messages.get(this.canonical(jid));
    const msg = key.id ? arr?.find((x) => x.id === key.id) : undefined;
    if (!msg || !msg.outgoing || next === msg.status || msg.status === "read") {
      return false;
    }
    msg.status = next;
    this._onMessageEdited.fire({ ...msg });
    return true;
  }

  // --- LID ↔ phone-number canonicalization (dedupes chats) ---

  /** The canonical key for a jid: a phone-number jid when we know the LID's
   *  mapping, otherwise the jid unchanged. */
  private canonical(jid: string): string {
    return this.lidToPn.get(jid) ?? jid;
  }

  /** Record a LID→PN mapping and fold any already-split chat/messages together. */
  private learnMapping(lidRaw: string, pnRaw: string): void {
    const lid = lidRaw.includes("@") ? lidRaw : `${lidRaw}@lid`;
    const pn = pnRaw.includes("@") ? pnRaw : `${pnRaw}@s.whatsapp.net`;
    if (!lid.endsWith("@lid") || !pn.endsWith("@s.whatsapp.net")) {
      return;
    }
    if (this.lidToPn.get(lid) === pn) {
      return;
    }
    this.lidToPn.set(lid, pn);
    this.mergeAlias(lid, pn);
    this.schedulePersist();
    this.scheduleRefresh();
  }

  /** Merge an aliased LID chat (and its messages/contact) into the PN chat. */
  private mergeAlias(lid: string, pn: string): void {
    const lidChat = this.chats.get(lid);
    if (lidChat) {
      const pnChat = this.chats.get(pn);
      this.chats.set(pn, {
        id: pn,
        name: pnChat?.name ?? lidChat.name,
        unreadCount: Math.max(pnChat?.unreadCount ?? 0, lidChat.unreadCount),
        ts: Math.max(pnChat?.ts ?? 0, lidChat.ts),
        mutedUntil: pnChat?.mutedUntil ?? lidChat.mutedUntil,
      });
      this.chats.delete(lid);
    }

    const lidMsgs = this.messages.get(lid);
    if (lidMsgs) {
      const seen = new Set<string>();
      const out: Message[] = [];
      for (const m of [...(this.messages.get(pn) ?? []), ...lidMsgs]) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          out.push({ ...m, chatId: pn });
        }
      }
      out.sort((a, b) => a.timestamp - b.timestamp);
      this.messages.set(pn, out);
      this.messages.delete(lid);
    }

    const lidContact = this.contacts.get(lid);
    if (lidContact && !this.contacts.has(pn)) {
      this.contacts.set(pn, { ...lidContact, id: pn });
    }
    this.contacts.delete(lid);
  }

  /** Upsert a chat into the store (merging partial updates from
   *  history.set / chats.upsert / chats.update). */
  private storeChat(c: {
    id?: string | null;
    name?: string | null;
    unreadCount?: number | null;
    conversationTimestamp?: number | { toNumber(): number } | null;
    muteEndTime?: number | { toNumber(): number } | null;
  }): void {
    if (!c.id) {
      return;
    }
    const id = this.canonical(c.id);
    const prev = this.chats.get(id);
    this.chats.set(id, {
      id,
      name: c.name ?? prev?.name,
      unreadCount: c.unreadCount ?? prev?.unreadCount ?? 0,
      ts:
        c.conversationTimestamp !== null && c.conversationTimestamp !== undefined
          ? toNum(c.conversationTimestamp) * 1000
          : prev?.ts ?? 0,
      // Partial updates may omit muteEndTime — preserve the previous value then.
      mutedUntil:
        c.muteEndTime !== null && c.muteEndTime !== undefined
          ? toNum(c.muteEndTime)
          : prev?.mutedUntil,
    });
  }

  private storeContact(ct: Contact): void {
    if (ct.lid && ct.phoneNumber) {
      this.learnMapping(ct.lid, ct.phoneNumber);
    }
    if (ct.id.endsWith("@lid") && ct.phoneNumber) {
      this.learnMapping(ct.id, ct.phoneNumber);
    }
    const id = this.canonical(ct.id);
    const prev = this.contacts.get(id);
    // imgUrl: a real URL is the picture; "changed"/null/absent means unknown, so
    // keep whatever we had. A fresh URL invalidates the cached avatar.
    const imgUrl =
      ct.imgUrl && ct.imgUrl !== "changed" ? ct.imgUrl : prev?.imgUrl;
    if (imgUrl && imgUrl !== prev?.imgUrl) {
      this.avatars.delete(id);
    }
    this.contacts.set(id, {
      id,
      name: ct.name ?? undefined,
      notify: ct.notify ?? undefined,
      verifiedName: ct.verifiedName ?? undefined,
      imgUrl,
    });
  }

  /** Map + insert a message (oldest-first, deduped). Returns the mapped
   *  message, or null when it's not a supported/renderable chat message. */
  private storeMessage(m: WAMessage): Message | null {
    const jid = m.key.remoteJid;
    if (!jid || !isSupportedJid(jid) || !isRenderable(m)) {
      return null;
    }
    const msg = toMessage(this.canonical(jid), m, this.mediaLabel());
    // Keep the raw message so its media can be downloaded lazily.
    if (msg.id && (msg.hasImage || msg.file)) {
      this.rawMessages.set(msg.id, m);
    }
    return this.insertMessage(msg);
  }

  /** Insert an already-mapped message into its chat (oldest-first, deduped by
   *  id). No in-memory cap: paged-in history must survive here (the cap is
   *  applied only when persisting to disk). */
  private insertMessage(msg: Message): Message {
    const arr = this.messages.get(msg.chatId) ?? [];
    if (arr.some((x) => x.id === msg.id)) {
      return msg;
    }
    arr.push(msg);
    arr.sort((a, b) => a.timestamp - b.timestamp);
    this.messages.set(msg.chatId, arr);
    return msg;
  }

  // --- on-demand history (pagination) ---

  /** Request a chunk of history older than `oldest` from the server and return
   *  the messages that land (older than the anchor, newest-first-capped to a
   *  page). Returns [] if disconnected, on error, or if nothing arrives. */
  private async fetchOlder(chatId: string, oldest: Message): Promise<Message[]> {
    if (!this.sock || !this.open) {
      return [];
    }
    const key: WAMessageKey = {
      remoteJid: chatId,
      id: oldest.id,
      fromMe: oldest.outgoing,
      participant: oldest.senderId,
    };
    const landed = this.waitForHistory(chatId);
    try {
      // Baileys timestamps are in seconds; our Message.timestamp is ms.
      await this.sock.fetchMessageHistory(
        HISTORY_FETCH,
        key,
        Math.floor(oldest.timestamp / 1000)
      );
    } catch (err) {
      console.error("[Yapper] WhatsApp fetchMessageHistory failed:", err);
      this.resolveHistory(chatId);
      return [];
    }
    await landed;
    // Return the messages now older than the anchor (a page's worth).
    const arr = this.messages.get(chatId) ?? [];
    const idx = arr.findIndex((m) => m.id === oldest.id);
    return idx > 0 ? arr.slice(Math.max(0, idx - HISTORY_PAGE), idx) : [];
  }

  /** A promise that resolves when an on-demand history chunk for `chatId` is
   *  stored, or after a timeout. Supersedes any pending waiter for the chat. */
  private waitForHistory(chatId: string): Promise<void> {
    this.resolveHistory(chatId);
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.historyWaiters.delete(chatId);
        resolve();
      }, HISTORY_SYNC_TIMEOUT_MS);
      this.historyWaiters.set(chatId, { resolve, timer });
    });
  }

  /** Release a pending history waiter for `chatId`, if any. */
  private resolveHistory(chatId: string): void {
    const w = this.historyWaiters.get(chatId);
    if (w) {
      clearTimeout(w.timer);
      this.historyWaiters.delete(chatId);
      w.resolve();
    }
  }

  /** Nudge the UI to re-read the chat list (debounced). The tree refreshes on
   *  connection changes, so re-emitting the current state triggers a rebuild
   *  without adding a bespoke "chats changed" event to the interface. */
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this._onConnectionChange.fire(this.open);
    }, 300);
  }

  private mediaLabel(): string {
    return vscode.l10n.t("[media]");
  }

  // --- persistence (chats survive restarts; WhatsApp resends history only once) ---

  private schedulePersist(): void {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, 1000);
  }

  private persistNow(): void {
    try {
      fs.mkdirSync(this.authDir, { recursive: true });
      // Persist only the newest MESSAGE_CAP messages per chat to bound the file;
      // older history paged in during the session is re-fetched on demand.
      const messages = Object.fromEntries(
        [...this.messages].map(([jid, msgs]) => [jid, msgs.slice(-MESSAGE_CAP)])
      );
      const data = {
        chats: [...this.chats.values()],
        contacts: [...this.contacts.values()],
        messages,
        lidToPn: [...this.lidToPn.entries()],
      };
      fs.writeFileSync(this.storeFile, JSON.stringify(data));
    } catch (err) {
      console.error("[Yapper] WhatsApp persist failed:", err);
    }
  }

  private loadStore(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.storeFile, "utf8"));
      for (const [lid, pn] of data.lidToPn ?? []) {
        this.lidToPn.set(lid, pn);
      }
      for (const c of data.chats ?? []) {
        this.chats.set(c.id, c);
      }
      for (const ct of data.contacts ?? []) {
        this.contacts.set(ct.id, ct);
      }
      for (const [jid, msgs] of Object.entries(data.messages ?? {})) {
        this.messages.set(jid, msgs as Message[]);
      }
    } catch {
      // no persisted store yet — first run
    }
  }

  private clearStore(): void {
    for (const jid of [...this.historyWaiters.keys()]) {
      this.resolveHistory(jid);
    }
    this.chats.clear();
    this.contacts.clear();
    this.messages.clear();
    this.lidToPn.clear();
    this.sentIds.clear();
    this.rawMessages.clear();
    this.avatars.clear();
  }

  /** Whether a saved auth session exists on disk. */
  private hasSession(): boolean {
    try {
      return fs.existsSync(path.join(this.authDir, "creds.json"));
    } catch {
      return false;
    }
  }

  /** Delete the on-disk auth session + store (used on logout / server logout). */
  private clearSession(): void {
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    } catch (err) {
      console.error("[Yapper] WhatsApp clearSession failed:", err);
    }
  }
}

/** Localized copy for the WhatsApp QR sign-in panel. */
function whatsappQrText(): QrLoginText {
  return {
    title: vscode.l10n.t("Sign in to WhatsApp"),
    heading: vscode.l10n.t("Sign in to WhatsApp with a QR code"),
    steps: [
      vscode.l10n.t("Open WhatsApp on your phone"),
      vscode.l10n.t(
        "Settings → Linked Devices → {0}",
        "<b>" + vscode.l10n.t("Link a Device") + "</b>"
      ),
      vscode.l10n.t("Point the camera at this QR code"),
    ],
    hint: vscode.l10n.t(
      "The code refreshes automatically. Keep this window open until you sign in."
    ),
  };
}

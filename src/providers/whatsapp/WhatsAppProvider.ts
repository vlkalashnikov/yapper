import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import type {
  Contact,
  WAMessage,
  WASocket,
} from "@whiskeysockets/baileys";
import { Chat, Message, Messenger } from "../types";
import { QrLoginPanel, QrLoginText } from "../../ui/QrLoginPanel";
import { AuthCancelled } from "../../util/AuthCancelled";
import {
  chatTitle,
  isRenderable,
  isSupportedJid,
  toMessage,
  toNum,
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
}

/** Normalized contact, for display-name resolution. */
interface StoredContact {
  id: string;
  name?: string;
  notify?: string;
  verifiedName?: string;
}

/** Max messages kept (and persisted) per chat. */
const MESSAGE_CAP = 60;

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

  private sock?: WASocket;
  private open = false;
  private readonly chats = new Map<string, StoredChat>();
  private readonly contacts = new Map<string, StoredContact>();
  /** jid -> normalized messages, oldest-first. */
  private readonly messages = new Map<string, Message[]>();
  /** Ids we sent ourselves, to skip the realtime echo. */
  private readonly sentIds = new Set<string>();
  private readonly storeFile: string;
  private refreshTimer?: NodeJS.Timeout;
  private persistTimer?: NodeJS.Timeout;

  private readonly _onMessage = new vscode.EventEmitter<Message>();
  readonly onMessage = this._onMessage.event;
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
          lastMessage: last?.text || undefined,
          unreadCount: c.unreadCount,
          canSend: true,
        },
        ts,
      });
    }
    rows.sort((a, b) => b.ts - a.ts);
    return rows.map((r) => r.chat);
  }

  async getMessages(chatId: string): Promise<Message[]> {
    return [...(this.messages.get(chatId) ?? [])];
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
    this.schedulePersist();
    return msg ?? toMessage(chatId, sent, this.mediaLabel());
  }

  isChatMuted(): boolean {
    return false; // mute state not tracked in the text-only MVP
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistNow();
    this.sock?.end(undefined);
    this._onMessage.dispose();
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
      for (const m of messages) {
        this.storeMessage(m);
      }
      this.schedulePersist();
      this.scheduleRefresh();
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

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (stale()) {
        return;
      }
      let changed = false;
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
        // Fire only for realtime ("notify") messages, and skip our own echoes.
        if (type === "notify" && !(m.key.id && this.sentIds.has(m.key.id))) {
          this._onMessage.fire(msg);
        }
      }
      if (changed) {
        this.schedulePersist();
      }
    });
  }

  /** Upsert a chat into the store (merging partial updates from
   *  history.set / chats.upsert / chats.update). */
  private storeChat(c: {
    id?: string | null;
    name?: string | null;
    unreadCount?: number | null;
    conversationTimestamp?: number | { toNumber(): number } | null;
  }): void {
    if (!c.id) {
      return;
    }
    const prev = this.chats.get(c.id);
    this.chats.set(c.id, {
      id: c.id,
      name: c.name ?? prev?.name,
      unreadCount: c.unreadCount ?? prev?.unreadCount ?? 0,
      ts:
        c.conversationTimestamp !== null && c.conversationTimestamp !== undefined
          ? toNum(c.conversationTimestamp) * 1000
          : prev?.ts ?? 0,
    });
  }

  private storeContact(ct: Contact): void {
    this.contacts.set(ct.id, {
      id: ct.id,
      name: ct.name ?? undefined,
      notify: ct.notify ?? undefined,
      verifiedName: ct.verifiedName ?? undefined,
    });
  }

  /** Map + insert a message (oldest-first, deduped, capped). Returns the mapped
   *  message, or null when it's not a supported/renderable chat message. */
  private storeMessage(m: WAMessage): Message | null {
    const jid = m.key.remoteJid;
    if (!jid || !isSupportedJid(jid) || !isRenderable(m)) {
      return null;
    }
    const msg = toMessage(jid, m, this.mediaLabel());
    const arr = this.messages.get(jid) ?? [];
    if (arr.some((x) => x.id === msg.id)) {
      return msg;
    }
    arr.push(msg);
    arr.sort((a, b) => a.timestamp - b.timestamp);
    if (arr.length > MESSAGE_CAP) {
      arr.splice(0, arr.length - MESSAGE_CAP);
    }
    this.messages.set(jid, arr);
    return msg;
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
      const data = {
        chats: [...this.chats.values()],
        contacts: [...this.contacts.values()],
        messages: Object.fromEntries(this.messages),
      };
      fs.writeFileSync(this.storeFile, JSON.stringify(data));
    } catch (err) {
      console.error("[Yapper] WhatsApp persist failed:", err);
    }
  }

  private loadStore(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.storeFile, "utf8"));
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
    this.chats.clear();
    this.contacts.clear();
    this.messages.clear();
    this.sentIds.clear();
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

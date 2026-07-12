import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import type {
  Chat as WAChat,
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
  messageText,
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

/**
 * WhatsApp backend on Baileys (WebSocket, no browser). Unlike Telegram, data is
 * event-driven: chats/contacts/history arrive via events into an in-memory
 * store, and getChats/getMessages answer from that store. Text-only MVP.
 */
export class WhatsAppProvider implements Messenger {
  readonly id = "whatsapp";
  readonly name = "WhatsApp";

  private sock?: WASocket;
  private open = false;
  /** jid -> chat metadata (from history + chats.upsert/update). */
  private readonly chatsById = new Map<string, WAChat>();
  /** jid -> contact (for display names). */
  private readonly contactsById = new Map<string, Contact>();
  /** jid -> messages, oldest-first (from history + realtime). */
  private readonly messagesByChat = new Map<string, WAMessage[]>();
  /** Ids we sent ourselves, to skip the realtime echo. */
  private readonly sentIds = new Set<string>();
  private refreshTimer?: NodeJS.Timeout;

  private readonly _onMessage = new vscode.EventEmitter<Message>();
  readonly onMessage = this._onMessage.event;
  private readonly _onConnectionChange = new vscode.EventEmitter<boolean>();
  readonly onConnectionChange = this._onConnectionChange.event;

  constructor(private readonly authDir: string) {}

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
    for (const [jid, wa] of this.chatsById) {
      if (!isSupportedJid(jid)) {
        continue;
      }
      const msgs = this.messagesByChat.get(jid);
      const last = msgs && msgs.length ? msgs[msgs.length - 1] : undefined;
      const ts = last
        ? toNum(last.messageTimestamp)
        : toNum(wa.conversationTimestamp);
      rows.push({
        chat: {
          id: jid,
          title: chatTitle(jid, wa.name ?? undefined, this.contactsById.get(jid)),
          lastMessage: last
            ? messageText(last) || this.mediaLabel()
            : undefined,
          unreadCount: wa.unreadCount ?? 0,
          canSend: true,
        },
        ts,
      });
    }
    rows.sort((a, b) => b.ts - a.ts);
    return rows.map((r) => r.chat);
  }

  async getMessages(chatId: string): Promise<Message[]> {
    const msgs = this.messagesByChat.get(chatId) ?? [];
    return msgs
      .filter(isRenderable)
      .map((m) => toMessage(chatId, m, this.mediaLabel()));
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
    this.storeMessage(sent);
    return toMessage(chatId, sent, this.mediaLabel());
  }

  isChatMuted(): boolean {
    return false; // mute state not tracked in the text-only MVP
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.sock?.end(undefined);
    this._onMessage.dispose();
    this._onConnectionChange.dispose();
  }

  // --- internals ---

  /** Open a socket and wire events. With a QR panel, resolves once connected
   *  and rejects on cancel/failure; without one (reconnect), resolves at once
   *  and keeps the connection live in the background. */
  private async openSocket(qr?: QrLoginPanel): Promise<void> {
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
    sock.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
      for (const c of chats) {
        if (c.id) {
          this.chatsById.set(c.id, c);
        }
      }
      for (const ct of contacts) {
        this.contactsById.set(ct.id, ct);
      }
      for (const m of messages) {
        this.storeMessage(m);
      }
      this.scheduleRefresh();
    });

    sock.ev.on("chats.upsert", (chats) => {
      for (const c of chats) {
        if (c.id) {
          this.chatsById.set(c.id, c);
        }
      }
      this.scheduleRefresh();
    });

    sock.ev.on("chats.update", (updates) => {
      for (const u of updates) {
        if (!u.id) {
          continue;
        }
        const prev = this.chatsById.get(u.id);
        this.chatsById.set(u.id, { ...prev, ...u } as WAChat);
      }
      this.scheduleRefresh();
    });

    sock.ev.on("contacts.upsert", (contacts) => {
      for (const ct of contacts) {
        this.contactsById.set(ct.id, ct);
      }
      this.scheduleRefresh();
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      for (const m of messages) {
        const jid = m.key.remoteJid;
        if (!jid || !isSupportedJid(jid)) {
          continue;
        }
        this.storeMessage(m);
        // Fire only for realtime ("notify") messages, and skip our own echoes.
        if (type === "notify" && !(m.key.id && this.sentIds.has(m.key.id))) {
          this._onMessage.fire(toMessage(jid, m, this.mediaLabel()));
        }
      }
    });
  }

  /** Insert a message into its chat's list (oldest-first, deduped by id). */
  private storeMessage(m: WAMessage): void {
    const jid = m.key.remoteJid;
    if (!jid) {
      return;
    }
    const arr = this.messagesByChat.get(jid) ?? [];
    if (arr.some((x) => x.key.id === m.key.id)) {
      return;
    }
    arr.push(m);
    arr.sort((a, b) => toNum(a.messageTimestamp) - toNum(b.messageTimestamp));
    this.messagesByChat.set(jid, arr);
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

  private clearStore(): void {
    this.chatsById.clear();
    this.contactsById.clear();
    this.messagesByChat.clear();
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

  /** Delete the on-disk auth session (used on logout / server logout). */
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

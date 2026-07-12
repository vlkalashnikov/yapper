/**
 * Pure WhatsApp mapping helpers — no `vscode`, no live socket. Baileys shapes
 * are imported type-only (elided at runtime), so this module and its tests load
 * without pulling in the Baileys runtime.
 */
import type { Contact, WAMessage } from "@whiskeysockets/baileys";
import { Message } from "../types";

/** protobuf Long | number | null → a plain number (0 when absent). */
export function toNum(
  v: number | Long | null | undefined
): number {
  if (v === null || v === undefined) {
    return 0;
  }
  return typeof v === "number" ? v : v.toNumber();
}

/** A minimal structural Long (protobufjs) for toNum, avoids importing long. */
interface Long {
  toNumber(): number;
}

/** Only user chats are shown — 1:1 (@s.whatsapp.net or the newer @lid
 *  addressing) and groups (@g.us); status broadcasts and newsletters skipped. */
export function isSupportedJid(jid: string): boolean {
  return (
    jid.endsWith("@s.whatsapp.net") ||
    jid.endsWith("@lid") ||
    jid.endsWith("@g.us")
  );
}

/** True for a group jid (…@g.us). */
export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

/** The user part of a jid, without the @domain or :device suffix. */
export function jidUser(jid: string): string {
  return jid.split("@")[0].split(":")[0];
}

/** Map WhatsApp's delivery status (WebMessageInfo.Status enum) to the model's
 *  two-state tick. WhatsApp shows ✓✓ already on delivery (and READ doesn't
 *  reliably reach a linked device), so: SERVER_ACK (2) → "sent" (✓);
 *  DELIVERY_ACK/READ/PLAYED (3/4/5) → "read" (✓✓); ERROR/PENDING (0/1) →
 *  undefined (no mark). */
export function mapStatus(
  status: number | null | undefined
): "sent" | "read" | undefined {
  if (status === null || status === undefined) {
    return undefined;
  }
  const s = Number(status);
  if (s >= 3) {
    return "read";
  }
  if (s === 2) {
    return "sent";
  }
  return undefined;
}

/** Plain text of a WhatsApp message, or "" if it carries none (media/other). */
export function messageText(m: WAMessage): string {
  const msg = m.message;
  if (!msg) {
    return "";
  }
  return msg.conversation ?? msg.extendedTextMessage?.text ?? "";
}

/** Whether a message has content worth rendering (text or a known media kind);
 *  filters out pure protocol messages (key exchanges, receipts, …). */
export function isRenderable(m: WAMessage): boolean {
  const msg = m.message;
  if (!msg) {
    return false;
  }
  if (messageText(m)) {
    return true;
  }
  return !!(
    msg.imageMessage ||
    msg.videoMessage ||
    msg.documentMessage ||
    msg.audioMessage ||
    msg.stickerMessage ||
    msg.contactMessage ||
    msg.locationMessage
  );
}

/** Display title for a chat: group subject / saved contact name / notify name /
 *  finally the bare jid user. */
export function chatTitle(
  jid: string,
  waName: string | undefined,
  contact: Contact | undefined
): string {
  return (
    waName ||
    contact?.name ||
    contact?.notify ||
    contact?.verifiedName ||
    jidUser(jid)
  );
}

/** Map a WhatsApp message into the provider-agnostic model. `mediaPlaceholder`
 *  (localized) is used as the text when the message has no plain text. */
export function toMessage(
  chatId: string,
  m: WAMessage,
  mediaPlaceholder: string
): Message {
  const outgoing = m.key.fromMe === true;
  const text = messageText(m);
  const senderId = m.key.participant ?? undefined;
  return {
    id: m.key.id ?? "",
    chatId,
    author: outgoing
      ? ""
      : m.pushName || jidUser(senderId ?? m.key.remoteJid ?? chatId),
    senderId: outgoing ? undefined : senderId,
    text: text || (m.message ? mediaPlaceholder : ""),
    timestamp: toNum(m.messageTimestamp) * 1000,
    outgoing,
    // Read receipts: only for our own messages in 1:1 chats (mirrors Telegram).
    status:
      outgoing && !isGroupJid(chatId) ? mapStatus(m.status) : undefined,
  };
}

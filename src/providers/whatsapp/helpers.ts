/**
 * Pure WhatsApp mapping helpers — no `vscode`, no live socket. Baileys shapes
 * are imported type-only (elided at runtime), so this module and its tests load
 * without pulling in the Baileys runtime.
 */
import type { Contact, WAMessage } from "@whiskeysockets/baileys";
import { Message, MessageEntity } from "../types";

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

/** Best-effort MIME type from a filename extension, for sending a document
 *  (Baileys requires a mimetype). Unknown types fall back to a generic
 *  downloadable file. Source/text files map to text/plain so they open inline. */
export function mimeOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  const ext = i > 0 ? filename.slice(i + 1).toLowerCase() : "";
  const map: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    xml: "application/xml",
    html: "text/html",
    css: "text/css",
    csv: "text/csv",
    js: "text/plain",
    ts: "text/plain",
    tsx: "text/plain",
    jsx: "text/plain",
    py: "text/plain",
    sh: "text/plain",
    yml: "text/plain",
    yaml: "text/plain",
    diff: "text/plain",
    patch: "text/plain",
    log: "text/plain",
    pdf: "application/pdf",
    zip: "application/zip",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
  };
  return map[ext] ?? "application/octet-stream";
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

/** Whether a chat's mute is currently active. WhatsApp's `muteEndTime` is 0 (or
 *  absent) when not muted, a future timestamp when muted, or negative for "muted
 *  forever". The timestamp may be in seconds or ms depending on the source, so
 *  it's normalized before comparing against `nowMs`. */
export function muteActive(muteEndTime: number, nowMs: number): boolean {
  if (!muteEndTime) {
    return false;
  }
  if (muteEndTime < 0) {
    return true;
  }
  const endMs = muteEndTime < 1e12 ? muteEndTime * 1000 : muteEndTime;
  return endMs > nowMs;
}

/** Peel WhatsApp's container messages down to the inner content, whose real
 *  payload is nested. Without this such messages look empty and get dropped —
 *  e.g. the other side's messages in a disappearing-messages chat
 *  (`ephemeralMessage`), view-once media, a document with caption, an edited
 *  message, or a message you sent from another device (`deviceSentMessage`). */
export function unwrapContent(
  message: WAMessage["message"]
): WAMessage["message"] {
  let m = message;
  for (let i = 0; i < 5 && m; i++) {
    const inner =
      m.ephemeralMessage?.message ??
      m.viewOnceMessage?.message ??
      m.viewOnceMessageV2?.message ??
      m.documentWithCaptionMessage?.message ??
      m.editedMessage?.message ??
      m.deviceSentMessage?.message;
    if (!inner) {
      break;
    }
    m = inner;
  }
  return m;
}

/** Whether a message was forwarded, from any content type's
 *  `contextInfo.isForwarded`. WhatsApp hides the original sender, so there's no
 *  origin name — just the flag. */
export function isForwarded(m: WAMessage): boolean {
  const content = unwrapContent(m.message);
  if (!content) {
    return false;
  }
  for (const v of Object.values(content)) {
    if (
      v &&
      typeof v === "object" &&
      (v as { contextInfo?: { isForwarded?: boolean } }).contextInfo?.isForwarded
    ) {
      return true;
    }
  }
  return false;
}

/** Plain text of a WhatsApp message, or "" if it carries none (media/other). */
export function messageText(m: WAMessage): string {
  const msg = unwrapContent(m.message);
  if (!msg) {
    return "";
  }
  return msg.conversation ?? msg.extendedTextMessage?.text ?? "";
}

/** Media descriptor of a message (unwrapped): how the UI should render it —
 *  an inline image/thumbnail (photo/video/gif/sticker) or a file chip
 *  (document/audio) — plus any caption. Empty object for plain text. */
export interface MediaInfo {
  hasImage?: boolean;
  mediaKind?: "photo" | "video" | "gif" | "sticker";
  file?: { name: string; size?: number };
  caption?: string;
}

export function mediaInfo(message: WAMessage["message"]): MediaInfo {
  const c = unwrapContent(message);
  if (!c) {
    return {};
  }
  if (c.imageMessage) {
    return { hasImage: true, mediaKind: "photo", caption: c.imageMessage.caption ?? undefined };
  }
  if (c.videoMessage) {
    return {
      hasImage: true,
      mediaKind: c.videoMessage.gifPlayback ? "gif" : "video",
      caption: c.videoMessage.caption ?? undefined,
    };
  }
  if (c.stickerMessage) {
    return { hasImage: true, mediaKind: "sticker" };
  }
  if (c.documentMessage) {
    const d = c.documentMessage;
    return {
      file: { name: d.fileName || "file", size: toNum(d.fileLength) || undefined },
      caption: d.caption ?? undefined,
    };
  }
  if (c.audioMessage) {
    const a = c.audioMessage;
    return {
      file: {
        name: a.ptt ? "Voice message.ogg" : "Audio",
        size: toNum(a.fileLength) || undefined,
      },
    };
  }
  return {};
}

/** Extension (without the dot) from a filename, or "" if it has none. */
export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1) : "";
}

/** A file extension (no dot) for a MIME type, or "" if it can't be derived. */
export function extFromMime(mime: string): string {
  const slash = mime.indexOf("/");
  if (slash < 0) {
    return "";
  }
  const sub = mime.slice(slash + 1).toLowerCase().replace(/^x-/, "");
  const map: Record<string, string> = {
    quicktime: "mov",
    matroska: "mkv",
    mpeg: "mp3",
    "mp4a-latm": "m4a",
    "vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  };
  const base = sub.replace(/[^a-z0-9].*$/, "");
  return map[sub] ?? map[base] ?? base;
}

/** Whether a message has content worth rendering (text or a known media kind);
 *  filters out pure protocol messages (key exchanges, receipts, …). */
export function isRenderable(m: WAMessage): boolean {
  const msg = unwrapContent(m.message);
  if (!msg) {
    return false;
  }
  if (msg.conversation || msg.extendedTextMessage?.text) {
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

/** WhatsApp marks monospace/code with triple backticks. Strip them and mark the
 *  spans so they render formatted (not as literal backticks): a whole-message
 *  wrap becomes a `pre` block (Share Code, code from another client); inline
 *  ```…``` fragments within a sentence become inline `code`. */
export function monospaceBlock(text: string): {
  text: string;
  entities?: MessageEntity[];
} {
  // Whole message wrapped (and no stray backticks inside) → a code block.
  const full = /^```\n?([\s\S]+?)\n?```$/.exec(text);
  if (full && full[1].length && !full[1].includes("```")) {
    return {
      text: full[1],
      entities: [{ type: "pre", offset: 0, length: full[1].length }],
    };
  }
  // Otherwise, inline ```…``` fragments → inline code (offsets in the stripped
  // text, UTF-16 units).
  const entities: MessageEntity[] = [];
  const re = /```([^`]+?)```/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out += text.slice(last, m.index);
    entities.push({ type: "code", offset: out.length, length: m[1].length });
    out += m[1];
    last = m.index + m[0].length;
  }
  out += text.slice(last);
  return entities.length ? { text: out, entities } : { text };
}

/** Map a WhatsApp message into the provider-agnostic model. `mediaPlaceholder`
 *  (localized) is a last-resort text for renderable content we don't recognize;
 *  known media instead surfaces via hasImage/mediaKind/file (+ its caption). */
export function toMessage(
  chatId: string,
  m: WAMessage,
  mediaPlaceholder: string
): Message {
  const outgoing = m.key.fromMe === true;
  const text = messageText(m);
  const media = mediaInfo(m.message);
  const hasMedia = !!(media.hasImage || media.file);
  const senderId = m.key.participant ?? undefined;
  // Caption for media; "" when media renders on its own; placeholder only for
  // unrecognized renderable content.
  const raw = text || media.caption || (hasMedia ? "" : m.message ? mediaPlaceholder : "");
  // Recognize a triple-backtick code block (only when it isn't a media caption).
  const body = !hasMedia && raw ? monospaceBlock(raw) : { text: raw };
  return {
    id: m.key.id ?? "",
    chatId,
    author: outgoing
      ? ""
      : m.pushName || jidUser(senderId ?? m.key.remoteJid ?? chatId),
    senderId: outgoing ? undefined : senderId,
    text: body.text,
    entities: body.entities,
    timestamp: toNum(m.messageTimestamp) * 1000,
    outgoing,
    hasImage: media.hasImage,
    mediaKind: media.mediaKind,
    file: media.file,
    forwarded: isForwarded(m),
    // Read receipts: only for our own messages in 1:1 chats (mirrors Telegram).
    status:
      outgoing && !isGroupJid(chatId) ? mapStatus(m.status) : undefined,
  };
}

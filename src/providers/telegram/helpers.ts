/**
 * Pure Telegram helpers — no `vscode` and no live client, so they can be unit
 * tested in isolation. Everything here maps raw GramJS/`Api` data into plain
 * values or the provider-agnostic model.
 */
import { Api } from "telegram";
import type { EntityLike } from "telegram/define";
import { MessageEntity } from "../types";

/** Extension (without the dot) from a filename, or "" if it has none. */
export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1) : "";
}

/** A file extension for a MIME type, or "" if it can't be derived. */
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
  };
  // Try the full subtype first (so hyphenated names like "mp4a-latm" map),
  // then the bare token with any parameters (e.g. "ogg; codecs=opus") stripped.
  const base = sub.replace(/[^a-z0-9].*$/, "");
  return map[sub] ?? map[base] ?? base;
}

/** Whether a chat's notifications are muted (muteUntil is in the future). */
export function isMuted(notify?: Api.TypePeerNotifySettings): boolean {
  if (!(notify instanceof Api.PeerNotifySettings)) {
    return false;
  }
  const until = notify.muteUntil;
  return until !== undefined && until > Math.floor(Date.now() / 1000);
}

/** Whether the current user can post to an entity. Broadcast channels are
 *  admin-only; groups can restrict sending via banned rights; forbidden peers
 *  are never writable. Private chats are assumed writable. */
export function canSendTo(entity: EntityLike): boolean {
  if (entity instanceof Api.ChannelForbidden || entity instanceof Api.ChatForbidden) {
    return false;
  }
  if (entity instanceof Api.Channel) {
    if (entity.broadcast) {
      // Only the creator or admins with post rights can publish.
      return entity.creator === true || entity.adminRights?.postMessages === true;
    }
    // Supergroup: admins bypass restrictions; otherwise check banned rights.
    if (entity.creator === true || entity.adminRights) {
      return true;
    }
    return (
      entity.defaultBannedRights?.sendMessages !== true &&
      entity.bannedRights?.sendMessages !== true
    );
  }
  if (entity instanceof Api.Chat) {
    // Basic group: writable unless we left / it was deactivated / sending banned.
    return (
      entity.left !== true &&
      entity.deactivated !== true &&
      entity.defaultBannedRights?.sendMessages !== true
    );
  }
  // Private chats (Api.User) and anything else: assume writable.
  return true;
}

/** Whether a folder's type rules (groups/bots/contacts/…) include an entity. */
export function matchesFolderFlags(f: Api.DialogFilter, e: EntityLike): boolean {
  if (e instanceof Api.User) {
    if (e.bot) {
      return !!f.bots;
    }
    return e.contact ? !!f.contacts : !!f.nonContacts;
  }
  if (e instanceof Api.Chat || e instanceof Api.ChatForbidden) {
    return !!f.groups;
  }
  if (e instanceof Api.Channel) {
    return e.broadcast ? !!f.broadcasts : !!f.groups;
  }
  return false;
}

/** Map Telegram's message entities into the provider-agnostic model. */
export function mapEntities(
  text: string,
  entities?: Api.TypeMessageEntity[]
): MessageEntity[] | undefined {
  if (!entities || entities.length === 0) {
    return undefined;
  }
  const out: MessageEntity[] = [];
  for (const e of entities) {
    const at = { offset: e.offset, length: e.length };
    const slice = () => text.slice(e.offset, e.offset + e.length);
    if (e instanceof Api.MessageEntityBold) out.push({ ...at, type: "bold" });
    else if (e instanceof Api.MessageEntityItalic) out.push({ ...at, type: "italic" });
    else if (e instanceof Api.MessageEntityUnderline) out.push({ ...at, type: "underline" });
    else if (e instanceof Api.MessageEntityStrike) out.push({ ...at, type: "strikethrough" });
    else if (e instanceof Api.MessageEntitySpoiler) out.push({ ...at, type: "spoiler" });
    else if (e instanceof Api.MessageEntityCode) out.push({ ...at, type: "code" });
    else if (e instanceof Api.MessageEntityPre)
      out.push({ ...at, type: "pre", language: e.language || undefined });
    else if (e instanceof Api.MessageEntityBlockquote) out.push({ ...at, type: "blockquote" });
    else if (e instanceof Api.MessageEntityTextUrl) out.push({ ...at, type: "link", url: e.url });
    else if (e instanceof Api.MessageEntityUrl) out.push({ ...at, type: "link", url: slice() });
    else if (e instanceof Api.MessageEntityEmail)
      out.push({ ...at, type: "link", url: "mailto:" + slice() });
    else if (e instanceof Api.MessageEntityMention)
      out.push({ ...at, type: "mention", url: "https://t.me/" + slice().replace(/^@/, "") });
    else if (e instanceof Api.MessageEntityMentionName)
      out.push({ ...at, type: "mention", url: "tg://user?id=" + e.userId.toString() });
    else if (e instanceof Api.MessageEntityHashtag) out.push({ ...at, type: "hashtag" });
    else if (e instanceof Api.MessageEntityBotCommand) out.push({ ...at, type: "botcommand" });
    // Other kinds (cashtag, bank card, custom emoji, phone) stay plain.
  }
  return out.length ? out : undefined;
}

/**
 * Pure mapping helpers for the Discord provider — no discord.js/vscode imports,
 * so they unit-test in isolation (like whatsapp/helpers.ts). The heavier
 * object→model mapping (toMessage/channelToChat) lives in the provider, where the
 * live discord.js objects are; these are the classification/format bits worth
 * testing on their own.
 */
import type { Message } from "../types";
import { parseDiscordMarkdown, MentionResolver } from "./markdown";

/* Minimal structural shapes of the discord.js objects we read, so the pure
 * mappers stay decoupled from the library's complex class unions and unit-test
 * with plain mocks. The provider passes real discord.js objects (which satisfy
 * these) via `as unknown as …`. */

export interface DiscordUserLike {
  id: string;
  username: string;
  globalName?: string | null;
}

/** A rich embed's textual parts (bot messages often carry their body here). */
export interface DiscordEmbedLike {
  title?: string | null;
  description?: string | null;
  author?: { name?: string | null } | null;
  fields?: Array<{ name?: string | null; value?: string | null }>;
}

/** A node in a Components V2 tree (Container/Section/ActionRow/TextDisplay…). */
export interface DiscordComponentLike {
  /** Present on TextDisplay nodes — the markdown body of the component. */
  content?: string;
  components?: DiscordComponentLike[];
}

/** Collect the text of a Components V2 message (bots increasingly send their
 *  body as a component tree with empty `content`/`embeds`). */
function componentsToText(components: DiscordComponentLike[]): string {
  const parts: string[] = [];
  const walk = (list?: DiscordComponentLike[]): void => {
    for (const c of list ?? []) {
      if (c.content) {
        parts.push(c.content);
      }
      walk(c.components);
    }
  };
  walk(components);
  return parts.join("\n\n");
}

/** The content-bearing part of a message (its own body, or a forward snapshot). */
export interface DiscordContentLike {
  content: string;
  embeds?: DiscordEmbedLike[];
  components?: DiscordComponentLike[];
  attachments?: {
    size?: number;
    first(): { contentType?: string | null; name?: string | null; size?: number } | undefined;
  };
  mentions?: {
    users?: { get(id: string): DiscordUserLike | undefined };
    channels?: { get(id: string): { name?: string | null } | undefined };
    roles?: { get(id: string): { name?: string | null } | undefined };
  };
}

/** Flatten an embed into plain text (author, title, description, fields). */
function embedToText(embeds: DiscordEmbedLike[]): string {
  const e = embeds[0];
  const parts: string[] = [];
  if (e.author?.name) {
    parts.push(e.author.name);
  }
  if (e.title) {
    parts.push(e.title);
  }
  if (e.description) {
    parts.push(e.description);
  }
  for (const f of e.fields ?? []) {
    const field = [f.name, f.value].filter(Boolean).join("\n");
    if (field) {
      parts.push(field);
    }
  }
  return parts.join("\n\n");
}

export interface DiscordMessageLike extends DiscordContentLike {
  id: string;
  channelId: string;
  author: DiscordUserLike;
  member?: { displayName?: string | null } | null;
  createdTimestamp: number;
  editedTimestamp?: number | null;
  /** Message type ("DEFAULT", "GUILD_MEMBER_JOIN", "REPLY", …). */
  type?: string;
  /** A reply reference (type !== "FORWARD") or a forward (type === "FORWARD"). */
  reference?: { messageId?: string | null; type?: string } | null;
  /** Forwarded-message content lives here, not in `content`. */
  messageSnapshots?: { first(): DiscordContentLike | undefined };
}

/** System messages carry no `content` — Discord's client renders their text from
 *  the type. We synthesize a short label so the bubble isn't blank. */
const SYSTEM_TEXT: Record<string, string> = {
  GUILD_MEMBER_JOIN: "joined the server",
  USER_PREMIUM_GUILD_SUBSCRIPTION: "boosted the server",
  USER_PREMIUM_GUILD_SUBSCRIPTION_TIER_1: "boosted the server (Tier 1)",
  USER_PREMIUM_GUILD_SUBSCRIPTION_TIER_2: "boosted the server (Tier 2)",
  USER_PREMIUM_GUILD_SUBSCRIPTION_TIER_3: "boosted the server (Tier 3)",
  CHANNEL_PINNED_MESSAGE: "pinned a message",
  CHANNEL_FOLLOW_ADD: "followed a channel",
  THREAD_CREATED: "started a thread",
  RECIPIENT_ADD: "added a recipient",
  RECIPIENT_REMOVE: "removed a recipient",
  CALL: "started a call",
  CHANNEL_NAME_CHANGE: "changed the channel name",
  CHANNEL_ICON_CHANGE: "changed the channel icon",
  GUILD_INVITE_REMINDER: "sent an invite reminder",
};

/** Readable name for a user (server nickname > global name > username). */
function userName(u: DiscordUserLike): string {
  return u.globalName || u.username;
}

function resolverFor(src: DiscordContentLike): MentionResolver {
  return {
    user: (id) => {
      const u = src.mentions?.users?.get(id);
      return u ? userName(u) : undefined;
    },
    channel: (id) => src.mentions?.channels?.get(id)?.name ?? undefined,
    role: (id) => src.mentions?.roles?.get(id)?.name ?? undefined,
  };
}

/**
 * Map a Discord message into Yapper's model: markdown → text + entities, with
 * mentions resolved to readable names. Forwarded messages carry an empty
 * `content` and their real body in `messageSnapshots` — read that instead.
 * Media is added by the provider (Phase 6).
 */
export function toMessage(m: DiscordMessageLike, meId?: string): Message {
  const isForward = m.reference?.type === "FORWARD";
  const src: DiscordContentLike =
    (isForward ? m.messageSnapshots?.first() : undefined) ?? m;
  // Normal body first; then embeds, then a Components V2 tree — bot messages
  // carry their text in one of these when `content` is empty.
  let parsed = parseDiscordMarkdown(src.content ?? "", resolverFor(src));
  if (!parsed.text && src.embeds?.length) {
    parsed = parseDiscordMarkdown(embedToText(src.embeds), resolverFor(src));
  }
  if (!parsed.text && src.components?.length) {
    parsed = parseDiscordMarkdown(componentsToText(src.components), resolverFor(src));
  }

  const msg: Message = {
    id: m.id,
    chatId: m.channelId,
    author: m.member?.displayName || userName(m.author),
    senderId: m.author.id,
    text: parsed.text,
    timestamp: m.createdTimestamp,
    outgoing: meId !== undefined && m.author.id === meId,
  };
  if (parsed.entities.length) {
    msg.entities = parsed.entities;
  }
  // Media model (independent of text — a message can have a caption + file).
  const att = src.attachments?.first();
  if (att) {
    const info = attachmentInfo(att);
    if (info.hasImage) {
      msg.hasImage = true;
      if (info.mediaKind) {
        msg.mediaKind = info.mediaKind;
      }
    } else if (info.file) {
      msg.file = info.file;
    }
  }
  // System messages (joins, boosts, pins…) carry no body or media — label by type.
  if (!msg.text && !msg.hasImage && !msg.file && m.type && SYSTEM_TEXT[m.type]) {
    msg.text = SYSTEM_TEXT[m.type];
  }
  if (m.editedTimestamp) {
    msg.edited = true;
  }
  if (isForward) {
    // Discord's forward carries no simple origin; just mark it forwarded.
    msg.forwarded = true;
  }
  // A real reply references another message; a forward is not a reply.
  if (!isForward && m.reference?.messageId) {
    // Preview (author/text) is enriched by the provider from cache when available.
    msg.reply = { id: m.reference.messageId, author: "", text: "" };
  }
  return msg;
}

export interface AttachmentInfo {
  hasImage?: boolean;
  mediaKind?: Message["mediaKind"];
  file?: { name: string; size?: number };
}

/**
 * Classify a Discord attachment into the UI's media model, from its content type
 * (preferred) or filename extension (fallback). Images/videos become inline
 * media; anything else is a downloadable file chip.
 */
export function attachmentInfo(att: {
  contentType?: string | null;
  name?: string | null;
  size?: number;
}): AttachmentInfo {
  const mime = (att.contentType ?? "").toLowerCase();
  const name = att.name ?? "file";

  if (mime.startsWith("image/")) {
    return { hasImage: true, mediaKind: mime === "image/gif" ? "gif" : "photo" };
  }
  if (mime.startsWith("video/")) {
    return { hasImage: true, mediaKind: "video" };
  }
  if (!mime) {
    // No content type — guess from the extension.
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "gif") {
      return { hasImage: true, mediaKind: "gif" };
    }
    if (["png", "jpg", "jpeg", "webp", "bmp"].includes(ext)) {
      return { hasImage: true, mediaKind: "photo" };
    }
    if (["mp4", "mov", "webm", "mkv"].includes(ext)) {
      return { hasImage: true, mediaKind: "video" };
    }
  }
  return { file: { name, size: att.size } };
}

/** File extension (no dot) for a MIME type, for naming downloaded media. */
export function extFromMime(mime?: string | null): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "application/pdf": "pdf",
  };
  return map[(mime ?? "").toLowerCase()] ?? "bin";
}

/**
 * A stable numeric folder id for a guild (Yapper's `Folder.id` is a number, but
 * Discord guild ids are snowflake strings that overflow Number). Assigns the
 * next index for an unseen guild, keeping the mapping stable within a session.
 * Ids start at 2 so they never collide with the tree's synthesized folders
 * ("All chats" = 0, "Archive" = 1).
 */
export function guildFolderId(guildId: string, seen: Map<string, number>): number {
  let id = seen.get(guildId);
  if (id === undefined) {
    id = seen.size + 2;
    seen.set(guildId, id);
  }
  return id;
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Turn picked `@username` mentions into Discord's functional `<@id>` form so
 *  they actually ping. Only the exact picked handles are replaced (a following
 *  word/`.` char blocks partial matches like `@bob` inside `@bobby`), so plain
 *  `@text` the user typed by hand never becomes a ping. */
export function applyMentions(
  text: string,
  mentions?: { id: string; username: string }[]
): string {
  if (!mentions?.length) {
    return text;
  }
  let out = text;
  for (const m of mentions) {
    if (!m.username || !m.id) {
      continue;
    }
    out = out.replace(
      new RegExp("@" + escapeRegExp(m.username) + "(?![\\w.])", "g"),
      `<@${m.id}>`
    );
  }
  return out;
}

/* --- Mute (read-only) ---
 * Discord stores per-user notification settings per guild: a whole-guild mute
 * plus per-channel overrides. The provider reads them live from
 * `guild.settings` (kept current by the library's USER_GUILD_SETTINGS_UPDATE
 * handler) to respect mutes set in the official app — we never write them
 * (the library has no reliable API). DMs aren't covered (Discord drops the
 * guild_id=null settings entry). See ADR-021. */

/** A per-channel notification override, as Discord sends it (raw snake_case). */
export interface RawChannelOverride {
  channel_id: string;
  muted?: boolean;
  mute_config?: { end_time?: string | null } | null;
}

/** The bits of the library's GuildSettingManager we read for mute. `muteConfig`
 *  is already a Date (the manager parses it); channel overrides stay raw. */
export interface GuildSettingsLike {
  muted?: boolean;
  muteConfig?: { endTime?: Date } | null;
  channelOverrides?: RawChannelOverride[];
}

/** Whether a mute is in effect now: the flag is on, and it's either permanent
 *  (no end time) or the end time is still in the future. `endTimeMs` null/NaN =
 *  permanent (Discord sends `mute_config: null` for a forever-mute). */
export function muteActive(
  muted: boolean | undefined,
  endTimeMs: number | null | undefined,
  now: number
): boolean {
  if (!muted) {
    return false;
  }
  if (endTimeMs === null || endTimeMs === undefined || Number.isNaN(endTimeMs)) {
    return true;
  }
  return endTimeMs > now;
}

/** Whether a guild channel is silenced: by its own channel override, or by a
 *  whole-guild mute (which mutes every channel). Timed mutes are honored. */
export function channelMuted(
  settings: GuildSettingsLike | undefined,
  channelId: string,
  now: number
): boolean {
  if (!settings) {
    return false;
  }
  const ov = settings.channelOverrides?.find((o) => o.channel_id === channelId);
  if (ov) {
    const end = ov.mute_config?.end_time
      ? Date.parse(ov.mute_config.end_time)
      : null;
    if (muteActive(ov.muted, end, now)) {
      return true;
    }
  }
  const guildEnd = settings.muteConfig?.endTime?.getTime();
  return muteActive(settings.muted, guildEnd ?? null, now);
}

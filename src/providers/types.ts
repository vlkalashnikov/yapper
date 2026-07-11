/**
 * Provider abstraction. Every messenger (Telegram, WhatsApp, Slack, ...)
 * implements this interface so the UI stays messenger-agnostic.
 */

export interface Chat {
  id: string;
  title: string;
  /** Last message preview, shown under the chat title. */
  lastMessage?: string;
  /** Number of unread messages. */
  unreadCount?: number;
  /** True for forum groups (their children are topics). */
  isForum?: boolean;
  /** Set when this target is a forum topic within the chat `id`. */
  topicId?: string;
  /** False when the current user can't post here (broadcast channel, banned,
   *  closed topic). Undefined/true means sending is allowed. */
  canSend?: boolean;
  /** True when notifications for this chat are muted in Telegram. */
  muted?: boolean;
}

/** A forum topic (sub-thread) inside a forum group. */
export interface Topic {
  id: string;
  title: string;
  unreadCount?: number;
  /** True when the topic is closed (only admins can post). */
  closed?: boolean;
}

/** A Telegram folder (dialog filter) and the chats that belong to it. */
export interface Folder {
  id: number;
  title: string;
  chatIds: string[];
}

/** A chat member, offered for @-mention autocomplete. */
export interface Member {
  id: string;
  name: string;
  username?: string;
}

/** A message hit from global (all-chats) search. */
export interface GlobalHit {
  chatId: string;
  chatTitle: string;
  messageId: string;
  snippet: string;
  /** Unix epoch milliseconds. */
  timestamp: number;
}

/** Profile card for a chat/contact (provider-agnostic). */
export interface Profile {
  kind: "user" | "group" | "channel";
  /** Display name / chat title. */
  title: string;
  /** @username, if any. */
  username?: string;
  /** Bio (user) or description (group/channel). */
  bio?: string;
  /** Phone number, for contacts. */
  phone?: string;
  /** Secondary line: online / last seen (users) or member count (groups). */
  subtitle?: string;
  /** Large avatar as a data URL. */
  avatar?: string;
  /** Number of groups in common (users only). */
  commonChats?: number;
  /** Invite link (groups/channels), for copying/sharing. */
  inviteLink?: string;
  /** True when notifications for this chat are muted (for the mute toggle). */
  muted?: boolean;
}

/**
 * Provider-agnostic text formatting. Telegram, WhatsApp, Slack, Discord all
 * express rich text as ranges over the plain text — so every provider maps its
 * native format into these entities, and the UI renders them uniformly.
 * Offsets/lengths are in UTF-16 code units (JS string indices).
 */
export type EntityType =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "spoiler"
  | "code"
  | "pre"
  | "blockquote"
  | "link"
  | "mention"
  | "hashtag"
  | "botcommand";

export interface MessageEntity {
  type: EntityType;
  offset: number;
  length: number;
  /** For "link"/"mention": the target URL. */
  url?: string;
  /** For "pre": the code language, if known. */
  language?: string;
}

export interface Message {
  id: string;
  chatId: string;
  /** Display name of the sender (full name where available). */
  author: string;
  /** Sender's id, for opening their profile from a group message. */
  senderId?: string;
  text: string;
  /** Unix epoch milliseconds. */
  timestamp: number;
  /** True when the message was sent by the current user. */
  outgoing: boolean;
  /** Sender's avatar as a data URL (per-message, so group chats show each author). */
  avatar?: string;
  /** True when the message has a downloadable image/thumbnail (photo, video, sticker). */
  hasImage?: boolean;
  /** Kind of media, so the UI can show a play badge and open it correctly. */
  mediaKind?: "photo" | "video" | "gif" | "sticker";
  /** Downloadable document (file/audio/voice, not an inline image): name + size in bytes. */
  file?: { name: string; size?: number };
  /** Set when this message replies to another: a preview + the target id. */
  reply?: { id: string; author: string; text: string };
  /** Rich-text formatting ranges over `text` (provider-agnostic). */
  entities?: MessageEntity[];
  /** Forum topic this message belongs to, if any. */
  topicId?: string;
  /** True when the message has been edited. */
  edited?: boolean;
  /** Delivery state of an outgoing message in a private chat: "sent" (✓) or
   *  "read" (✓✓). Undefined for incoming messages and group/channel chats. */
  status?: "sent" | "read";
}

/** Full-resolution media downloaded for opening in a viewer/player, or a
 *  plain document downloaded for saving to disk. */
export interface MediaFile {
  data: Uint8Array;
  /** Suggested filename with extension, e.g. "report.pdf" (used for downloads). */
  filename: string;
  /** File extension without the dot, e.g. "jpg", "mp4". */
  extension: string;
  /** Real MIME type from the source (e.g. "audio/ogg", "video/mp4"). */
  mime: string;
  kind: "image" | "video" | "file";
}

/**
 * A messenger backend. MVP only requires reading chats and messages;
 * sending and realtime updates arrive in later stages.
 */
export interface MessengerProvider {
  /** Stable id, e.g. "telegram", "mock". */
  readonly id: string;
  /** Human-readable name shown in the UI. */
  readonly name: string;
  /** Page size of getMessages/getMessagesBefore/getMessagesAfter, so the UI can
   *  detect end-of-history: a short page means there are no more messages. */
  readonly historyPageSize?: number;

  getChats(): Promise<Chat[]>;
  getMessages(chatId: string, topicId?: string): Promise<Message[]>;

  /** Load a page of messages older than the given message id (pagination). */
  getMessagesBefore?(
    chatId: string,
    beforeMessageId: string,
    topicId?: string
  ): Promise<Message[]>;

  /** Load a window of messages around a given message (for jump-to-message). */
  getMessagesAround?(
    chatId: string,
    messageId: string,
    topicId?: string
  ): Promise<Message[]>;

  /** Load a page of messages newer than the given id (forward pagination). */
  getMessagesAfter?(
    chatId: string,
    afterMessageId: string,
    topicId?: string
  ): Promise<Message[]>;

  /** Mark a chat's messages as read (clears its unread count). */
  markAsRead?(chatId: string, topicId?: string): Promise<void>;

  /** Forum topics (sub-threads) of a forum group. */
  getTopics?(chatId: string): Promise<Topic[]>;

  /** Search chat members for @-mention autocomplete. */
  searchMembers?(chatId: string, query: string): Promise<Member[]>;

  /** Full profile of a chat/contact, for a profile card (without avatar). */
  getProfile?(chatId: string): Promise<Profile | undefined>;

  /** The chat's big profile avatar (streamed separately, so the card is instant). */
  getProfileAvatar?(chatId: string): Promise<string | undefined>;

  /** Resolve a public username (or id) to a chat, for opening t.me links in-app. */
  resolveChat?(query: string): Promise<Chat | undefined>;

  /** Mute or unmute notifications for a chat. */
  setMuted?(chatId: string, muted: boolean): Promise<void>;

  /** Shared media ("media" = photos/videos, "files" = documents) of a chat. */
  getSharedMedia?(
    chatId: string,
    kind: "media" | "files",
    topicId?: string
  ): Promise<Message[]>;

  /** Search messages within a chat (optionally a forum topic), newest first. */
  searchMessages?(
    chatId: string,
    query: string,
    topicId?: string
  ): Promise<Message[]>;

  /** Search messages across all chats (global search). */
  searchGlobal?(query: string): Promise<GlobalHit[]>;

  /**
   * Send a message to a chat and return the created message.
   * Optional: not every provider/stage supports sending yet
   * (real Telegram sending lands in a later stage).
   */
  sendMessage?(
    chatId: string,
    text: string,
    replyToId?: string,
    topicId?: string
  ): Promise<Message>;

  /** Send a message whose entire body is a code block (monospace). */
  sendCode?(
    chatId: string,
    text: string,
    language?: string,
    topicId?: string
  ): Promise<Message>;

  /** Send a local file as a document (upload from disk). */
  sendFile?(
    chatId: string,
    filePath: string,
    filename?: string,
    topicId?: string
  ): Promise<Message>;

  /**
   * Return the chat's avatar as a data URL, or undefined if there is none.
   * Optional: providers without avatars simply omit it.
   */
  getAvatar?(chatId: string): Promise<string | undefined>;

  /**
   * Return a message's image (thumbnail) as a data URL, or undefined.
   * Called lazily by the UI for messages with hasImage.
   */
  getMedia?(chatId: string, messageId: string): Promise<string | undefined>;

  /**
   * Download a message's full-resolution media for opening in a viewer/player.
   */
  getMediaFile?(chatId: string, messageId: string): Promise<MediaFile | undefined>;

  /**
   * Return the user's folders (dialog filters) with their member chat ids.
   * Receives the already-loaded chats to avoid re-fetching. Empty array means
   * "no folders" → the UI shows a flat list.
   */
  getFolders?(chats: Chat[]): Promise<Folder[]>;
}

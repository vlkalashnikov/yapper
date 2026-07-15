# Change Log

All notable changes to the Yapper extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Fixed

- The unread badge on the Yapper icon no longer counts **muted** chats (mirrors
  Telegram). A single muted group sitting on tens of thousands of unread
  messages was swamping the badge — it now reflects only chats you actually get
  notified about.

## [1.3.1] - 2026-07-15

### Added

- **Discord**: `@`-mentions picked from autocomplete are now **functional pings**
  — they're sent as `<@id>`, so the mentioned person is actually notified. Only
  mentions picked from the popup ping; plain `@text` you type doesn't (ADR-025).
- **Forwarded messages** now show a "↪ Forwarded" marker (all providers), with
  the origin ("from …") where the provider exposes it (Telegram). WhatsApp hides
  the original sender and Discord doesn't surface it, so those show just the
  marker.

### Fixed

- Replying to a message now shows your sent message as a reply **immediately**,
  with the quoted author and text, instead of looking like a plain message until
  the view refreshed (all providers).

## [1.3.0] - 2026-07-14

### Added

- **Discord**: read-only **mute** — mutes set in the official Discord app for
  servers and their channels are respected (muted chats stay quiet and are
  marked 🔇 in the list), matching WhatsApp. No toggle yet, and DM mutes aren't
  exposed by the library (ADR-021).
- **Discord**: **in-chat search** — the 🔍 header button (and the profile card)
  now search messages in the open channel or thread and jump to a hit, same as
  Telegram (ADR-022). Global search is still to come.
- **Discord**: **shared media** — the profile card's Media and Files tabs list a
  chat's photos/videos and documents, built on the same search (ADR-023).
- **Discord**: **`@`-mention autocomplete** — typing `@` in a server channel
  suggests members (via the gateway, so a user account can use it), and group
  DMs suggest recipients. Inserted as text for now, not a functional ping
  (ADR-024).

## [1.2.1] - 2026-07-14

### Added

- **Discord**: per-message author avatars in group and server chats.
- **Discord**: DMs and group DMs are grouped into a **Direct Messages** folder,
  and each server gets its own folder (no catch-all "All chats").
- **Discord**: profile cards for DMs, group DMs, channels, and message authors.
- **Chat-list icons by type**: Discord text channels show `#`; Telegram private
  chats a person, groups a group icon, and broadcast channels a megaphone.

### Fixed

- Profile cards only show the **Mute / Search / Media / Files** buttons for
  messengers that actually support them (Discord shows info only).
- Clicking a link in a message opens it **once** — VS Code's webview no longer
  opens a second browser tab alongside Yapper's handler.
- Profile usernames link out only when the provider supplies a URL (Telegram
  t.me); Discord shows plain text instead of a wrong t.me link, with a single
  leading `@`.
- Markdown image syntax `![alt](url)` renders as a masked link.
- The profile card no longer hangs on a spinner when a provider errors.

## [1.2.0] - 2026-07-14

### Added

- **Discord** provider (text-first, **BETA**) via a `discord.js-selfbot` fork:
  QR sign-in as your **own account** (not a bot), so DMs, group DMs and servers
  appear in the editor. Servers show as folders, forum channels expand into
  threads; history with pagination.
- Realtime send / receive, edits and deletes, and a per-session unread badge.
- Rich Discord text renders — markdown (incl. headings), mentions, custom emoji,
  **forwards**, **embeds**, and modern **Components V2** bot messages — plus
  incoming media (image previews, lightbox, downloads).
- **Editor sharing** (Send Code / File / Diff / Commit / Line) works into
  Discord, same as Telegram and WhatsApp.
- Message-length capping is now per-provider (`maxMessageLength`; Discord 2000,
  Telegram 4096) instead of a hardcoded limit.

### Notes

- Automating a **user account** violates Discord's Terms of Service (ban risk),
  and Discord CAPTCHA-gates sending from new devices — sending is best-effort
  (warm up the device from the official app first). Search, profiles and mute
  are still to come.

## [1.1.2] - 2026-07-13

### Changed

- Revamped the README: a branded banner, local (self-contained) badges, a
  Telegram vs WhatsApp capability comparison table, and separate per-messenger
  sections. Added media — a Telegram screenshot and an editor-sharing GIF.

## [1.1.1] - 2026-07-13

### Added

- **WhatsApp**: history pagination (on-demand older-message fetch), read
  receipts (✓/✓✓), read-only mute, editor sharing (**Send Code/File to Chat**),
  incoming media (previews + downloads), and the chat avatar in the header.
- **Refresh** now reconnects WhatsApp to pull messages missed while offline
  (debounced).
- **Chat list**: last-message time, a 🔇 mute marker, and a hover tooltip
  (title, phone, preview, mute).
- **Copy formatted text**: a Copy button on code blocks and click-to-copy on
  inline code fragments, with a "Copied" toast.

### Fixed

- **WhatsApp**: no longer drops disappearing / view-once / device-sent messages
  (container messages are unwrapped); code renders as a block instead of literal
  triple-backticks; `@`-mentions open the chat via the active provider instead
  of a Telegram link; media re-downloads after a re-login.
- Loading a chat no longer blocks on the avatar (streamed into the header), and
  a stale older-messages loader no longer lingers as a second spinner.

## [1.1.0] - 2026-07-12

### Added

- **WhatsApp** provider (text-only, **BETA**) via Baileys: QR sign-in, chat
  list, history, send, and realtime incoming messages. Chats and messages
  persist across restarts; LID/phone-number addressing is deduplicated.
- Multiple messenger backends in one extension — switch the active one with
  **Yapper: Switch Messenger**. Introduces a `Messenger` interface and a
  provider registry, groundwork toward the unified messenger-agnostic vision.
  Not-yet-complete providers are tagged **BETA** in the UI.

### Changed

- Provider-neutral `QrLoginPanel` and `AuthCancelled`, reused across providers.
- Minimum VS Code bumped to `^1.91.0` (Node.js 20), required by Baileys.

## [1.0.0] - 2026-07-12

First public release — a unified developer messenger for VS Code, with full
Telegram support (more providers on the roadmap).

### Added

- QR-code sign-in with 2FA support; session persisted in SecretStorage.
- Chat list with Telegram folders, forum topics, and a dedicated **Archive**
  folder; unread badge and toast notifications.
- Realtime messaging: history with pagination, send, reply, edit/delete,
  read receipts, and `@`-mention autocomplete.
- Media: image previews, a lightbox for images/video, and file download.
- Search: within a chat and globally across all chats; contact/chat/channel
  profile cards with shared media and files.
- Editor integration: share selection, file, location (`path:line`), git diff,
  and commit into the open chat; open `path:line` references back in the editor.
- Localization: English (base) and Russian.
- First unit-test suite (Vitest) for `MockProvider` and `TelegramStorage`.

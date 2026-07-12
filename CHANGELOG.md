# Change Log

All notable changes to the Yapper extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

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

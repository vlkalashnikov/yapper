# Change Log

All notable changes to the Yapper extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- Archived chats are shown under a dedicated **Archive** folder in the chat
  tree, excluded from "All chats" and custom folders (mirrors Telegram).
- First unit-test suite (Vitest) for `MockProvider` and `TelegramStorage`.

## [0.1.0] - 2026-07-12

Initial release. Telegram client integrated into VS Code.

### Added

- QR-code sign-in with 2FA support; session persisted in SecretStorage.
- Chat list with folders and forum topics; unread badge and toast notifications.
- Realtime messaging: history with pagination, send, edit/delete, read receipts.
- Media: image previews, lightbox for images/video, file download.
- Search: within a chat, and global across all chats; contact/chat profile card.
- Editor integration: share selection, file, location (`path:line`), git diff,
  and commit into the open chat; open `path:line` references back in the editor.
- Localization: English (base) and Russian.

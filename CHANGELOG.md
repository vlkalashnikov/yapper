# Change Log

All notable changes to the Yapper extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [1.0.0] - 2026-07-12

First public release — a Telegram client integrated into VS Code.

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

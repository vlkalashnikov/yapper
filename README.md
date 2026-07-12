# Yapper

> Unified Developer Messenger for VS Code — bring your work chats into the
> editor, and share code, diffs and commits straight into a conversation.

Yapper is a **messenger-agnostic** VS Code extension: a single sidebar and a
Claude-Code-style conversation tab that any messaging backend can plug into.
It's built so the UI never depends on a specific messenger — each provider maps
its own data into a shared model, and the interface renders it uniformly.

**Telegram is fully supported today, WhatsApp is text-only.** Slack, Discord and
Microsoft Teams are on the roadmap. The point isn't to reimplement each client —
it's to give developers the things a normal messenger can't do from an editor:
send a selection, a file, a `path:line` link, a `git diff` or the last commit
straight into a chat.

## Supported messengers

| Messenger | Status |
| --- | --- |
| **Telegram** | ✅ Available |
| **WhatsApp** | ✅ Available (text-only) |
| Slack | 🧭 Planned |
| Discord | 🧭 Planned |
| Microsoft Teams | 🧭 Planned |

Switch the active messenger with **Yapper: Switch Messenger**. WhatsApp support
is text-only for now (chats, history, send, realtime); media, search and
profiles are Telegram-only.

## Features

Available today (via the Telegram provider):

- **QR-code sign-in** — scan it from the mobile app; 2FA supported. The session
  is stored in VS Code SecretStorage and survives restarts.
- **Chat list** with folders, forum topics, an **Archive** folder, an unread
  badge and toast notifications.
- **Realtime messaging** — full history with pagination, send, reply, edit and
  delete, read receipts (✓ / ✓✓), and `@`-mention autocomplete.
- **Media** — inline image previews, a lightbox for images and video, and file
  download. (Video audio opens in your system player; see *Limitations*.)
- **Search** — within a chat, or globally across all chats. Rich profile cards
  for contacts, groups and channels, with shared media and files.

Editor integration (provider-agnostic — works with any messenger that supports
sending):

- **Share from the editor** — send the current selection (or whole file) as a
  code block, a file as a document, a `path:line` link, the working `git diff`,
  or the latest commit — into the chat you have open.
- **Clickable `path:line`** references in messages open the file at that line.

Everywhere:

- **Localized** — English and Russian; follows your VS Code display language.

## Requirements

- VS Code `^1.85.0`.
- For the Telegram provider: a Telegram account and an **api_id** / **api_hash**,
  obtained once from [my.telegram.org](https://my.telegram.org) → *API
  development tools*. These identify the client application to Telegram (they
  are not your account login); you enter them once and Yapper reuses them from
  SecretStorage.

## Getting started (Telegram)

1. Open the **Yapper** view from the Activity Bar.
2. Click **Sign in to Telegram**.
3. On first launch, paste your `api_id` and `api_hash`.
4. Scan the QR code from **Telegram → Settings → Devices → Link Desktop Device**.
5. Enter your 2FA password if your account has one.

Your chats appear in the sidebar. Click one to open the conversation tab.

For **WhatsApp**, run **Yapper: Switch Messenger → WhatsApp**, click **Sign in**,
and scan the QR from **WhatsApp → Settings → Linked Devices → Link a Device**.
No api_id/api_hash needed.

## Commands

| Command | Description |
| --- | --- |
| Yapper: Sign in to Telegram | Start QR sign-in |
| Yapper: Sign out of Telegram | Disconnect (keeps API credentials) |
| Yapper: Search Chats | Quick-pick over your chats |
| Yapper: Search All Messages | Global message search |
| Yapper: Send Code to Chat | Send the selection / whole file as a code block |
| Yapper: Send File to Chat | Send a file as a document |
| Yapper: Send Line Link to Chat | Send a `path:line` reference |
| Yapper: Send Git Diff to Chat | Send the working-tree `git diff` |
| Yapper: Send Latest Commit to Chat | Send the last commit's metadata |

Sharing commands are also available from the editor context menu, the SCM title
bar (diff / commit), and the Explorer (send file).

## Keybindings

| Shortcut (macOS / Win-Linux) | Action |
| --- | --- |
| `Cmd+Alt+C` / `Ctrl+Alt+C` | Search chats |
| `Cmd+Alt+G` / `Ctrl+Alt+G` | Search all messages |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `yapper.notifications.enabled` | `true` | Show a notification for new incoming messages |
| `yapper.notifications.showPreview` | `true` | Include message text in the notification |

## Privacy & security

- Credentials and session strings are kept in VS Code **SecretStorage** — never
  in `settings.json` and never synced.
- For Telegram, `api_id` / `api_hash` authenticate the *application*, not your
  account; the QR scan authorizes this device as your account.

## Limitations

- **Voice messages** play only as a downloadable file for now — the VS Code
  webview can't decode Opus/OGG audio inline.
- **Video** shows without sound in the lightbox; use **Open with sound** to play
  it in your system player.
- Telegram accounts with **more than ~1000 dialogs** may not load every chat yet.

## Architecture

Yapper separates a messenger-agnostic UI from pluggable providers. Every backend
implements a shared `MessengerProvider` interface and maps its native format
(messages, rich-text entities, media, folders) into a common model, so adding a
new messenger requires no UI changes. See `docs/PROJECT.md` and
`docs/DECISIONS.md` for the design and the architecture decisions (ADRs).

## License

[MIT](LICENSE)

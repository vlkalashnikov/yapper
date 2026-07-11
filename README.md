# Yapper

> Telegram, integrated into VS Code — chat without leaving your editor, and
> share code, diffs and commits straight into a conversation.

Yapper brings your Telegram chats into a native VS Code sidebar and a
Claude-Code-style conversation tab, and adds the things a normal messenger
can't do from an editor: send a selection, a file, a `path:line` link, a
`git diff`, or the last commit right into an open chat.

## Features

- **Sign in with a QR code** — scan it from the mobile app; 2FA supported. Your
  session is stored in VS Code SecretStorage and survives restarts.
- **Chat list** with Telegram folders, forum topics, an **Archive** folder,
  unread badge and toast notifications.
- **Realtime messaging** — full history with pagination, send, reply, edit and
  delete, read receipts (✓ / ✓✓), and `@`-mention autocomplete.
- **Media** — inline image previews, a lightbox for images and video, and file
  download. (Video audio opens in your system player; see *Limitations*.)
- **Search** — within a chat, or globally across all chats. Rich profile cards
  for contacts, groups and channels, with shared media and files.
- **Share from the editor** — send the current selection (or whole file) as a
  code block, a file as a document, a `path:line` link, the working `git diff`,
  or the latest commit — into the chat you have open. Clickable `path:line`
  references in messages open the file at that line.
- **Localized** — English and Russian; follows your VS Code display language.

## Requirements

- VS Code `^1.85.0`.
- A Telegram account.
- A Telegram **api_id** and **api_hash**, obtained once from
  [my.telegram.org](https://my.telegram.org) → *API development tools*. These
  identify the client application to Telegram (they are not your account
  login); you enter them once and Yapper reuses them from SecretStorage.

## Getting started

1. Open the **Yapper** view from the Activity Bar.
2. Click **Sign in to Telegram**.
3. On first launch, paste your `api_id` and `api_hash`.
4. Scan the QR code from **Telegram → Settings → Devices → Link Desktop Device**.
5. Enter your 2FA password if your account has one.

Your chats appear in the sidebar. Click one to open the conversation tab.

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

- Your `api_id`, `api_hash` and Telegram session string are kept in VS Code
  **SecretStorage** — never in `settings.json` and never synced.
- `api_id` / `api_hash` authenticate the *application*, not your account;
  the QR scan authorizes this device as your account.

## Limitations

- **Voice messages** play only as a downloadable file for now — the VS Code
  webview can't decode Opus/OGG audio inline.
- **Video** shows without sound in the lightbox; use **Open with sound** to play
  it in your system player.
- Accounts with **more than ~1000 dialogs** may not load every chat yet.

## Localization

English is the base language; Russian is included. The UI follows your VS Code
display language. See `docs/DECISIONS.md` (ADR-008) for the i18n design.

## License

[MIT](LICENSE)

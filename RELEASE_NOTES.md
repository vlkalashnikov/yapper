# Release notes

Notes for the current release, ready to paste into a GitHub Release (or use with
`gh release create <tag> <vsix> --notes-file RELEASE_NOTES.md`). Update this per
release; the authoritative history lives in [CHANGELOG.md](CHANGELOG.md).

---

## v1.3.1 — Functional mentions, forwarded marker, reply fix

### Added
- Discord: `@`-mentions picked from autocomplete are now **functional pings** —
  sent as `<@id>`, so the person is actually notified. Only mentions picked from
  the popup ping; plain `@text` you type doesn't.
- **Forwarded messages** show a "↪ Forwarded" marker (all providers), with the
  origin ("from …") where the provider exposes it (Telegram). WhatsApp hides the
  original sender and Discord doesn't surface it, so those show just the marker.

### Fixed
- Replying to a message now shows your sent message as a reply **immediately**
  (with the quoted author and text), instead of looking like a plain message
  until the view refreshed — all providers.

📎 Download: `yapper-1.3.1.vsix`

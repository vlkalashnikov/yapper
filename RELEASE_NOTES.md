# Release notes

Notes for the current release, ready to paste into a GitHub Release (or use with
`gh release create <tag> <vsix> --notes-file RELEASE_NOTES.md`). Update this per
release; the authoritative history lives in [CHANGELOG.md](CHANGELOG.md).

---

## v1.2.1 — Discord polish

### Added
- Discord: per-message author avatars in group/server chats.
- Discord: DMs grouped into a "Direct Messages" folder; each server its own folder.
- Discord: profile cards (DMs, group DMs, channels, message authors).
- Chat-list icons by type: Discord "#" channels; Telegram person / group / megaphone.

### Fixed
- Profile cards show Mute/Search/Media only for messengers that support them.
- Links in messages open once (no duplicate browser tab).
- Profile username links out only when the provider gives a URL (Telegram t.me).
- `![alt](url)` renders as a masked link; profile card no longer hangs on error.

📎 Download: `yapper-1.2.1.vsix`

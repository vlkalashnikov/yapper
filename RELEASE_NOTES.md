# Release notes

Notes for the current release, ready to paste into a GitHub Release (or use with
`gh release create <tag> <vsix> --notes-file RELEASE_NOTES.md`). Update this per
release; the authoritative history lives in [CHANGELOG.md](CHANGELOG.md).

---

## v1.3.0 — Discord: mute, search, shared media & mentions

Brings the Discord (BETA) provider much closer to Telegram.

### Added
- Discord: read-only **mute** — mutes set in the official Discord app for servers
  and their channels are respected (muted chats stay quiet, marked 🔇). No toggle
  yet, and DM mutes aren't exposed by the library.
- Discord: **in-chat search** — the 🔍 header button (and the profile card) search
  messages in the open channel or thread and jump to a hit. Global search is still
  to come.
- Discord: **shared media** — the profile card's Media and Files tabs list a
  chat's photos/videos and documents.
- Discord: **`@`-mention autocomplete** — typing `@` in a server channel suggests
  members (via the gateway, so a user account can use it); group DMs suggest
  recipients. Inserted as text for now, not a functional ping.

📎 Download: `yapper-1.3.0.vsix`

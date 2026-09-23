# Moving Deep Cuts to another computer

Everything Deep Cuts knows lives in one DuckDB file in its data folder. A **move bundle** is that file written out in a version-proof form so a different build on a different machine can take it over completely.

## What travels
- Every raw play (the import and every poll since), sessions, insights, milestones, eras parameters
- Album art URLs, Last.fm / MusicBrainz tags, relations, origins, listener-count history, catalogue sizes, credits
- Lyric features (derived only — no lyric text exists to move)
- Liked songs, playlists and their items, playlists Deep Cuts created
- Every decision you made in the app: Discover feedback, Crate skips/keeps, Not-for-me verdicts, scene overrides, merged artists, session corrections, travel ranges, pins/hides on Heard in the Wild, your scene vocabulary edits
- All settings (skin, tuning, quotas, Ollama URL/model)
- **Optionally** the sign-ins: Spotify tokens + client id, Last.fm key/user, stats.fm key — only if you type a passphrase; they are encrypted with it inside the bundle

## Not in the bundle
- The demo record (regenerated), the time-zone offset table (regenerated from your saved zone), the nightly `backups/` folder, log files.

## Export (old computer)
Settings → Record → **Move to another computer** → *Export this record*. Pick a folder (default: `backups/`), optionally a passphrase, *Write move bundle*. You get `deep-cuts-move-YYYYMMDD-HHMMSS.zip`: one Parquet file per table under `tables/`, a `manifest.json`, and `secrets.enc` when a passphrase was given.

## Restore (new computer)
Install Deep Cuts (the same version or newer), open Settings → Record → Move → *Restore a bundle here* → choose the zip → **Inspect** (shows plays, date range, source machine, whether sign-ins are included) → type the passphrase if you want the sign-ins → **Restore**.

What happens: the current record's plays (if any) are saved to `backups/events-before-restore-*.parquet`; every table in the bundle replaces the one here, matching columns by name (columns this version added take their defaults; columns it dropped are ignored); the record is rebuilt under this build's pipeline; sign-ins go into this machine's OS keyring; polling resumes on the next tick.

## Notes
- Wrong passphrase → nothing is touched. Blank passphrase on a bundle with secrets → restored without sign-ins; reconnect on Services.
- Spotify's redirect is `http://127.0.0.1:8888/callback` on both machines, so the client id carries over unchanged.
- The bundle is a full snapshot, not an incremental backup. Keep the nightly Parquet rotation for that.
- Portable mode is unaffected: restore into a portable install exactly the same way.
- Browser harness (`dev-server.mjs`): writes a *folder* bundle instead of a zip (no zip library in Node); restore accepts either.

# Stylus — Deep Cuts' own scrobbler (design, Phase 9i)

**Owner request (9h.1 feedback):** a home-built scrobbler integrated into Services; what it records is optional for privacy;
an *enrichment* mode that adds what Spotify polling can't see, and a *replacement* mode for people who don't want to connect
Spotify or other services; able to run in Docker so other devices can scrobble to it.

## 1. The key decision: speak ListenBrainz, don't invent a protocol
Stylus exposes the **ListenBrainz submission API** (`POST /1/submit-listens`, `GET /1/validate-token`). That single choice means
a large set of existing, maintained clients can point at it on day one — no Deep Cuts app to build for each device:

| Where you listen | Client that already speaks ListenBrainz |
|---|---|
| Android (any player, incl. YouTube Music, Poweramp, Tidal) | Pano Scrobbler (custom ListenBrainz URL) |
| Browser (Bandcamp, SoundCloud, YouTube, Apple Music web…) | Web Scrobbler extension (custom ListenBrainz URL) |
| Home server / self-hosted | multi-scrobbler (Docker) — sources Spotify, Plex, Jellyfin, Navidrome, Subsonic, MPD, Kodi, Mopidy, YouTube Music, Last.fm, Deezer… |
| Navidrome, Jellyfin, Funkwhale | built-in ListenBrainz scrobbling |
| Desktop players | foobar2000, MusicBee, Strawberry, Quod Libet plugins |

A Last.fm-compatible endpoint (`/2.0/?method=track.scrobble`) is a later option for clients that only do Last.fm.

## 2. Modes
- **Enrichment** (default): Spotify polling stays the backbone; Stylus adds listening Spotify never sees (other services,
  local files, vinyl rips via a desktop player, a friend's car) and sharper facts for Spotify plays it does see (exact start,
  pause/resume, the player and device). Overlaps are merged with the 9i rule: same track (Spotify id, else ISRC, else
  normalised artist + title) and start of play within 10 s → one play; Spotify's row keeps the id, Stylus contributes device/client.
- **Replacement**: no Spotify connection at all. Stylus is the primary source; identity comes from the submitted
  ISRC / MusicBrainz recording id / names, enrichment runs through MusicBrainz, Last.fm tags, FreqBlog (by ISRC or name) and
  LRCLIB exactly as today. Pages that need Spotify (queueing, playlist creation, Library sync) say so instead of erroring.

## 3. Privacy — everything optional, off unless chosen
Per device token, the owner chooses which fields are kept; the rest are dropped at the door (never stored):
- track · artist · album (required — a play needs something to be about)
- exact timestamp, or rounded to the minute / hour
- duration and how much was played (needed for skip detection; off = no skip stats for that device)
- player and client name ("Poweramp", "Web Scrobbler")
- service ("youtube music", "bandcamp")
- device name
- country / time zone (off by default)

Also:
- **pause switch** on the Services card (or per device) — submissions are accepted and discarded, so clients don't queue up
- **quiet hours** and per-client blocklist (e.g. never keep anything from the work laptop)
- **retention** — drop Stylus-only raw payloads after N days, keep the resolved play
- **binds to 127.0.0.1 by default**; LAN or remote only when the owner turns it on, with a warning; tokens are random 32-byte,
  stored hashed, revocable per device

## 4. Architecture
**In-app receiver (Stylus core).** A small HTTP listener inside the Tauri app (port 4749, configurable) on the existing tokio
runtime. `submit-listens` validates the token, applies the device's privacy mask, and writes `events` rows with
`source = 'stylus'`, `event_type = 'play'` (`playing_now` submissions update the Dashboard's now-playing strip, never stored).
Timestamp semantics: ListenBrainz `listened_at` = START of play → plays_normalized adds duration, same as polling.

**Relay for other devices (Docker, optional).** When you're away from home the desktop may be asleep or unreachable, so the
container is a tiny store-and-forward box on a home server / NAS:
- accepts the same ListenBrainz API from phones and browsers anywhere (behind the owner's own HTTPS reverse proxy),
- appends to a local SQLite queue on a volume,
- the desktop **pulls** (`GET /stylus/queue?since=<cursor>`) whenever it's awake — the desktop is never exposed to the internet.
One `docker-compose.yml` ships with the relay, an optional multi-scrobbler service pre-pointed at it, and a Caddy example.

**Schema (planned).**
```
stylus_devices (device_id, name, token_hash, fields JSON, paused BOOL, created_at, last_seen_at, submissions INTEGER)
stylus_relays  (relay_url, token, cursor, last_pull_at, last_error)
events.payload for source 'stylus': track_name, artist_name, album_name, listened_at, duration_ms, ms_played?,
  isrc?, recording_mbid?, spotify_id?, media_player?, submission_client?, music_service?, device?, country?
```

## 5. Build order
1. **S1 — receiver**: listener, device tokens, Services → Stylus card (add device → token + setup text for Pano / Web Scrobbler), enrichment-mode merge rule, fixture tests on ListenBrainz payloads.
2. **S2 — privacy**: per-device field mask, pause, quiet hours, retention; Settings → Privacy shows exactly what each device keeps.
3. **S3 — relay**: container image, pull cursor, compose file, "relay reachable / queued N" on the card.
4. **S4 — replacement mode**: identity without Spotify ids, pages degrade gracefully, onboarding that offers Stylus instead of Spotify.

## 6. Questions for the owner
- Which devices first? (Android phone via Pano is the quickest win.)
- Is a home server / NAS available for the relay, or should S3 wait?
- Keep country for Stylus plays? It powers Atlas → Listening abroad, but it's the most sensitive field.

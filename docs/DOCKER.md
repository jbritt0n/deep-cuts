# Deep Cuts in Docker — the always-on analyst

**Phase 9e.** The desktop app is the *collector*: it holds the Spotify tokens, polls every 20 minutes, runs the
connectors, and owns the only writer to the DuckDB file. The container is the *analyst*: the same UI and the same
read-only query layer, served over HTTP from a machine that never sleeps, plus Ask the Archive against an Ollama on
the host. That split is deliberate — connectors need OS-keyring secrets and a browser for OAuth, neither of which
belongs in a container, and DuckDB only allows one process to write a file.

```
 desktop app (Tauri)  ──writes──▶  deep-cuts.duckdb  ──copy / sync / read-only mount──▶  container: dev-server.mjs
   Spotify · Last.fm                                                                       ├─ serves dist/ (the UI)
   MusicBrainz · LRCLIB                                                                    ├─ /api/<command>  (query bridge)
   scheduler · rebuild                                                                     └─ proxies /api/llm_* → Ollama on the host
```

## Run it
```sh
# from the repo root
docker compose -f docker/docker-compose.yml up -d --build
# → http://localhost:4747   (LAN: http://<host-ip>:4747)
```
`DEEPCUTS_DATA` (compose variable, default `./data`) is the folder that holds `deep-cuts.duckdb`.

## Getting the record into the container — three options
1. **Copy on a schedule (recommended).** A cron/systemd timer on the desktop machine copies `deep-cuts.duckdb` into the
   compose volume (rsync works; the file is a single-writer DuckDB database so copy the `.duckdb` *and* any `.wal`
   sibling together, ideally right after a Settings → *Export all plays* so the WAL is empty). The container sees new
   plays within one copy interval; everything is rebuildable from the file.
2. **Read-only over a synced folder.** Set `DEEPCUTS_READONLY=1` and point the volume at the desktop app's live data
   folder via Syncthing / a network share. The container never writes, so it can't corrupt the file, and every write
   action (settings, feedback, re-filing) answers "make the change in the desktop app". DuckDB's read-only mode still
   needs the writer to have checkpointed; if a page errors, wait for the desktop app's next idle checkpoint.
3. **Container as primary (future).** A headless Rust core with the scheduler and connectors inside the container
   is the path to "the container collects too". The seams already exist (`AppState` owns the scheduler; the query
   bridge is process-agnostic). It needs a way to complete Spotify OAuth without a desktop browser and a keyring
   substitute — both open design questions, not code gaps.

## Ollama
`OLLAMA_URL` tells the server where to proxy `llm_status` / `llm_chat`. On Linux Docker Engine the compose file adds
`host.docker.internal:host-gateway` so the default `http://host.docker.internal:11434` reaches an Ollama listening on
the host. Ollama must accept non-loopback connections: `OLLAMA_HOST=0.0.0.0 ollama serve` (or the systemd override).
Nothing is sent anywhere else — the model runs where you installed it.

## Security posture
- No authentication. Bind to a trusted LAN or put it behind your reverse proxy with auth (Tailscale, Caddy + basic
  auth). The API accepts arbitrary SQL from the UI — read-only enforced server-side, but it *reads everything*.
- The image contains no secrets: no Spotify tokens, no API keys. Connectors don't exist in it.
- The `/_health` endpoint reports the DB path and read-only flag, nothing else.

## Environment reference
| Var | Default | Meaning |
|---|---|---|
| `DEEPCUTS_DB` | `/data/deep-cuts.duckdb` | The record |
| `DEEPCUTS_STATIC` | `/app/dist` | Built UI to serve; unset to run API-only |
| `DEEPCUTS_READONLY` | unset | `1` opens the file read-only and refuses write commands |
| `DEEPCUTS_TZ` | `UTC` | Zone for wall-clock computations (match the desktop app) |
| `OLLAMA_URL` | `http://host.docker.internal:11434` | Where Ask the Archive sends prompts |
| `HOST` / `PORT` | `0.0.0.0` / `4747` | Bind address |

## What the container can and cannot do
Can: every page, every chart, Ask the Archive, the Crate, playlist *previews*, exports as HTML, share cards.
Cannot: create Spotify playlists, queue tracks, import a new export into the *desktop's* record, run connectors.
Those buttons explain themselves when pressed.

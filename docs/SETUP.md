# Deep Cuts — setup guide

Two routes to a running app. Use **A** to get installers without compiling anything yourself; use **B** to develop and run locally on Mint. Most people do both: B for day-to-day, A for the Windows portable build.

---

## A. GitHub route (installers for Linux and Windows, no local compile)

You need a GitHub account (you have `jbritt0n`) and `git` on the Mint machine (`sudo apt install git`).

### 1. Create the repository (once)
1. Go to https://github.com/new
2. Repository name: `deep-cuts` · Private is fine · **do not** tick "Add a README" or ".gitignore" (the folder already has them).
3. Create.

### 2. Push this folder (once)
```bash
cd ~/deep-cuts-v3            # wherever you unzipped
git init -b main
git add .
git commit -m "Deep Cuts v3"
git remote add origin https://github.com/jbritt0n/deep-cuts.git
git push -u origin main
```
GitHub will ask you to sign in; use a personal access token as the password if prompted (Settings → Developer settings → Personal access tokens → Generate, scope `repo`), or install the `gh` CLI and run `gh auth login`.

### 3. Let Actions build
Open https://github.com/jbritt0n/deep-cuts/actions. The **build** workflow starts on its own; it takes roughly 15–25 minutes the first time (DuckDB compiles on GitHub's machines, not yours). When both jobs are green, click the run → **Artifacts**:

| Artifact | Contents |
|---|---|
| `deep-cuts-Linux` | `Deep Cuts_3.0.0_amd64.AppImage`, `Deep Cuts_3.0.0_amd64.deb`, `portable.flag` |
| `deep-cuts-Windows` | `Deep Cuts_3.0.0_x64-setup.exe`, `DeepCuts-portable-windows.zip` |

Actions is free for private repos up to 2,000 minutes/month; each full build uses ~40. If a job fails, open it, expand the red step, and paste the last ~50 lines back to me.

### 4. Install
- **Mint**: `sudo apt install ./Deep\ Cuts_3.0.0_amd64.deb`, or `chmod +x` the AppImage and double-click it. For portable Linux, keep `portable.flag` next to the AppImage.
- **Windows**: run the `-setup.exe` (installs to your user profile, no admin), **or** unzip `DeepCuts-portable-windows.zip` anywhere and run `DeepCuts.exe` — no installation, data stays in `data\` beside it. WebView2 is already on Windows 10/11.

### 5. Updating later
After each new drop: unzip over the folder, then
```bash
git add . && git commit -m "update" && git push
```
Actions rebuilds. To publish a versioned release with all files attached: `git tag v3.0.1 && git push --tags`.

---

## B. Local route (develop and run on Mint)

### 1. Setup — one command
```bash
cd ~/deep-cuts-v3 && ./setup-linux.sh
```
Installs WebKitGTK and friends, Rust, Node 20, npm packages. Re-run any time. If `apt update` complains about Spotify's repo, the script disables that source (it's the Spotify desktop app's, not ours).

### 2. Disk space — read this before compiling
The bundled DuckDB build needs **10–15 GB free** for `src-tauri/target/`. Options:
- Free the space, or
- Put the build directory on a bigger drive: `export CARGO_TARGET_DIR=/mnt/bigdrive/deep-cuts-target` (add to `~/.bashrc`), or
- Skip compiling DuckDB entirely (fast, ~300 MB) — see "Prebuilt DuckDB" below.

If a build dies with "No space left on device", run `cargo clean` inside `src-tauri/` (or delete the target dir) before retrying; a half-written target directory wastes gigabytes.

### 3. Check your data without Rust (2 minutes)
No export handy? `python3 scripts/seed_dev_db.py` builds the dev database from the demo seed instead. Run the whole test stack with `npx tsc --noEmit && npm test && python3 scripts/test_sql_fixtures.py` — the same thing CI runs on every push.

```bash
python3 scripts/validate_sql.py "/path/to/Spotify Extended Streaming History"
python3 scripts/test_sql_fixtures.py
npm run dev:browser          # then open http://localhost:1420
```

### 4. Run the desktop app
```bash
npm run tauri dev            # first compile 20–60 min (DuckDB); after that, seconds
```
Then, in the app: drop your export on the welcome screen → Services → connect Spotify (below), Last.fm, MusicBrainz → Settings → Skin, Lyric themes.

### 5. Build packages locally
```bash
./build-linux.sh             # AppImage + .deb → dist-packages/
```
Windows must be built on Windows (`build-windows.ps1`) — or use route A.

### Prebuilt DuckDB (optional shortcut)
```bash
cd ~/Downloads && wget https://github.com/duckdb/duckdb/releases/download/v1.5.5/libduckdb-linux-amd64.zip
mkdir -p ~/duckdb-lib && unzip -o libduckdb-linux-amd64.zip -d ~/duckdb-lib
echo 'export DUCKDB_LIB_DIR=$HOME/duckdb-lib DUCKDB_INCLUDE_DIR=$HOME/duckdb-lib LD_LIBRARY_PATH=$HOME/duckdb-lib:$LD_LIBRARY_PATH' >> ~/.bashrc && source ~/.bashrc
```
In `src-tauri/Cargo.toml` change the duckdb line to `features = ["json", "parquet", "chrono"]` (remove `"bundled"`). Keep `bundled` in the copy you push to GitHub, or the CI build will fail.

---

## C. Connecting services (inside the app)

**Spotify** (2 minutes, once)
1. https://developer.spotify.com/dashboard → Create app. Name anything. Redirect URI: `http://127.0.0.1:8888/callback` (the IP, not localhost). APIs used: Web API.
2. Copy the **Client ID** → Deep Cuts → Services → Spotify → paste → Save → **Connect**. Your browser opens; approve; the tab says "Deep Cuts is connected".
3. Plays arrive every 20 minutes. Close the window and it keeps running from the tray.

**Last.fm**: https://www.last.fm/api/account/create → any name → copy the API key → Services → Last.fm → username + key → Connect. (Regenerate the key you pasted into our chat earlier.)

**MusicBrainz**: Services → Connect. No account.

**stats.fm**: stats.fm → Settings → API → copy your key → Services → Connect. Full history needs stats.fm Plus.

**Lyric themes**: Settings → Lyric themes → enable. Free (LRCLIB), no key; only derived themes are kept.

**Heard in the Wild** (Phase 8 — songs your phone recognises out in the world)
1. On the phone: install **Pano Scrobbler**, sign it in to Last.fm, enable scrobbling for **Now Playing** (Pixel ambient recognition) and **Shazam**.
2. **Give Pano its own Last.fm account** — one that Spotify does not scrobble to — and turn Spotify off in Pano's app list. This is the real defence: the app's duplicate check can only catch plays that already reached your record, and on a quota-tight day they may not have. If you set it up on your main account first, use *Purge & re-point to another account…* on the card afterwards.
3. In Deep Cuts: Last.fm must be connected (the key is reused). Services → Heard in the Wild → enter the account Pano writes to (blank = same as Last.fm above) → keep *Since* at today unless the account is Pano-only → **Set up** → **Sync now**.
4. Captures land on the **Heard in the Wild** page every 30 minutes. They never count toward hours, streaks or records. The card's *dropped* counter is how many captures were your own Spotify playback being overheard — it should be near zero if step 2 is right.

**Local LLM (for the later phase)**: `curl -fsSL https://ollama.com/install.sh | sh`, then `ollama pull qwen2.5:1.5b` and `ollama pull llama3.2:1b`. Confirm with `curl http://127.0.0.1:11434/api/tags`. Nothing else to do until the LLM phase ships.

---

## D. How data flows and refreshes
- **Import** is manual: drop a newer export any time; only new plays are added (dedupe on timestamp + track + length).
- **Live plays**: the Spotify poller runs every 20 min while the app or tray is up; each new play is checked against your export with a ±2 s tolerance, so nothing double-counts.
- **Enrichment** trickles in the background under Spotify's quota; Last.fm/MusicBrainz/cover art/lyrics every few minutes; Heard in the Wild every 30 min; stats.fm every 6 h; a full rebuild + Parquet backup nightly at 03:30.
- **Heard in the Wild** captures are a separate event class (`wild_play`). Each one is checked at import against your primary plays: if you were streaming the same artist at that moment, the capture is dropped as your own speakers being overheard. Nothing in the core record ever reads them.
- **The UI refreshes itself**: every background job emits `data:changed`; open pages re-query. Manual: Services → *Sync now*, tray → *Check Spotify now*, Settings → *Rebuild everything*.
- **Backups**: `backups/` inside the data folder (Settings shows the path). `events-*.parquet` files are the raw log; everything else can be rebuilt from them.

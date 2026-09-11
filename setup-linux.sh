#!/usr/bin/env bash
# Deep Cuts — one-command setup for Linux Mint / Ubuntu.
# Installs the Tauri system libraries, Rust (if missing), Node 20 (if missing),
# then the project's npm dependencies. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }

say "Checking apt sources"
# A stale Spotify desktop repo key breaks `apt update` for everyone; neutralise it if present.
if ls /etc/apt/sources.list.d/spotify* >/dev/null 2>&1 && ! apt-get update -o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts=/etc/apt/sources.list.d >/dev/null 2>&1; then
  echo "  Spotify's apt repository has a broken key; disabling it (this does not affect the Spotify app)."
  sudo mv /etc/apt/sources.list.d/spotify.list /etc/apt/sources.list.d/spotify.list.disabled 2>/dev/null || true
fi

say "System libraries for Tauri 2 (WebKitGTK 4.1) and DuckDB"
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file pkg-config \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf cmake python3 python3-pip \
  libsecret-1-dev libdbus-1-dev

if ! command -v cargo >/dev/null 2>&1; then
  say "Installing Rust (rustup, stable)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
# shellcheck disable=SC1091
source "$HOME/.cargo/env"
rustup update stable >/dev/null
echo "  rustc $(rustc --version | cut -d' ' -f2) (need ≥ 1.85)"

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  say "Installing Node 20 via nvm"
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"; # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"; nvm install 20; nvm use 20
fi
echo "  node $(node -v)"

say "Project dependencies"
npm install --no-audit --no-fund
pip3 install --user --break-system-packages duckdb pytz >/dev/null 2>&1 || pip3 install --user duckdb pytz >/dev/null 2>&1 || true

say "Done. Next:"
cat <<'TXT'
  python3 scripts/validate_sql.py "/path/to/Spotify Extended Streaming History"   # 2-minute SQL check, no Rust
  npm run dev:browser                                                             # UI in your browser
  npm run tauri dev                                                               # the desktop app (first compile 5–15 min)
  ./build-linux.sh                                                                # AppImage + .deb in dist-packages/
TXT

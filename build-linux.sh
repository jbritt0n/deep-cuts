#!/usr/bin/env bash
# Build the Linux packages (AppImage + .deb) and a portable folder.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null || true
npm run tauri build -- --bundles appimage,deb
mkdir -p dist-packages
cp src-tauri/target/release/bundle/appimage/*.AppImage dist-packages/ 2>/dev/null || true
cp src-tauri/target/release/bundle/deb/*.deb dist-packages/ 2>/dev/null || true
# Portable Linux: the AppImage plus a portable.flag beside it keeps data next to the file.
touch dist-packages/portable.flag
echo; echo "Packages in dist-packages/:"; ls -la dist-packages/
echo; echo "Install:   sudo apt install ./dist-packages/*.deb    (or chmod +x the AppImage and run it)"
echo "Portable:  keep portable.flag next to the AppImage → data lives in ./data beside it"

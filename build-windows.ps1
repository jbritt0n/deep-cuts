# Deep Cuts — Windows build: NSIS installer + self-contained portable .exe.
# Run from a Windows machine with Rust (rustup, MSVC toolchain), Node 20 and VS Build Tools installed:
#   powershell -ExecutionPolicy Bypass -File .\build-windows.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
npm install --no-audit --no-fund
npm run tauri build -- --bundles nsis
New-Item -ItemType Directory -Force dist-packages | Out-Null
Copy-Item src-tauri\target\release\bundle\nsis\*.exe dist-packages\ -Force
# Portable: the bare exe runs without installation. portable.flag beside it keeps data in .\data.
# WebView2 is preinstalled on Windows 10 (1803+) and 11; the installer bundles its bootstrapper for older machines.
$portable = "dist-packages\DeepCuts-portable"
New-Item -ItemType Directory -Force $portable | Out-Null
Copy-Item src-tauri\target\release\deep-cuts.exe "$portable\DeepCuts.exe" -Force
New-Item -ItemType File -Force "$portable\portable.flag" | Out-Null
Set-Content "$portable\README.txt" "Deep Cuts portable. Run DeepCuts.exe. Your data stays in the data\ folder next to it. Delete portable.flag to use %APPDATA%\DeepCuts instead."
Compress-Archive -Path "$portable\*" -DestinationPath "dist-packages\DeepCuts-portable-windows.zip" -Force
Write-Host "`nBuilt:"; Get-ChildItem dist-packages

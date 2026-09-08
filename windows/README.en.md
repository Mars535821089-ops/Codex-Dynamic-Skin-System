# Windows installation

If this project helps you, a Star is a welcome way to support continued compatibility work.

## Requirements

- Windows 10 or 11 with the official Codex Desktop Store application launched once
- Node.js 22 or newer for source installation
- PowerShell 5.1 or newer
- The installer currently bundles x64 Node.js; native ARM64 installer acceptance is not claimed.

## Install from source

1. Save your work and exit all Codex windows and the existing Dream Skin tray.
2. In PowerShell at the repository root, run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned`, then `& ".\windows\scripts\install-dream-skin.ps1"`.
3. Launch from the generated **Codex Dream Skin** desktop or Start-menu shortcut.
4. Use the in-app theme center to import images, GIFs, MP4/WebM or theme ZIPs, switch/delete themes, choose a library directory and persist settings. `theme-windows.ps1` is an internal function library, not an interactive command.
5. To use the ordinary Codex icon, enable **Auto-inject on normal Codex launch (idle restart only)** in the system tray. Also enable **Launch at login** to keep observation after a computer restart.
6. For a complete restore that leaves Codex closed, run `& ".\windows\scripts\restore-dream-skin.ps1" -RestoreBaseTheme -NoRelaunch` in PowerShell.

A healthy injector is never reapplied on a timer. Ordinary launches get a 10-second grace period. Active tasks, unknown activity or ambiguous process identity block automatic restart. An attempt is latched to prevent restart loops. Pause is respected, a closed Codex stays closed, and background video is disabled by default.

User themes and state are stored below `%LOCALAPPDATA%\CodexDreamSkin`. The injector validates the selected official application and does not patch its packaged source.

Video import/posters and some thumbnail conversions require `ffmpeg.exe` on PATH. A missing converter produces an actionable error and leaves the current theme intact.

## Releases and updates

Update checks use `Mars535821089-ops/Codex-Dynamic-Skin-System`, configured through `githubRepository` in `repository.json`.

See [full installation, safety and verification details](../docs/install-windows.md) and [中文](README.md).

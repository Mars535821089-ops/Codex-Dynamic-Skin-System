# Windows installation

## Requirements

- Windows 10 or 11 with the official Codex Desktop application launched once
- Node.js 22 or newer for source installation
- PowerShell 5.1 or newer

## Install from source

1. Close only the Codex instance you intend to theme.
2. Run `windows/scripts/install-dream-skin.ps1`.
3. Use the **Codex Dream Skin** icon in the Windows system tray (notification area) to import or select a theme. `theme-windows.ps1` is an internal function library, not an interactive command.
4. For a complete restore that leaves Codex closed, run `& ".\windows\scripts\restore-dream-skin.ps1" -RestoreBaseTheme -NoRelaunch` in PowerShell.

User themes and state are stored below `%LOCALAPPDATA%\CodexDreamSkin`. The injector validates the selected official application and does not patch its packaged source.

## Releases and updates

Update checks use `Mars535821089-ops/Codex-Dynamic-Skin-System`, configured through `githubRepository` in `repository.json`.

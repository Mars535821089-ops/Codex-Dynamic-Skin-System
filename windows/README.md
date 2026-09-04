# Windows installation

## Requirements

- Windows 10 or 11 with the official Codex Desktop application launched once
- Node.js 20 or newer for source installation
- PowerShell 5.1 or newer

## Install from source

1. Close only the Codex instance you intend to theme.
2. Run `windows/scripts/install-dream-skin.ps1`.
3. Run `windows/scripts/theme-windows.ps1` to import or select a theme.
4. Run `windows/scripts/restore-dream-skin.ps1` to return to the native appearance.

User themes and state are stored below `%LOCALAPPDATA%\CodexDreamSkin`. The injector validates the selected official application and does not patch its packaged source.

## Releases and updates

This source tree intentionally has no third-party release URL. Before publishing binaries, set `githubRepository` in `repository.json` to your own `owner/repository`. Update checks remain disabled until that value is configured.

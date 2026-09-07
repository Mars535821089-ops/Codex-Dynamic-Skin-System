# Windows installation

## Requirements

- Windows 10 or 11 with the official Codex Desktop application launched once
- Node.js 22 or newer for source installation
- PowerShell 5.1 or newer
- A standard user account; elevation is not required for the per-user installation

## Install from source

1. Launch Codex once, then close every Codex window and exit the Dream Skin tray if it is already running.
2. Open PowerShell in the cloned repository. Allow the checked-out scripts for this PowerShell process only, then install:

   ```powershell
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
   & ".\windows\scripts\install-dream-skin.ps1"
   ```

3. Start Codex from the generated **Codex Dream Skin** desktop or Start-menu shortcut. The shortcut asks before closing an already open Codex window.
4. Use the **Codex Dream Skin** icon in the Windows system tray (notification area) to import, select, pause, or resume a theme. `theme-windows.ps1` is an internal function library, not an interactive command.

The installer does not silently restart Codex. It creates per-user launch and tray shortcuts by default and starts only the system tray controller. Pass `-NoShortcuts` for an engine-only installation. A machine-wide execution-policy change and `Run as administrator` are not required; organization-managed policy can still prevent local scripts from running.

User themes and state are stored below `%LOCALAPPDATA%\CodexDreamSkin`. The injector validates the selected official application and does not patch its packaged source.

Video background playback is disabled by default to reduce GPU and CPU use while Codex is not active. If you enable it in the theme center, restart the themed Codex session once so the required process capability can take effect. Turning it back off also takes full effect after the next restart.

## Restore or uninstall

Close Codex, then restore the native appearance without relaunching it:

```powershell
& ".\windows\scripts\restore-dream-skin.ps1" -RestoreBaseTheme -NoRelaunch
```

To restore and also remove installed shortcuts and engine files:

```powershell
& ".\windows\scripts\restore-dream-skin.ps1" -RestoreBaseTheme -Uninstall -NoRelaunch
```

If Codex is open, use `-PromptRestart` to require an interactive confirmation before closing it. `-ForceRestart` is non-interactive and should only be used when that restart is explicitly intended. Restore removes the saved themed session, so no background injector should bring the theme back afterward.

## Releases and updates

This source tree intentionally has no third-party release URL. Before publishing binaries, set `githubRepository` in `repository.json` to your own `owner/repository`. Update checks remain disabled until that value is configured.

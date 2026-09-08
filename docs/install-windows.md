# Windows installation

## Requirements

- Windows 10 or 11 with the official Codex Desktop Store application launched once
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

See the automatic-injection controls and media behavior below before enabling unattended restart correction.

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

Update checks use `Mars535821089-ops/Codex-Dynamic-Skin-System`, configured in `windows/repository.json` and included in the installed engine. A fork should set that value to its own `owner/repository` before publishing. Checks do not install an update silently.

## Automatic injection after opening Codex

The tray observes only the default Codex profile. It does not launch Codex while it is closed, and its observer exits when the tray exits. A healthy injector is left alone; it is not reapplied on a timer. A missing injector can be repaired on an already verified local debugging endpoint without restarting Codex. **Pause** remains paused.

For automatic injection when using the ordinary Codex icon, enable **Auto-inject on normal Codex launch (idle restart only)** in the tray. This is separate from **Launch at login**; enable both to retain the behavior after a computer restart. The normal launch gets a 10-second grace period, followed by a check of local task lifecycle records. Only confirmed idle state allows one graceful restart with the required debugging flags. Running tasks, missing or ambiguous evidence, an isolated profile, and ambiguous process identity prevent automatic restart. An attempt is recorded before acting, with a restart latch until an actual app close is observed; failed repairs have a five-minute cooldown. The observer never runs an AI CLI or submits a chat message.

Use the generated **Codex Dream Skin** shortcut for a direct themed launch without normal-launch correction. If a Store build does not expose a usable local debugging endpoint, the injector fails closed; it does not modify the Store package, ACLs, or security settings. Inspect `%LOCALAPPDATA%\CodexDreamSkin\autostart-status.json` and the injector logs for the last reason.

## Theme center and media

The in-app theme center uses the same renderer, settings contract, media checks and performance policy as macOS. It supports images (PNG/JPEG/WebP), GIF animation, MP4/WebM video, validated theme ZIPs, switching and deleting imported themes, and choosing a theme-library directory. Native Windows file/folder pickers are used. Settings and theme selection are persisted locally; imports are validated before activation, and a failed directory migration keeps the original library recoverable.

Closing or hiding Codex pauses background video by default. No background-playback flag is added unless the user enables that setting. Avoid large high-resolution loops when low GPU usage is important.

Media conversion is optional for static images but required for video import/posters and some thumbnail conversions: install `ffmpeg.exe` and put it on PATH. If unavailable, the operation reports the missing dependency and preserves the previous theme. Large videos are normalized to the same 1280×720 / 24fps budget used by the Mac importer.

## Verification scope

The current installer bundles a pinned, SHA-256-verified **x64** Node.js runtime. Native Windows ARM64 installer acceptance is not claimed. CI runs Windows PowerShell 5.1 and PowerShell 7, including shared runtime tests and disposable-process lifecycle regressions. These automated checks are distinct from testing Codex's real Store UI on a particular device/build.

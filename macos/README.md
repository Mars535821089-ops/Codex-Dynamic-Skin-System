# macOS installation

## Requirements

- macOS with the official Codex Desktop application already launched once
- Node.js 20 or newer for source installation

## Install from source

1. Quit only the Codex instance you intend to theme.
2. Run `macos/Install Codex Dream Skin.command`.
3. Run `macos/Customize Codex Dream Skin.command` to import or select a theme.
4. Run `macos/Restore Codex Dream Skin.command` to remove the injected session and return to the native appearance.

The engine stores user themes under `~/Library/Application Support/CodexDreamSkinStudio` and does not modify `app.asar`.

The installer also registers a per-user background monitor. By default it may
repair only the theme watcher of a Codex process that already has the verified
loopback debugging flags. It never quits, signals, restarts, or activates an
ordinary Codex process, and it preserves an intentional paused state.

Automatic restart of ordinary Codex is an elevated, explicit opt-in:

```bash
./macos/scripts/install-dream-skin-macos.sh --allow-automatic-codex-restart
```

With that flag, the background monitor may invoke the restart path, which asks
Codex to quit and can escalate to `TERM` and then `KILL` if it does not exit.
Do not enable it when unsaved work or another Codex session must be preserved.

Restore first suspends the monitor, completes the restore, and persists native
mode so the monitor cannot reapply the skin. A failed reinstall rolls back with
native mode still set; only a successful reinstall, or an explicit
`install-dream-skin-autostart.sh enable`, re-enables it. Uninstall also
preflights before suspending the monitor; if a later step fails, a monitor that
was running before the attempt is resumed. A successful uninstall removes the
monitor, state, logs, and native-mode marker together.

## Releases and updates

This source tree intentionally has no third-party release URL. Before publishing binaries, set `githubRepository` in `repository.json` to your own `owner/repository`. Update checks remain disabled until that value is configured.

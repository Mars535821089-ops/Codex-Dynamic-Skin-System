# macOS installation

## Requirements

- macOS with the official Codex Desktop application already launched once
- No separate Node.js installation; the installer uses the signed Node.js runtime bundled with Codex

## Install from source

1. Quit only the Codex instance you intend to theme.
2. Run `macos/Install Codex Dream Skin.command`.
3. Run `macos/Customize Codex Dream Skin.command` to import or select a theme.
4. Run `macos/Restore Codex Dream Skin.command` to remove the injected session and restore the pre-install base theme. This explicit launcher reopens Codex when the restore finishes; use the command-line form in `docs/install-macos.md` if Codex must stay closed.

The engine stores user themes under `~/Library/Application Support/CodexDreamSkinStudio` and does not modify `app.asar`.

Source archives and release archives use the checked-in `INSTALL-FILES.txt`
allowlist. The installer copies only listed regular files and rejects stale or
unsafe entries, so files added beside an extracted download are not installed.

The installer also registers a per-user background monitor. By default it may
repair only the theme watcher of a Codex process that already has the verified
loopback debugging flags. It never quits, signals, restarts, or activates an
ordinary Codex process, and it preserves an intentional paused state.

Automatic restart of ordinary Codex is an elevated, explicit opt-in:

```bash
./macos/scripts/install-dream-skin-macos.sh --allow-automatic-codex-restart
```

With that flag, the background monitor may invoke the restart path only after
the local Codex session records confirm that no task from the current app run
is active. It checks once in the monitor and again immediately before quitting
Codex. Active work, malformed records, multiple main processes, or any uncertain
state fail closed: the monitor defers the restart. An allowed restart asks Codex
to quit and can escalate to `TERM` and then `KILL` if it does not exit.

The monitor, activity guard, theme validation, and renderer recovery are fixed
local programs. They do not call a language model, a provider API, or consume
Tokens. They read only local process state, local session lifecycle events, and
local theme files.

Restore first suspends the monitor, completes the restore, and persists native
mode so the monitor cannot reapply the skin. A failed reinstall rolls back with
native mode still set; only a successful reinstall, or an explicit
`install-dream-skin-autostart.sh enable`, re-enables it. Uninstall also
preflights before suspending the monitor; if a later step fails, a monitor that
was running before the attempt is resumed. A successful uninstall removes the
monitor, state, logs, and native-mode marker together.

## When the theme disappears while tasks are running

Inspect the installed engine without changing the current application:

```bash
bash "$HOME/.codex/codex-dream-skin-studio/scripts/status-dream-skin-macos.sh" --json --deep
```

If the current Codex process still exposes its verified CDP endpoint, repair only
the external watcher with the port reported by status (9341 in this example):

```bash
bash "$HOME/.codex/codex-dream-skin-studio/scripts/start-dream-skin-macos.sh" --repair-watcher-only --port 9341
```

This repair verifies the endpoint before replacing the watcher. It does not
restart, activate, or reload Codex, and it refuses to continue if the endpoint is
unavailable. `cdpOk` alone is an HTTP reachability result; the repair additionally
checks that the listener belongs to Codex.

If Codex was opened normally without debugging enabled, starting another copy
with debugging arguments can forward the request to that existing process
without enabling the port. Repeated injection attempts cannot repair this
condition. Preserve running tasks; when you later choose to quit Codex, launch
it with `Start Codex Dream Skin.command`. Do not use `--restart-existing` during
a no-restart repair. A healthy background monitor does not by itself confirm
that the theme is active: the watcher and renderer must also verify successfully.

## Releases and updates

Update checks use `Mars535821089-ops/Codex-Dynamic-Skin-System`, configured through `githubRepository` in `repository.json`.

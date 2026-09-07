# macOS installation

## Requirements

- macOS with the official Codex Desktop application already launched once
- No separate Node.js installation; the installer uses the signed Node.js runtime bundled with the official Codex app
- A standard user account; `sudo` and administrator access are not required

## Install from source

1. Launch Codex once so it creates `~/.codex/config.toml`, then quit every Codex window.
2. In Terminal, change to the cloned repository and run:

   ```bash
   ./macos/scripts/install-dream-skin-macos.sh --no-launch
   ```

3. Start the themed session when you are ready:

   ```bash
   ./macos/scripts/start-dream-skin-macos.sh --prompt-restart
   ```

4. Import or select a theme with `macos/Customize Codex Dream Skin.command`, or use the installed menu-bar controls.

`--no-launch` completes installation without opening Codex. Omit it when you want the installer to open the themed session immediately. Desktop launchers are not created by default; add `--launchers` to the install command if you want them. The installer refuses to continue while Codex is open so the application cannot overwrite its configuration during the transaction.

The normal background monitor may repair a missing watcher, but it will not quit or restart an ordinary Codex process. The separate `--allow-automatic-codex-restart` option changes that safety policy and should only be used when unattended restart is explicitly wanted.

The engine stores user themes under `~/Library/Application Support/CodexDreamSkinStudio` and does not modify `app.asar`.

GitHub source archives and release archives include a checked-in
`macos/INSTALL-FILES.txt` allowlist. The installer copies only listed regular
files and rejects stale, duplicate, escaping, or symbolic-link entries. Files
added beside an extracted download are not copied into the managed engine.

Video background playback is disabled by default to reduce GPU and CPU use while Codex is not active. If you enable it in the theme center, restart the themed Codex session once so the required process capability can take effect. Turning it back off also takes full effect after the next restart.

The installer also registers a per-user background monitor. It restores the
theme watcher after a crash and prepares a normally launched Codex instance
for injection. When Codex already has the verified loopback debugging flags,
the repair path can replace only the watcher; it is not allowed to restart or
reactivate Codex. An intentional paused state is preserved. Uninstall removes
the monitor together with its state and logs.

## Restore or uninstall

Close Codex first, then restore its native appearance without reopening it:

```bash
./macos/scripts/restore-dream-skin-macos.sh --restore-base-theme
```

To restore the native appearance and remove the installed engine and generated launchers:

```bash
./macos/scripts/restore-dream-skin-macos.sh --restore-base-theme --uninstall
```

Add `--restart-codex` only when you explicitly want the restore command to close an active themed session and reopen Codex. A successful restore disables automatic reinjection; reinstalling or explicitly enabling the monitor is required before themes can return.

The repository's double-click `macos/Restore Codex Dream Skin.command` launcher is the explicit reopen variant: it passes both `--restore-base-theme` and `--restart-codex`. Use the Terminal command above when Codex must remain closed.

If macOS blocks a downloaded `.command` file, use the Terminal commands above. Do not bypass Gatekeeper for the Codex application itself.

## Releases and updates

This source tree intentionally has no third-party release URL. Before publishing binaries, set `githubRepository` in `repository.json` to your own `owner/repository`. Update checks remain disabled until that value is configured.

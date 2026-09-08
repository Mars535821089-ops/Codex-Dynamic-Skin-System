# Codex Dynamic Skin System

If this project makes your Codex workspace nicer, a Star helps other people discover it.

Codex Dynamic Skin System is a cross-platform dynamic theme center for Codex Desktop. It is intentionally limited to theme import, validation, storage, switching, and rendering. It does not include profile analytics, conversation-copy enhancements, or private integrations.

## Features

- Standalone macOS and Windows installers and injectors
- PNG, JPEG, WebP, GIF, MP4, and WebM themes
- Safe CSS validation, package validation, containment checks, and media limits
- Self-healing media ownership after navigation or React root replacement
- Local self-healing without model calls, provider APIs, or token use. If automatic restart is explicitly enabled, a new Codex launch gets a 10-second grace period; restart is allowed only when task activity is confirmed idle, is limited to once per fault cycle, and fails closed when activity is unknown
- Native UI preservation and recoverable failures

Video background playback is off by default so an inactive Codex window does not keep consuming extra GPU/CPU. Enabling it requires one Codex restart before the full background-playback capability is available, and it increases resource use.

Keep video themes at or below 1280×720 and 24fps. Both importers convert larger or higher-frame-rate inputs to H.264 MP4 using `ffmpeg` on PATH (`brew install ffmpeg` on macOS). Windows video poster generation also requires it; a missing converter leaves the current theme intact. Preprocess videos embedded in theme ZIPs to the same budget to avoid excessive decode and GPU load.

## Validation status

This release candidate has completed cross-platform source review and automated contract validation. Injection, media rendering, navigation recovery, and sustained low-overhead behavior have also been exercised in an isolated macOS instance. The Windows install, injection, recovery, uninstall, and portability paths have passed source review and automated regression coverage. No Windows machine was available, so the real Codex UI and signed installer have not been executed on Windows 10/11; that is a scope disclosure, not a known source defect. First-time users should still evaluate the project in a test environment.

Automated tests and CI configuration are not evidence of a successful native run. Save work before installation or upgrades, and use a separate test instance for live acceptance.

## Quick start

- macOS: run `macos/Install Codex Dream Skin.command`, then `macos/Customize Codex Dream Skin.command`. The explicit `macos/Restore Codex Dream Skin.command` launcher restores the pre-install base theme and reopens Codex when it finishes.
- Windows: install Node.js 22 or newer and run `windows/scripts/install-dream-skin.ps1`. Start Codex with the generated **Codex Dream Skin** shortcut and manage themes in the theme center or system tray. To automatically inject after an ordinary launch, enable **Auto-inject on normal Codex launch (idle restart only)** and **Launch at login** in the tray. For a complete restore that leaves Codex closed, run `& ".\windows\scripts\restore-dream-skin.ps1" -RestoreBaseTheme -NoRelaunch` in PowerShell.

See [macOS installation](docs/install-macos.md) and [Windows installation](docs/install-windows.md). macOS uses the signed Node.js runtime bundled with the official Codex app; Windows source installation requires Node.js 22 or newer.

## Development

```bash
node tools/sync-runtime-assets.mjs
node tools/sync-runtime-assets.mjs --check
node --test tools/*.test.mjs tools/tests/*.test.mjs macos/tests/*.test.mjs windows/tests/*.test.mjs
```

Run live acceptance only against an isolated Codex test instance, never an active working instance.

## License

See [LICENSE](LICENSE).

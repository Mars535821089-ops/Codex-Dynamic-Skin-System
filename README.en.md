# Codex Dynamic Skin System

If this project makes your Codex workspace nicer, a Star helps other people discover it.

Codex Dynamic Skin System is a cross-platform dynamic theme center for Codex Desktop. It is intentionally limited to theme import, validation, storage, switching, and rendering. It does not include profile analytics, conversation-copy enhancements, or private integrations.

## Features

- Standalone macOS and Windows installers and injectors
- PNG, JPEG, WebP, GIF, MP4, and WebM themes
- Safe CSS validation, package validation, containment checks, and media limits
- Self-healing media ownership after navigation or React root replacement
- Native UI preservation and recoverable failures

## Quick start

- macOS: run `macos/Install Codex Dream Skin.command`, then `macos/Customize Codex Dream Skin.command`.
- Windows: run `windows/scripts/install-dream-skin.ps1`, then `windows/scripts/theme-windows.ps1`.

See [macOS installation](docs/install-macos.md) and [Windows installation](docs/install-windows.md). Node.js 20 or newer is required.

## Development

```bash
node tools/sync-runtime-assets.mjs
node tools/sync-runtime-assets.mjs --check
node --test tools/*.test.mjs tools/tests/*.test.mjs macos/tests/*.test.mjs windows/tests/*.test.mjs
```

Run live acceptance only against an isolated Codex test instance, never an active working instance.

## License

See [LICENSE](LICENSE).

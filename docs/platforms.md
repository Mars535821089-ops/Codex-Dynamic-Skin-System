# Platform architecture

The macOS and Windows packages share the same validated browser runtime from `runtime/`. Platform folders own only discovery, process launch, local state, and packaging.

- macOS attaches to an isolated Codex process through a loopback DevTools port. It does not patch the signed application bundle.
- Windows launches the selected official package with a dedicated user-data directory and loopback DevTools port.
- The browser media layer owns one element outside the React root. A lifecycle supervisor restores that element after navigation or root replacement and removes stale generations, preventing disappearing themes and ghost overlays.
- Imported media is accepted only after path containment, signature, extension, dimension, count, and size validation.

Always run live acceptance in a disposable second Codex instance. Never aim test injection at an active work instance.

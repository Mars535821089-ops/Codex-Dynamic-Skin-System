# QA inventory

## User-visible claims

1. The home screen paints one UI-free wallpaper continuously across sidebar and main content, with a live native heading, the real project utility/composer surface, and any suggestion cards rendered by the current Codex host.
2. Sidebar, main area, header, and composer use coordinated readability layers; home remains expressive while normal task routes use a stronger quiet veil.
3. All real Codex controls remain interactive; the skin is not a screenshot overlay.
4. The skin survives route changes and renderer reloads while the injector daemon runs.
5. The official Store package and `app.asar` remain unchanged.
6. Restore removes the injected DOM/CSS and install/restore can be repeated.
7. Restore closes the saved CDP listener before reopening Codex normally.

## Functional checks

- Home feature card: click one card and confirm the real composer is populated or the normal action occurs.
- Project selector: click the real project chip under the "选择项目" label and confirm the native project menu opens.
- Sidebar: open a real task, then return to New Task.
- Task side panel: open and close the native thread panel twice, resize the window, and repeat; the toggle must remain visible and clickable.
- Composer: type text, verify caret/readability, then clear it without sending.
- Reload: use CDP `Page.reload`, wait, and confirm the injection marker returns.
- Pet overlay: open a desktop pet and confirm its auxiliary window stays transparent with no skin background or decoration layer behind it.
- Restore/reapply cycle: remove live skin, verify marker absent, apply again, verify marker present.
- Update resilience: resolve the current `OpenAI.Codex` Appx location dynamically for launch. A versioned path saved for cleanup must be revalidated against the registered package full/family identity before any process is stopped.
- Restart consent: an existing normal Codex window is never force-closed without explicit CLI authorization or shortcut confirmation.
- Shortcut policy: installed launch, restore, tray, and tray-child commands use `RemoteSigned` without `Bypass`; Internet-zone markers are removed only from hash-verified managed PowerShell copies.
- Config safety: Chinese project names, LF/CRLF choice, quoted target keys, table-header comments, and unrelated TOML sections survive install/selective restore; ambiguous target shapes fail unchanged, exact recovery keeps a copy of the replaced current file, and install refuses both registered and state-recorded old Codex processes.
- Theme safety: empty/over-10 MB images, over-16384px/50MP dimensions, path escapes, symlinks/junctions, malformed JSON, unsafe CSS, and unsupported formats are rejected before payload construction.
- Tray lifecycle: pause/resume reflects the clicked state, the bundled Gothic Void Crusade preset is present on first install, and complete restore terminates only the identity-verified tray and removes its login shortcut before it can reapply the skin.
- Theme center: import an image, GIF, video and ZIP; switch themes; restore native appearance; change settings and reopen the center. Verify persisted selection and settings, one media layer, and no periodic theme reapplication while healthy.
- Library: migrate both legacy and v2 themes, cancel a folder picker, disconnect a custom library, and inject copy/activation failures. Never remove the only valid source copy. Deleting a selected theme must activate a valid fallback first and remain recoverable from the library archive.
- Automatic startup: closed Codex stays closed; active/unknown tasks and withdrawn consent prohibit automatic restart. Simulate WMI failure, package-path changes, corrupt restart history and PID reuse. These must not clear restart history or close a running app. A debug endpoint outage must not trigger a plain-launch correction.
- Restart history: a fresh observer can clear a previous latch only after ten seconds of confirmed closure, an exclusive operation lock and a fresh empty inventory. A refusal before the worker requests a close must not permanently latch; an attempted close followed by failure must remain latched. A stale observer must not overwrite the worker's durable latch.
- PowerShell compatibility: zero, one and multiple matching processes must follow the same safety rules on PowerShell 5.1 and 7. A singleton process whose `Count` is null must still receive activity, consent and identity checks before one authorized non-force restart.

## Visual checks

- 1280x820 initial home: the declared focus stays in frame, the text-safe side remains readable, the real project utility row and composer form one coherent surface, and no horizontal scrolling appears.
- Narrower window: accept Codex's native responsive card reduction or omission; no essential control is covered and wallpaper cropping preserves the focus/safe-area contract.
- Normal task: the wallpaper is visibly quieter than home, messages keep high contrast, and composer does not overlap content.
- Inspect the sidebar, header, wallpaper edges, native card labels when present, project utility row, composer controls, scrollbar, dialogs, and menus.
- Reject black/transparent sidebar artifacts, clipped controls, duplicated/disconnected project labels, rasterized native controls, fake UI inside the wallpaper, weak contrast, or decorations intercepting clicks.

## Exploratory checks

- Start when the debug port is occupied: fail with a clear message or use a caller-selected port.
- Start after Codex updates: package discovery and injection still work without patching installed files.
- Tamper `state.json` with a reused PID: if the PID is still live but its identity differs, confirm cleanup fails closed and preserves `state.json`; if the PID is gone, confirm the stale record is replaced only after confirming no process is running, without stopping an unrelated process.
- Serve a fake `app://` CDP target or remote/mismatched WebSocket URL and confirm both launcher and injector reject it. Reuse the port with a new Browser ID and confirm the existing watcher exits without reconnecting.
- Force verification failure and confirm the injector, state file, and newly launched debug session are rolled back.
- Start two operations concurrently and confirm the second fails clearly without changing config, state, or processes.
- Close Codex without restore and confirm the Browser identity anchor closes and the watcher exits without reconnecting or rapidly growing logs.

## Automated checks

- `tests/run-tests.ps1`: strict UTF-8/no-BOM writes, UTF-16 rejection, LF/CRLF preservation, concurrent-write detection, exact backup/recovery, `[desktop]`-scoped restore, ambiguous TOML rejection, non-ASCII paths, Appx/state identity, argument quoting, theme seeding/import/save/switch/pause, canonical community-link and compatible-metadata rejection, fixed-origin download/apply boundaries, byte/dimension limits, junction rejection, payload construction, Browser ID, loopback URL rejection, and renderer isolation for transparent auxiliary windows.
- `node --check` for the injector and renderer payload.
- Windows CI runs both PowerShell 5.1 and PowerShell 7, parses all scripts, runs shared renderer regressions and bounded native/mock lifecycle suites. Each native suite has a timeout; missing suites are a failure.
- Interrupted theme replacement uses a disposable PowerShell child, verifies lock ownership and the backup boundary before terminating that exact child, and keeps a witness mutex handle alive for real abandoned-lock recovery. A blocked child must time out, be reaped and leave the original theme untouched; the fixture must not wait indefinitely for crash-reporting UI.
- Real Codex Store UI, screenshots and build-specific CDP behavior require a Windows device for separate visual acceptance. Automated source/process verification is not presented as that device-level signoff; no local virtual machine is needed for the source review and regression workflow.

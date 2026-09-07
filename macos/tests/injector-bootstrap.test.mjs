import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  appendDynamicModuleRevision,
  cancelPendingEarlyGeneration,
  cleanupExcludedSurface,
  earlyGenerationWaitOptions,
  earlyPayloadFor,
  isLoadedThemeOwnershipHealthy,
  isExcludedCdpSurfaceUrl,
  rendererActionRefreshPlan,
  waitForEarlyGenerationApplied,
} from "../scripts/injector.mjs";
import { cleanupExcludedSurface as cleanupExcludedSurfaceWindows } from "../../windows/scripts/injector.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const injectorPath = path.resolve(here, "../scripts/injector.mjs");
const source = await fs.readFile(injectorPath, "utf8");
const commonSource = await fs.readFile(path.resolve(here, "../scripts/common-macos.sh"), "utf8");
const startSource = await fs.readFile(path.resolve(here, "../scripts/start-dream-skin-macos.sh"), "utf8");
const shellSelector = 'main:is(.main-surface, [data-app-shell-main-surface], [class*="_MainContentSurface_"])';

const moduleRevisionDigest = (sha256) => appendDynamicModuleRevision(
  createHash("sha256").update("same-theme"),
  [{ name: "media-layer.js", sha256 }],
).digest("hex");
assert.notEqual(
  moduleRevisionDigest("a".repeat(64)),
  moduleRevisionDigest("b".repeat(64)),
  "A browser module change must create a new payload revision for hot reload.",
);

{
  assert.deepEqual(rendererActionRefreshPlan({ action: "save-settings" }), {
    refresh: false,
    directory: null,
    reason: null,
  });
  assert.deepEqual(rendererActionRefreshPlan(
    { action: "save-settings" },
    "/themes/starlight",
  ), {
    refresh: true,
    directory: "/themes/starlight",
    reason: "settings-and-theme-save",
    displayMode: "theme",
  });
}

assert.doesNotMatch(
  source,
  /watchFs\(settingsDirectory/,
  "Persisting Theme Center settings must not rebuild the selected theme media layer.",
);
assert.match(
  source,
  /Dynamic settings are persistence-only here\.[\s\S]*previously caused visible theme[\s\S]*flashing/,
  "The payload watcher must document why settings-file events are excluded.",
);
assert.match(
  source,
  /const mutatesRenderer = options\.mode === "once"[\s\S]*options\.mode === "remove"[\s\S]*options\.reload/,
  "One-shot apply/remove and reload verification must all be classified as renderer mutations.",
);
assert.match(
  source,
  /if \(mutatesRenderer\)[\s\S]*assertNoActiveWatcher[\s\S]*acquireWatcherLease[\s\S]*runOneShotAndExit\(options, mutationLease\)/,
  "Renderer mutations must hold the CDP ownership lease for their full lifetime.",
);
const hotReapplyStart = commonSource.indexOf("hot_reapply_theme() {");
const hotReapplyEnd = commonSource.indexOf("\n}\n\n# Always tear down", hotReapplyStart);
const hotReapplySource = commonSource.slice(hotReapplyStart, hotReapplyEnd);
assert.ok(hotReapplyStart >= 0 && hotReapplyEnd > hotReapplyStart,
  "The hot reapply function must remain extractable for ownership testing.");
assert.doesNotMatch(hotReapplySource, /--once/,
  "Hot reapply must restart the sole watcher instead of racing it with one-shot injection.");
assert.doesNotMatch(startSource, /--once/,
  "Startup recovery must never race the watcher with one-shot renderer mutation.");

function createFixture() {
  const domReady = [];
  const timers = new Map();
  const intervals = new Map();
  let nextTimer = 1;
  let nextInterval = 1;
  const markers = {
    shell: false,
    sidebar: false,
    main: false,
    settingsPanel: false,
    settings: false,
    genericInput: false,
    branding: false,
  };
  let root = {};
  const location = { protocol: "app:", pathname: "/index.html", search: "" };
  const context = {
    window: { installs: [] },
    location,
    URLSearchParams,
    document: {
      get documentElement() { return root; },
      addEventListener(type, callback) { if (type === "DOMContentLoaded") domReady.push(callback); },
      querySelector(selector) {
        if (selector === shellSelector) return markers.shell ? {} : null;
        if (selector === "aside.app-shell-left-panel") return markers.sidebar ? {} : null;
        if (selector === "[role=\"main\"]") return markers.main ? {} : null;
        if (selector === "main, [role=\"main\"]") return markers.main ? {} : null;
        if (selector === '[data-settings-panel-slug="general-settings"]') {
          return markers.settingsPanel ? {} : null;
        }
        if (selector.includes("textarea") || selector.includes("contenteditable") || selector.includes("textbox")) {
          return markers.genericInput ? {} : null;
        }
        if (selector.includes("appearance-theme") || selector.includes("theme-preview")) {
          return markers.settings ? {} : null;
        }
        if (selector.includes("app-shell-header-context-menu-surface")) {
          return markers.branding ? {} : null;
        }
        return null;
      },
    },
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) {
      const id = nextInterval++;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
  };
  return {
    context,
    markers,
    brandAsCodex() { markers.branding = true; },
    makeNotReady() { root = null; },
    makeReady() { root = {}; },
    setRoute(pathname, initialRoute = "") {
      location.pathname = pathname;
      location.search = initialRoute ? `?initialRoute=${encodeURIComponent(initialRoute)}` : "";
    },
    fireDomReady() { for (const callback of [...domReady]) callback(); },
    tick() { for (const callback of [...intervals.values()]) callback(); },
    observers: [],
  };
}

const guarded = createFixture();
vm.runInNewContext(earlyPayloadFor('window.installs.push("guarded")', "guarded"), guarded.context);
assert.deepEqual(guarded.context.window.installs, [], "Auxiliary app targets must remain untouched.");
assert.equal(guarded.observers.length, 0, "Early bootstrap must not install a broad MutationObserver.");
guarded.markers.shell = true;
guarded.tick();
assert.deepEqual(guarded.context.window.installs, [], "A shell without its sidebar is not sufficient for identity.");
guarded.markers.sidebar = true;
guarded.tick();
assert.deepEqual(guarded.context.window.installs, ["guarded"]);
guarded.fireDomReady();
assert.deepEqual(
  guarded.context.window.installs,
  ["guarded"],
  "DOMContentLoaded must not execute a generation that already succeeded through polling.",
);

const generic = createFixture();
vm.runInNewContext(earlyPayloadFor('window.installs.push("generic")', "generic"), generic.context);
generic.markers.main = true;
generic.markers.genericInput = true;
generic.tick();
assert.deepEqual(generic.context.window.installs, [],
  "An unbranded app:// page with generic main/input anchors must remain untouched.");
generic.brandAsCodex();
generic.tick();
assert.deepEqual(generic.context.window.installs, ["generic"],
  "A verified app:// Codex surface with generic main/input anchors must accept newer renderer shells.");

const settingsPanel = createFixture();
vm.runInNewContext(
  earlyPayloadFor('window.installs.push("settings-panel")', "settings-panel"),
  settingsPanel.context,
);
settingsPanel.markers.settingsPanel = true;
settingsPanel.tick();
assert.deepEqual(settingsPanel.context.window.installs, ["settings-panel"],
  "Codex 26.727 Settings must accept its stable general-settings panel without legacy appearance controls.");

const excludedEarly = createFixture();
excludedEarly.markers.settingsPanel = true;
excludedEarly.setRoute("/index.html", "/avatar-overlay");
vm.runInNewContext(
  earlyPayloadFor('window.installs.push("excluded")', "excluded"),
  excludedEarly.context,
);
excludedEarly.tick();
assert.deepEqual(excludedEarly.context.window.installs, [],
  "An avatar overlay route must reject the early payload even when it exposes Codex markers.");

const generations = createFixture();
generations.makeNotReady();
generations.markers.shell = true;
generations.markers.sidebar = true;
vm.runInNewContext(earlyPayloadFor('window.installs.push("old")', "old"), generations.context);
vm.runInNewContext(earlyPayloadFor('window.installs.push("new")', "new"), generations.context);
generations.makeReady();
generations.fireDomReady();
assert.deepEqual(
  generations.context.window.installs,
  ["new"],
  "A stale early script must yield to the newest watcher generation.",
);
assert.equal(generations.context.window.__CODEX_DREAM_SKIN_EARLY_APPLIED__, "new");

let earlyAppliedPolls = 0;
assert.equal(await waitForEarlyGenerationApplied({
  async evaluate() {
    earlyAppliedPolls += 1;
    return earlyAppliedPolls >= 3;
  },
}, "reload-generation", { timeoutMs: 100, pollMs: 1 }), true,
"Reload recovery must wait for the deferred early shell before staging active video blobs.");
assert.equal(earlyAppliedPolls, 3);

assert.deepEqual(
  earlyGenerationWaitOptions("Page.loadEventFired"),
  { timeoutMs: 1250, pollMs: 50 },
  "A renderer reload must fall back quickly instead of looking un-injected for ten seconds.",
);
let cancelledEarlyExpression = null;
assert.equal(await cancelPendingEarlyGeneration({
  async evaluate(expression) {
    cancelledEarlyExpression = expression;
    return vm.runInNewContext(expression, {
      window: { __CODEX_DREAM_SKIN_EARLY_GENERATION__: "stale-bootstrap-generation" },
    });
  },
}, "reload-generation"), true,
"A timed-out stale deferred shell must be cancelled before the current renderer payload is restored.");
assert.match(cancelledEarlyExpression, /__CODEX_DREAM_SKIN_EARLY_GENERATION__/);

const hiddenHealthyOwnership = {
  installed: true,
  version: "1.5.17",
  stylePresent: true,
  businessClassPollution: 0,
  themeId: "com.example.theme",
  revision: "revision-1",
  documentVisibility: "hidden",
  dynamic: { activation: "active", diagnostics: { phase: "active" } },
  dynamicRootCount: 1,
  dynamicVisibleRootCount: 0,
  documentOverflow: { x: false },
};
const ownershipPayload = {
  displayMode: "theme",
  sourceApiVersion: 2,
  theme: { id: "com.example.theme" },
  revision: "revision-1",
};
assert.equal(isLoadedThemeOwnershipHealthy(hiddenHealthyOwnership, ownershipPayload), true,
  "A background renderer with the exact active theme must remain healthy while presentation is concealed.");
assert.equal(isLoadedThemeOwnershipHealthy(
  { ...hiddenHealthyOwnership, documentVisibility: "visible" },
  ownershipPayload,
), false, "A foreground renderer with a concealed media root must still trigger recovery failure.");
assert.equal(isLoadedThemeOwnershipHealthy(
  { ...hiddenHealthyOwnership, dynamicRootCount: 0, dynamicVisibleRootCount: 0 },
  ownershipPayload,
), false, "A missing media root must still trigger recovery failure.");

const earlySource = earlyPayloadFor("", "source-contract");
assert.doesNotMatch(earlySource, /MutationObserver|childList|subtree/,
  "Early bootstrap must not observe the entire renderer DOM.");
assert.doesNotMatch(earlySource, /document\.title|document\.body\?\.innerText|location\.href/,
  "The early bootstrap must not read page title, body text, or the full URL.");
assert.match(earlySource, /initialRoute/,
  "The early bootstrap must fail closed on known transparent auxiliary routes.");
assert.match(earlySource, /DOMContentLoaded/);
assert.match(earlySource, /setInterval\(install, 250\)/);
const identityProbeStart = source.indexOf("async function probeSession");
const identityProbeSource = source.slice(identityProbeStart, identityProbeStart + 1800);
assert.ok(identityProbeStart >= 0, "The live target probe must remain covered by the identity test.");
const probePrefix = "return session.evaluate(`";
const probePayloadStart = source.indexOf(probePrefix, identityProbeStart) + probePrefix.length;
const probePayloadEnd = source.indexOf("`);", probePayloadStart);
assert.ok(probePayloadStart >= probePrefix.length && probePayloadEnd > probePayloadStart,
  "The live identity expression must remain extractable for behavioral testing.");
const probeTemplate = source.slice(probePayloadStart, probePayloadEnd);
assert.doesNotMatch(probeTemplate, /`/, "The live identity expression must not contain nested template literals.");
const liveProbePayload = vm.runInNewContext(`\`${probeTemplate}\``, {
  selectorLiteral: (key) => JSON.stringify(`[selector-${key}]`),
  stableTestidLiteral: (key) => JSON.stringify(`[data-testid="${key}"]`),
});
const runLiveProbe = ({
  protocol = "app:", settingsPanel: hasSettingsPanel = false,
  genericMain = false, genericInput = false, branding = false,
  pathname = "/index.html", initialRoute = "",
} = {}) => vm.runInNewContext(liveProbePayload, {
  location: {
    protocol,
    pathname,
    search: initialRoute ? `?initialRoute=${encodeURIComponent(initialRoute)}` : "",
  },
  URLSearchParams,
  document: {
    querySelector(selector) {
      if (selector === "[selector-settings-panel]") return hasSettingsPanel ? {} : null;
      if (selector === 'main, [role="main"]') return genericMain ? {} : null;
      if (selector === 'textarea, [contenteditable="true"], [role="textbox"]') {
        return genericInput ? {} : null;
      }
      if (selector === '[data-testid="app-shell-header-context-menu-surface"]') {
        return branding ? {} : null;
      }
      return null;
    },
  },
});
assert.equal(runLiveProbe({ settingsPanel: true }).codex, true,
  "The live probe must accept the Codex 26.727 general Settings panel on app://.");
assert.equal(runLiveProbe({ protocol: "https:", settingsPanel: true }).codex, false,
  "The Settings marker must never identify a non-app target.");
assert.equal(runLiveProbe({ genericMain: true, genericInput: true }).codex, false,
  "The live probe must reject an unbranded generic app target.");
assert.equal(runLiveProbe({ genericMain: true, genericInput: true, branding: true }).codex, true,
  "The live probe may accept generic anchors only with the stable Codex branding marker.");
const avatarOverlayProbe = runLiveProbe({ settingsPanel: true, initialRoute: "/avatar-overlay" });
assert.equal(avatarOverlayProbe.excludedPetSurface, true);
assert.equal(avatarOverlayProbe.codex, false,
  "The avatar overlay must never be treated as the primary Codex renderer.");
const petCompositionProbe = runLiveProbe({
  settingsPanel: true, pathname: "/avatar-overlay-composition-surface.html",
});
assert.equal(petCompositionProbe.excludedPetSurface, true);
assert.equal(petCompositionProbe.codex, false,
  "Pet composition surfaces must stay outside the Dream Skin target set.");
assert.equal(isExcludedCdpSurfaceUrl("app://-/index.html?initialRoute=%2Favatar-overlay"), true,
  "The transparent avatar window must be rejected before any skin script is registered.");
assert.equal(isExcludedCdpSurfaceUrl("app://-/avatar-overlay-composition-surface.html"), true,
  "Pet composition surfaces must be rejected before any skin script is registered.");
assert.equal(isExcludedCdpSurfaceUrl("app://-/index.html"), false,
  "The primary Codex renderer must remain eligible.");
const cleanupEvaluations = [];
assert.equal(await cleanupExcludedSurface({
  async evaluate(expression) { cleanupEvaluations.push(expression); return true; },
}), true, "Excluded Pet cleanup must remove and verify stale renderer state.");
assert.equal(cleanupEvaluations.length, 2);
assert.match(cleanupEvaluations[0], /__CODEX_DREAM_SKIN_DISABLED__/);
assert.match(cleanupEvaluations[0], /delete window\.__CODEX_DYNAMIC_SKIN_THEME_REQUEST__/,
  "Excluded surfaces must discard stale theme requests before cleanup can return early.");
assert.match(cleanupEvaluations[0], /delete window\.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__/,
  "Excluded surfaces must discard stale host-action requests before cleanup can return early.");
assert.match(cleanupEvaluations[1], /hasAttributes/);

async function assertAsyncCleanupAwaited(cleanupSurface) {
  const cleanupContext = {
    window: {},
    document: {
      documentElement: { attributes: [], style: [] },
      adoptedStyleSheets: [],
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getElementById() { return null; },
    },
  };
  let releaseCleanup;
  cleanupContext.window.__CODEX_DREAM_SKIN_STATE__ = {
    cleanup() {
      delete cleanupContext.window.__CODEX_DREAM_SKIN_STATE__;
      return new Promise((resolve) => {
        releaseCleanup = () => {
          delete cleanupContext.window.__CODEX_DREAM_SKIN_STATE__;
          resolve(true);
        };
      });
    },
  };
  const cleanupOperation = cleanupSurface({
    async evaluate(expression) { return vm.runInNewContext(expression, cleanupContext); },
  });
  let settled = false;
  cleanupOperation.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const settledBeforeRelease = settled;
  const replacement = { generation: "replacement" };
  if (settledBeforeRelease) cleanupContext.window.__CODEX_DREAM_SKIN_STATE__ = replacement;
  releaseCleanup();
  assert.equal(await cleanupOperation, true);
  if (!settledBeforeRelease) cleanupContext.window.__CODEX_DREAM_SKIN_STATE__ = replacement;
  await Promise.resolve();
  assert.equal(settledBeforeRelease, false,
    "removeFromSession must await async cleanup before a replacement can be applied");
  assert.equal(cleanupContext.window.__CODEX_DREAM_SKIN_STATE__, replacement,
    "A late cleanup must not delete the replacement renderer state");
}

await assertAsyncCleanupAwaited(cleanupExcludedSurface);
await assertAsyncCleanupAwaited(cleanupExcludedSurfaceWindows);

async function assertRejectedAsyncCleanupFallsBack(cleanupSurface) {
  const cleanupContext = {
    window: {
      __CODEX_DREAM_SKIN_STATE__: {
        cleanup() { return Promise.reject(new Error("controlled cleanup failure")); },
      },
    },
    document: {
      documentElement: { attributes: [], style: [] },
      adoptedStyleSheets: [],
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getElementById() { return null; },
    },
  };
  const removed = await cleanupSurface({
    async evaluate(expression) { return vm.runInNewContext(expression, cleanupContext); },
  });
  assert.equal(removed, true,
    "A rejected async cleanup must use the existing safe fallback removal contract");
  assert.equal(cleanupContext.window.__CODEX_DREAM_SKIN_STATE__, undefined);
}

await assertRejectedAsyncCleanupFallsBack(cleanupExcludedSurface);
await assertRejectedAsyncCleanupFallsBack(cleanupExcludedSurfaceWindows);

assert.ok((source.match(/cleanupExcludedSurface\(/g) || []).length >= 4,
  "One-shot and watcher discovery must both clean excluded Pet targets, including stale layers.");
assert.match(identityProbeSource, /selectorLiteral\("settings-panel"\)/,
  "The live probe must retain the current Settings structural marker.");
assert.match(identityProbeSource, /return Boolean\(main && input && branded\)/,
  "The live target probe must require branding together with both generic anchors.");
assert.match(identityProbeSource, /app-shell-header-context-menu-surface/,
  "The live target probe must use a structural Codex branding marker.");
assert.doesNotMatch(identityProbeSource, /document\.title|document\.body\?\.innerText|location\.href/,
  "The live target probe must not read page title, body text, or URL.");
assert.doesNotMatch(identityProbeSource, /\(main && input\) \|\||\(main && branded\) \|\||\(input && branded\)/);
const discoveryLoopStart = source.indexOf("const cycleRecovery = activeOperation ? null : pauseRecovery");
const probeStart = source.indexOf("const probe = await waitForCodexProbe", discoveryLoopStart);
const discoveryStart = source.indexOf("record.earlyScriptId = await registerEarly", discoveryLoopStart);
assert.ok(probeStart >= 0 && discoveryStart > probeStart,
  "A target must pass full shell probing before any persistent or immediate skin injection.");
assert.match(source, /if \(liveTarget && isExcludedCdpSurfaceUrl\(liveTarget\.url\)\)[\s\S]*invalidateEarly\(record\)[\s\S]*cleanupExcludedSurface\(record\.session\)/,
  "An already-connected renderer that navigates into an auxiliary route must be invalidated and cleaned.");
assert.match(
  source,
  /finally\s*\{[\s\S]*Promise\.all\(\[\.\.\.sessions\.values\(\)\][\s\S]*removeEarly\(record\)/,
  "Watcher shutdown must unregister persistent Page scripts before closing CDP sessions.",
);
assert.match(
  source,
  /const earlyApplied = await session\.evaluate\([\s\S]*if \(current\.dynamicRenderer \|\| !earlyApplied\) \{[\s\S]*applyLoadedToSession/,
  "A v2 skin must hot-stage renderer blobs after the deferred early shell, while v1 avoids duplicate injection.",
);
assert.match(
  source,
  /const recoverRendererRecord = async[\s\S]*record\.ready = false;[\s\S]*waitForEarlyGenerationApplied\([\s\S]*?record\.session,[\s\S]*?loaded\.revision[\s\S]*cancelPendingEarlyGeneration\(record\.session, loaded\.revision\)[\s\S]*applyLoadedToSession\(record\.session, loaded\)[\s\S]*waitForLoadedOwnershipSession[\s\S]*record\.ready = true;[\s\S]*session\.on\("Page\.loadEventFired",[\s\S]*record\.ready && Boolean\(current\.dynamicRenderer\)[\s\S]*record\.recoveryQueue\.request\("Page\.loadEventFired"\)/,
  "A verified renderer must restage theme blobs or restore native controls, then reverify after a page reload.",
);
assert.match(
  source,
  /const recoverRendererRecord = async[\s\S]*record\.lastThemeRequestSequence = 0;[\s\S]*session\.on\("Page\.loadEventFired",[\s\S]*record\.recoveryQueue\.request\("Page\.loadEventFired"\)/,
  "A renderer reload must reset its page-local theme request sequence before polling resumes.",
);
assert.match(
  source,
  /__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__[\s\S]*validateThemeActionRequest\(actionRequest,[\s\S]*selectLatestThemeActionRequest\(rendererActionRequests\)/,
  "The watcher must drain, validate, and coalesce Theme Center host actions.",
);
assert.match(
  source,
  /export async function pollRendererRequests[\s\S]*targetThemeId: actionValue\.targetThemeId,[\s\S]*const actionRequest = rendererPoll\?\.actionRequest[\s\S]*validateThemeActionRequest\(actionRequest,/,
  "The watcher must preserve the selected deletion target while crossing the renderer-to-host boundary.",
);
assert.match(
  source,
  /refreshPayload\(fallbackDir, "delete-theme-fallback"\)[\s\S]*archiveThemeDirectory\([\s\S]*refreshPayload\(committedThemeDir, "delete-theme-catalog-refresh"\)/,
  "Deleting the active theme must commit a fallback before archiving it and then refresh the catalog.",
);
assert.match(
  source,
  /request\.action === "import-media"[\s\S]*presentLibraryActionStatus\(operationToken, "loading", "正在选择要添加的图片或视频…"\)[\s\S]*chooseMediaFile\(\)[\s\S]*presentLibraryActionStatus\(operationToken, "cancelled", "已取消添加主题"\)/,
  "Import must show chooser progress immediately and report cancellation instead of failing silently.",
);
assert.match(
  source,
  /const recoverRendererRecord = async[\s\S]*record\.lastThemeActionRequestSequence = 0;[\s\S]*session\.on\("Page\.loadEventFired",[\s\S]*record\.recoveryQueue\.request\("Page\.loadEventFired"\)/,
  "A renderer reload must reset its page-local library action sequence before polling resumes.",
);
assert.match(source, /operationExternal: false,\s*ready: false,/,
  "New renderer records must begin unverified.");
assert.match(
  source,
  /for \(const record of sessions\.values\(\)\) \{\s*if \(record\.session\.closed \|\| !record\.ready\) continue;\s*let rendererPoll;[\s\S]*pollRendererRequests\(record\.session, 1500\)/,
  "Unverified renderers must not participate in theme request polling.",
);
assert.match(
  source,
  /for \(const record of sessions\.values\(\)\) \{\s*const \{ session \} = record;\s*if \(session\.closed \|\| !record\.ready\) continue;/,
  "Theme refresh must ignore a target until initial renderer verification completes.",
);
assert.match(
  source,
  /if \(!verification\?\.pass\) throw new Error\("Initial theme verification failed"\);\s*record\.ready = true;/,
  "A renderer must become eligible only after initial verification passes.",
);
assert.match(
  source,
  /assertPayloadIntegrity\(payload\);[\s\S]*let rootReady = await session\.evaluate[\s\S]*if \(!rootReady\) \{[\s\S]*legacyResult = await applyToSession\(session, loaded\.dynamicRenderer\.legacyPayload\);[\s\S]*return await applyToSession\(session, dynamicPayload\.source\)/,
  "Hot replacement must preserve an existing renderer root, install legacy only when absent, and stage the candidate dynamically.",
);
assert.match(
  source,
  /const suggestionLabelColorsMatch = visibleSuggestionLabels\.every\(/,
  "Live verification must reject visible home suggestion labels that diverge from the themed card color.",
);
assert.match(source, /visibleSuggestionLabels\.length >= result\.visibleCardCount/);
assert.match(source, /result\.suggestionLabelColorsMatch/);

console.log("PASS: early injection is L0-ready, generation-safe, and removed on shutdown.");

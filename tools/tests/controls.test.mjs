import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { FakeDocument, createLedger } from "./helpers/fake-media.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("theme center saves theme, sound, quality, motion, and opacity as one transaction", async () => {
  const document = new FakeDocument();
  document.documentElement = { lang: "zh-CN" };
  const updates = [];
  const mediaUpdates = [];
  const policyUpdates = [];
  const audio = {
    unlockFromGesture: async (event) => { assert.equal(event.isTrusted, true); updates.push("unlock"); },
    setSettings: (value) => updates.push(value),
  };
  const dispatched = [];
  const context = vm.createContext({
    Event, EventTarget, Map, Object, Promise,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  });
  context.window = context;
  context.document = document;
  context.dispatchEvent = (event) => dispatched.push(event);
  const stored = new Map();
  context.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
  };
  for (const name of ["module-registry.js", "controls.js"]) {
    vm.runInContext(await fs.readFile(path.join(root, "runtime/dynamic/browser", name), "utf8"), context);
  }
  const service = context.__CODEX_DYNAMIC_SKIN_MODULES__.get("controls")({ document, window: context });
  const settings = { backgroundPlayback: true, soundEnabled: false, masterVolume: 1, ambientVolume: 0.7, uiVolume: 0.8,
    visualOpacity: 1, ambientMuted: false, uiMuted: false, hiddenAudio: "pause",
    quality: "auto", reducedMotion: "system" };
  const controls = service.create({ config: { generation: "test-generation", theme: {
    id: "com.mars.starlight-in-eyes",
    audio: { ambient: { source: "visual" }, ui: { events: { taskCompleted: "done.wav" } } },
  }, themeCatalog: [
    { id: "com.mars.starlight-in-eyes", name: "眼里的星光", kind: "video", hasAudio: true,
      thumbnail: "data:image/jpeg;base64,c3RhcmxpZ2h0" },
    { id: "com.mars.space-roamer", name: "傲游太空", kind: "video", hasAudio: true,
      thumbnail: "data:image/jpeg;base64,c3BhY2U=" },
    { id: "com.mars.floating-in-space", name: "Floating in Space", kind: "video", hasAudio: false,
      thumbnail: "data:image/jpeg;base64,ZmxvYXRpbmc=" },
  ], storage: { path: "/Volumes/Media/Dream Skin", available: true, custom: true,
    bytes: 1572864000, themeCount: 3 }, settings }, modules: new Map([
    ["audio-bus", audio],
    ["media-layer", {
      setOpacity: (value) => mediaUpdates.push(["opacity", value]),
      setReducedMotion: (value) => mediaUpdates.push(["motion", value]),
      setBackgroundPlayback: (value) => mediaUpdates.push(["background", value]),
    }],
    ["performance-policy", {
      setPreference: (...value) => policyUpdates.push(value),
    }],
  ]), ledger: createLedger() });
  const host = document.created.find((item) => item.getAttribute("data-dynamic-skin-controls") !== null);
  const panel = document.created.find((item) => item.getAttribute("data-dynamic-skin-center-panel") !== null);
  const theme = document.created.find((item) => item.getAttribute("data-setting") === "themeId");
  const themeButtons = document.created.filter((item) => item.getAttribute("data-theme-id") !== null);
  const themeThumbnails = document.created.filter((item) => item.getAttribute("data-theme-thumbnail") !== null);
  const enabled = document.created.find((item) => item.getAttribute("data-setting") === "soundEnabled");
  const backgroundPlayback = document.created.find((item) => item.getAttribute("data-setting") === "backgroundPlayback");
  const backgroundAudio = document.created.find((item) => item.getAttribute("data-setting") === "hiddenAudio");
  const master = document.created.find((item) => item.getAttribute("data-setting") === "masterVolume");
  const quality = document.created.find((item) => item.getAttribute("data-setting") === "quality");
  const reducedMotion = document.created.find((item) => item.getAttribute("data-setting") === "reducedMotion");
  const opacity = document.created.find((item) => item.getAttribute("data-setting") === "visualOpacity");
  const cancel = document.created.find((item) => item.getAttribute("data-skin-action") === "cancel");
  const save = document.created.find((item) => item.getAttribute("data-skin-action") === "save");
  const themeSection = document.created.find((item) => item.getAttribute("data-skin-section") === "library");
  const playbackSection = document.created.find((item) => item.getAttribute("data-skin-section") === "playback");
  const displaySection = document.created.find((item) => item.getAttribute("data-skin-section") === "display");
  const themeCount = document.created.find((item) => item.getAttribute("data-theme-count") !== null);
  const currentBadge = document.created.find((item) => item.getAttribute("data-theme-current-badge") !== null);
  const workspace = document.created.find((item) => item.getAttribute("data-theme-center-workspace") !== null);
  const themeSearch = document.created.find((item) => item.getAttribute("data-theme-search") !== null);
  const libraryEmpty = document.created.find((item) => item.getAttribute("data-theme-search-empty") !== null);
  const playbackStatus = document.created.find((item) => item.getAttribute("data-playback-status") !== null);
  const importHint = document.created.find((item) => item.getAttribute("data-theme-import-hint") !== null);
  const storageSection = document.created.find((item) => item.getAttribute("data-skin-section") === "storage");
  const storagePath = document.created.find((item) => item.getAttribute("data-theme-storage-path") !== null);
  const storageMeta = document.created.find((item) => item.getAttribute("data-theme-storage-meta") !== null);
  const changeStorage = document.created.find((item) => item.getAttribute("data-skin-action") === "change-storage");
  const restoreDefault = document.created.find((item) => item.getAttribute("data-skin-action") === "restore-default-theme");
  const saveState = document.created.find((item) => item.getAttribute("data-skin-save-state") !== null);
  const masterValue = document.created.find((item) => item.getAttribute("data-setting-value") === "masterVolume");
  const ambient = document.created.find((item) => item.getAttribute("data-setting") === "ambientVolume");
  const uiVolume = document.created.find((item) => item.getAttribute("data-setting") === "uiVolume");
  assert.equal(document.created.some((item) => item.getAttribute("data-dynamic-skin-center-button") !== null), false);
  assert.equal(document.created.some((item) => item.getAttribute("data-dynamic-skin-sound-button") !== null), false);
  assert.equal(host.style.inset, "0");
  assert.equal(host.style.display, "none");
  assert.match(panel.getAttribute("aria-label"), /主题中心/);
  assert.equal(panel.getAttribute("tabindex"), "-1");
  assert.ok(themeSection, "theme management must be a first-class section");
  assert.ok(playbackSection, "playback and sound controls must be grouped together");
  assert.ok(displaySection, "display and performance controls must be grouped together");
  assert.ok(storageSection, "growing theme media needs a first-class storage section");
  assert.ok(restoreDefault, "theme center must expose a persistent native Codex restore action");
  assert.equal(storagePath.textContent, "/Volumes/Media/Dream Skin");
  assert.match(storageMeta.textContent, /3 个主题/);
  assert.match(storageMeta.textContent, /GB/);
  assert.match(themeCount.textContent, /3/);
  assert.equal(currentBadge.textContent, "当前使用");
  assert.equal(workspace.style.gridTemplateColumns, "minmax(240px,.82fr) minmax(360px,1.18fr)");
  assert.equal(themeSearch.getAttribute("placeholder"), "搜索主题");
  assert.equal(theme.getAttribute("tabindex"), "0");
  assert.equal(theme.style.gridTemplateColumns, "repeat(2,minmax(0,1fr))");
  assert.equal(theme.style.overflowY, "auto");
  assert.equal(theme.style.maxHeight, "392px");
  assert.equal(themeThumbnails.length, 3);
  assert.equal(themeThumbnails[0].src, "data:image/jpeg;base64,c3RhcmxpZ2h0");
  assert.equal(themeThumbnails[0].style.aspectRatio, "16 / 9");
  assert.equal(themeThumbnails[0].style.objectFit, "cover");
  assert.match(playbackStatus.textContent, /循环播放/);
  themeSearch.value = "floating";
  themeSearch.oninput();
  assert.equal(themeButtons.filter((item) => item.style.display !== "none").length, 1);
  assert.equal(themeButtons.find((item) => item.style.display !== "none").style.display, "flex");
  themeSearch.value = "不存在";
  themeSearch.oninput();
  assert.equal(libraryEmpty.style.display, "block");
  themeSearch.value = "";
  themeSearch.oninput();
  assert.match(importHint.textContent, /自动加入主题库并立即应用/);
  assert.equal(saveState.textContent, "所有更改已保存");
  assert.equal(theme.children.length, 3);
  assert.equal(themeButtons[0].getAttribute("aria-checked"), "true");
  assert.equal(themeButtons[1].getAttribute("aria-checked"), "false");
  assert.equal(quality.value, "auto");
  assert.equal(reducedMotion.value, "system");
  assert.equal(updates[0].soundEnabled, false);
  assert.equal(backgroundPlayback.checked, true);
  assert.ok(backgroundAudio, "theme center must expose the background-audio policy");
  assert.equal(backgroundAudio.checked, false);
  assert.equal(backgroundAudio.disabled, true);
  assert.equal(ambient.disabled, true, "sound-dependent controls start disabled while sound is off");
  assert.equal(uiVolume.disabled, true, "UI sound volume starts disabled while sound is off");
  assert.equal(save.disabled, true, "Save is disabled until the draft changes");
  assert.equal(masterValue.textContent, "100%");
  assert.deepEqual(mediaUpdates, [["opacity", 1], ["motion", "system"], ["background", true]]);
  assert.deepEqual(policyUpdates, [["auto", "system"]]);
  controls.open();
  assert.equal(host.style.display, "flex");
  opacity.value = "0.6";
  opacity.oninput();
  assert.deepEqual(mediaUpdates.at(-1), ["opacity", 0.6],
    "dragging opacity must preview the selected value immediately");
  cancel.onclick();
  assert.equal(host.style.display, "none");
  assert.deepEqual(mediaUpdates.at(-1), ["opacity", 1],
    "cancelling an opacity preview must restore the persisted value");
  controls.open();
  enabled.checked = true;
  enabled.onchange();
  assert.equal(ambient.disabled, false);
  assert.equal(uiVolume.disabled, false);
  assert.equal(backgroundAudio.disabled, false);
  assert.equal(save.disabled, false);
  assert.equal(saveState.textContent, "有未保存的更改");
  backgroundPlayback.checked = false;
  backgroundPlayback.onchange();
  backgroundAudio.checked = true;
  backgroundAudio.onchange();
  master.value = "0.35";
  master.oninput();
  assert.equal(masterValue.textContent, "35%");
  opacity.value = "0.6";
  opacity.oninput();
  quality.value = "full";
  quality.onchange();
  reducedMotion.value = "off";
  reducedMotion.onchange();
  themeButtons[1].onclick();
  assert.equal(themeButtons[0].getAttribute("aria-checked"), "false");
  assert.equal(themeButtons[1].getAttribute("aria-checked"), "true");
  assert.equal(updates.length, 1, "draft changes must not apply before Save");
  assert.equal(context.__CODEX_DYNAMIC_SKIN_THEME_REQUEST__, undefined);
  const importMedia = document.created.find((item) => item.getAttribute("data-skin-action") === "import-media");
  importMedia.onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(context.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__)), {
    action: "import-media",
    themeId: "com.mars.starlight-in-eyes",
    generation: "test-generation",
    issuedAt: context.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.issuedAt,
    sequence: 1,
  });
  assert.equal(typeof context.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.issuedAt, "number");
  assert.equal(dispatched.at(-1).type, "codex-dynamic-skin-action-request");
  changeStorage.onclick();
  assert.equal(context.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.action, "change-storage");
  assert.equal(context.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.sequence, 2);
  restoreDefault.onclick();
  assert.equal(context.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.action, "restore-default-theme");
  assert.equal(context.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.sequence, 3);
  await save.onclick({ isTrusted: true });
  assert.equal(updates[1], "unlock");
  assert.equal(updates.at(-1).soundEnabled, true);
  assert.equal(updates.at(-1).backgroundPlayback, false);
  assert.equal(updates.at(-1).hiddenAudio, "continue");
  assert.equal(updates.at(-1).masterVolume, 0.35);
  assert.equal(updates.at(-1).visualOpacity, 0.6);
  assert.equal(updates.at(-1).quality, "full");
  assert.equal(updates.at(-1).reducedMotion, "off");
  assert.equal(context.__CODEX_DYNAMIC_SKIN_THEME_REQUEST__.id, "com.mars.space-roamer");
  assert.equal(context.__CODEX_DYNAMIC_SKIN_THEME_REQUEST__.fromThemeId, "com.mars.starlight-in-eyes");
  assert.equal(context.__CODEX_DYNAMIC_SKIN_THEME_REQUEST__.generation, "test-generation");
  assert.equal(typeof context.__CODEX_DYNAMIC_SKIN_THEME_REQUEST__.issuedAt, "number");
  assert.deepEqual(mediaUpdates.slice(-3), [["opacity", 0.6], ["motion", "off"], ["background", false]]);
  assert.deepEqual(policyUpdates.at(-1), ["full", "off"]);
  assert.equal(dispatched.at(-1).type, "codex-dynamic-skin-theme-request");
  assert.equal(context.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.action, "save-settings");
  assert.equal(context.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.settings.masterVolume, 0.35);
  assert.equal(context.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.settings.backgroundPlayback, false);
  assert.equal(context.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.settings.hiddenAudio, "continue");
  assert.equal(JSON.parse(stored.get("codex.dynamicSkin.settings.v1")).masterVolume, 0.35);
  assert.equal(JSON.parse(stored.get("codex.dynamicSkin.settings.v1")).backgroundPlayback, false);
  assert.equal(host.style.display, "none");
  await controls.destroy();
  assert.equal(host.parentNode, null);
});

test("theme library exposes media status and stays open across hot refresh", async () => {
  const document = new FakeDocument();
  document.documentElement = { lang: "zh-CN" };
  const context = vm.createContext({
    Event, EventTarget, Map, Object, Promise,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  });
  context.window = context;
  context.document = document;
  context.dispatchEvent = () => {};
  context.localStorage = { getItem: () => null, setItem: () => {} };
  for (const name of ["module-registry.js", "controls.js"]) {
    vm.runInContext(await fs.readFile(path.join(root, "runtime/dynamic/browser", name), "utf8"), context);
  }
  const service = context.__CODEX_DYNAMIC_SKIN_MODULES__.get("controls")({ document, window: context });
  const config = {
    generation: "catalog-refresh-1", settingsAuthority: "shared-file",
    theme: { id: "com.mars.space-roamer", audio: { ambient: { source: "visual" }, ui: { events: {} } } },
    themeCatalog: [
      { id: "com.mars.space-roamer", name: "傲游太空", kind: "video", hasAudio: true },
      { id: "com.mars.poster", name: "静态海报", kind: "image", hasAudio: false },
    ],
    settings: { backgroundPlayback: true, soundEnabled: false, masterVolume: 1,
      ambientVolume: 0.7, uiVolume: 0.8, visualOpacity: 1, ambientMuted: false,
      uiMuted: false, hiddenAudio: "pause", quality: "auto", reducedMotion: "system" },
  };
  const first = service.create({ config, modules: new Map(), ledger: createLedger() });
  first.open();
  const firstHost = document.created.filter((item) => item.getAttribute("data-dynamic-skin-controls") !== null).at(-1);
  assert.equal(firstHost.style.display, "flex");
  const kindBadges = document.created.filter((item) => item.getAttribute("data-theme-kind") !== null);
  assert.deepEqual(kindBadges.map((item) => item.textContent), ["视频 · 含声音", "图片 · 静音"]);
  await first.destroy();

  const second = service.create({ config: { ...config, generation: "catalog-refresh-2" }, modules: new Map(), ledger: createLedger() });
  const secondHost = document.created.filter((item) => item.getAttribute("data-dynamic-skin-controls") !== null).at(-1);
  assert.equal(secondHost.style.display, "none",
    "a staged replacement must not overlap the currently visible theme center");
  second.reveal();
  assert.equal(secondHost.style.display, "flex", "an import/theme refresh must not make the management center disappear");
  await second.destroy();
});

test("an offline custom theme disk is explicit and blocks writes until repaired", async () => {
  const document = new FakeDocument();
  document.documentElement = { lang: "zh-CN" };
  const context = vm.createContext({
    Event, EventTarget, Map, Object, Promise,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  });
  context.window = context; context.document = document; context.dispatchEvent = () => {};
  context.localStorage = { getItem: () => null, setItem: () => {} };
  for (const name of ["module-registry.js", "controls.js"]) {
    vm.runInContext(await fs.readFile(path.join(root, "runtime/dynamic/browser", name), "utf8"), context);
  }
  const service = context.__CODEX_DYNAMIC_SKIN_MODULES__.get("controls")({ document, window: context });
  const instance = service.create({ config: { generation: "offline-storage", theme: {
    id: "com.mars.space-roamer", audio: { ambient: { source: "none" }, ui: { events: {} } },
  }, themeCatalog: [
    { id: "com.mars.space-roamer", name: "傲游太空" },
    { id: "com.mars.starlight", name: "眼里的星光" },
  ], storage: { path: "/Volumes/ThemeDisk/Dream Skin", available: false, custom: true,
    bytes: 0, themeCount: 0 }, settings: {
    backgroundPlayback: true, soundEnabled: false, masterVolume: 1, ambientVolume: 0.7, uiVolume: 0.8,
    visualOpacity: 1, ambientMuted: false, uiMuted: false, hiddenAudio: "pause",
    quality: "auto", reducedMotion: "system",
  } }, modules: new Map(), ledger: createLedger() });
  const storageMeta = document.created.find((item) => item.getAttribute("data-theme-storage-meta") !== null);
  const repair = document.created.find((item) => item.getAttribute("data-skin-action") === "change-storage");
  const importMedia = document.created.find((item) => item.getAttribute("data-skin-action") === "import-media");
  const remove = document.created.find((item) => item.getAttribute("data-skin-action") === "delete-theme");
  assert.match(storageMeta.textContent, /不可用/);
  assert.equal(repair.textContent, "修复位置");
  assert.equal(importMedia.disabled, true);
  assert.equal(remove.disabled, true);
  await instance.destroy();
});

test("background playback never claims live support when the current Codex launch lacks it", async () => {
  const document = new FakeDocument();
  document.documentElement = { lang: "zh-CN" };
  const context = vm.createContext({
    Event, EventTarget, Map, Object, Promise,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  });
  context.window = context; context.document = document; context.dispatchEvent = () => {};
  context.localStorage = { getItem: () => null, setItem: () => {} };
  for (const name of ["module-registry.js", "controls.js"]) {
    vm.runInContext(await fs.readFile(path.join(root, "runtime/dynamic/browser", name), "utf8"), context);
  }
  const service = context.__CODEX_DYNAMIC_SKIN_MODULES__.get("controls")({ document, window: context });
  service.create({ config: {
    generation: "unsupported-background", backgroundPlaybackSupport: "restart-required",
    theme: { id: "com.mars.space-roamer", audio: { ambient: { source: "visual" }, ui: { events: {} } } },
    themeCatalog: [], settings: { backgroundPlayback: true, soundEnabled: false, masterVolume: 1,
      ambientVolume: 0.7, uiVolume: 0.8, visualOpacity: 1, ambientMuted: false,
      uiMuted: false, hiddenAudio: "pause", quality: "auto", reducedMotion: "system" },
  }, modules: new Map(), ledger: createLedger() });
  const status = document.created.find((item) => item.getAttribute("data-playback-status") !== null);
  assert.equal(status.getAttribute("data-support"), "restart-required");
  assert.match(status.textContent, /下次.*启动.*生效/);
  assert.doesNotMatch(status.textContent, /后台播放已开启/);
});

test("shared-file settings override stale renderer localStorage", async () => {
  const document = new FakeDocument();
  document.documentElement = { lang: "zh-CN" };
  const stale = {
    backgroundPlayback: false, soundEnabled: true, masterVolume: 0.1,
    ambientVolume: 0.1, uiVolume: 0.1, visualOpacity: 0.2,
    ambientMuted: false, uiMuted: false, hiddenAudio: "continue",
    quality: "static", reducedMotion: "on",
  };
  const stored = new Map([["codex.dynamicSkin.settings.v1", JSON.stringify(stale)]]);
  const context = vm.createContext({
    Event, EventTarget, Map, Object, Promise,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  });
  context.window = context;
  context.document = document;
  context.dispatchEvent = () => {};
  context.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
  };
  for (const name of ["module-registry.js", "controls.js"]) {
    vm.runInContext(await fs.readFile(path.join(root, "runtime/dynamic/browser", name), "utf8"), context);
  }
  const service = context.__CODEX_DYNAMIC_SKIN_MODULES__.get("controls")({ document, window: context });
  const authoritative = {
    schemaVersion: 1, backgroundPlayback: true, soundEnabled: false,
    masterVolume: 0.9, ambientVolume: 0.7, uiVolume: 0.8, visualOpacity: 1,
    ambientMuted: false, uiMuted: false, quality: "full", reducedMotion: "off", hiddenAudio: "pause",
  };
  const instance = service.create({ config: {
    generation: "shared-settings", settingsAuthority: "shared-file",
    theme: { id: "com.mars.space-roamer", audio: { ambient: { source: "none" }, ui: { events: {} } } },
    themeCatalog: [], settings: authoritative,
  }, modules: new Map(), ledger: createLedger() });

  const background = document.created.find((item) => item.getAttribute("data-setting") === "backgroundPlayback");
  const master = document.created.find((item) => item.getAttribute("data-setting") === "masterVolume");
  assert.equal(background.checked, true);
  assert.equal(master.value, "0.9");
  assert.equal(JSON.parse(stored.get("codex.dynamicSkin.settings.v1")).masterVolume, 0.9);
  await instance.destroy();
});

test("theme deletion requires an explicit confirmation and can be cancelled", async () => {
  const document = new FakeDocument();
  document.documentElement = { lang: "zh-CN" };
  const dispatched = [];
  const context = vm.createContext({
    Event, EventTarget, Map, Object, Promise,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  });
  context.window = context;
  context.document = document;
  context.dispatchEvent = (event) => dispatched.push(event);
  context.localStorage = { getItem: () => null, setItem: () => {} };
  for (const name of ["module-registry.js", "controls.js"]) {
    vm.runInContext(await fs.readFile(path.join(root, "runtime/dynamic/browser", name), "utf8"), context);
  }
  const service = context.__CODEX_DYNAMIC_SKIN_MODULES__.get("controls")({ document, window: context });
  const instance = service.create({ config: { generation: "delete-test", theme: {
    id: "com.mars.space-roamer", audio: { ambient: { source: "none" }, ui: { events: {} } },
  }, themeCatalog: [
    { id: "com.mars.space-roamer", name: "傲游太空" },
    { id: "com.mars.starlight-in-eyes", name: "眼里的星光" },
  ], settings: {
    backgroundPlayback: true, soundEnabled: false, masterVolume: 1, ambientVolume: 0.7, uiVolume: 0.8,
    visualOpacity: 1, ambientMuted: false, uiMuted: false, hiddenAudio: "pause",
    quality: "auto", reducedMotion: "system",
  } }, modules: new Map(), ledger: createLedger() });

  const remove = document.created.find((item) => item.getAttribute("data-skin-action") === "delete-theme");
  const selectedCard = document.created.find((item) =>
    item.getAttribute("data-theme-id") === "com.mars.starlight-in-eyes");
  const confirmation = document.created.find((item) => item.getAttribute("data-delete-confirmation") !== null);
  const confirm = document.created.find((item) => item.getAttribute("data-skin-action") === "confirm-delete-theme");
  const keep = document.created.find((item) => item.getAttribute("data-skin-action") === "cancel-delete-theme");
  assert.equal(confirmation.style.display, "none");
  selectedCard.onclick();
  remove.onclick();
  assert.equal(confirmation.style.display, "flex");
  assert.equal(dispatched.length, 0, "opening confirmation must not delete anything");
  keep.onclick();
  assert.equal(confirmation.style.display, "none");
  remove.onclick();
  confirm.onclick();
  assert.equal(dispatched.at(-1).type, "codex-dynamic-skin-action-request");
  assert.equal(context.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.action, "delete-theme");
  assert.equal(context.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.themeId, "com.mars.space-roamer");
  assert.equal(context.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.targetThemeId, "com.mars.starlight-in-eyes");
  await instance.destroy();
});

test("theme center protects the only installed theme from deletion", async () => {
  const document = new FakeDocument();
  document.documentElement = { lang: "zh-CN" };
  const context = vm.createContext({
    Event, EventTarget, Map, Object, Promise,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  });
  context.window = context;
  context.document = document;
  context.dispatchEvent = () => {};
  context.localStorage = { getItem: () => null, setItem: () => {} };
  for (const name of ["module-registry.js", "controls.js"]) {
    vm.runInContext(await fs.readFile(path.join(root, "runtime/dynamic/browser", name), "utf8"), context);
  }
  const service = context.__CODEX_DYNAMIC_SKIN_MODULES__.get("controls")({ document, window: context });
  const instance = service.create({ config: { generation: "sole-theme", theme: {
    id: "com.mars.space-roamer", audio: { ambient: { source: "none" }, ui: { events: {} } },
  }, themeCatalog: [{ id: "com.mars.space-roamer", name: "傲游太空" }], settings: {
    backgroundPlayback: true, soundEnabled: false, masterVolume: 1, ambientVolume: 0.7, uiVolume: 0.8,
    visualOpacity: 1, ambientMuted: false, uiMuted: false, hiddenAudio: "pause",
    quality: "auto", reducedMotion: "system",
  } }, modules: new Map(), ledger: createLedger() });

  const remove = document.created.find((item) => item.getAttribute("data-skin-action") === "delete-theme");
  const confirmation = document.created.find((item) => item.getAttribute("data-delete-confirmation") !== null);
  assert.equal(remove.disabled, true);
  assert.match(remove.getAttribute("title"), /至少保留一个主题/);
  remove.onclick();
  assert.equal(confirmation.style.display, "none");
  await instance.destroy();
});

test("theme center is inserted immediately above the native Settings menu item", async () => {
  const document = new FakeDocument();
  document.documentElement = { lang: "zh-CN" };
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  const settingsItem = document.createElement("div");
  settingsItem.setAttribute("role", "menuitem");
  settingsItem.className = "native-menu-item";
  settingsItem.textContent = "设置";
  const settingsContent = document.createElement("div");
  settingsContent.className = "native-menu-content";
  settingsItem.append(settingsContent);
  settingsItem.parentElement = menu;
  menu.append(settingsItem);
  menu.querySelector = (selector) => selector === "[data-dynamic-skin-menu-item]"
    ? menu.children.find((item) => item.getAttribute("data-dynamic-skin-menu-item") !== null) ?? null
    : null;
  menu.querySelectorAll = (selector) => selector === '[role="menuitem"]' ? [...menu.children] : [];
  menu.insertBefore = (item, reference) => {
    const index = menu.children.indexOf(reference);
    item.parentNode = menu;
    item.parentElement = menu;
    menu.children.splice(index, 0, item);
  };
  document.querySelectorAll = (selector) => selector === '[role="menu"]' ? [menu] : [];

  const context = vm.createContext({
    Event, EventTarget, Map, Object, Promise,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  });
  context.window = context;
  context.document = document;
  context.dispatchEvent = () => {};
  context.localStorage = { getItem: () => null, setItem: () => {} };
  for (const name of ["module-registry.js", "controls.js"]) {
    vm.runInContext(await fs.readFile(path.join(root, "runtime/dynamic/browser", name), "utf8"), context);
  }
  const service = context.__CODEX_DYNAMIC_SKIN_MODULES__.get("controls")({ document, window: context });
  const instance = service.create({ config: { theme: {
    id: "com.mars.starlight-in-eyes",
    audio: { ambient: { source: "none" }, ui: { events: {} } },
  }, themeCatalog: [], settings: {
    backgroundPlayback: true, soundEnabled: false, masterVolume: 1, ambientVolume: 0.7, uiVolume: 0.8,
    visualOpacity: 1, ambientMuted: false, uiMuted: false, hiddenAudio: "pause",
    quality: "auto", reducedMotion: "system",
  } }, modules: new Map(), ledger: createLedger() });

  assert.equal(menu.children.length, 2);
  const themeCenter = menu.children[0];
  assert.equal(themeCenter.getAttribute("data-dynamic-skin-menu-item"), "");
  assert.equal(themeCenter.className, settingsItem.className);
  assert.equal(themeCenter.children[0].children[1].textContent, "主题中心");
  assert.equal(menu.children[1], settingsItem);
  themeCenter.onclick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(instance.diagnostics().visible, true);
  await instance.destroy();
});

test("theme center restores four native home suggestions with their original actions", async () => {
  const document = new FakeDocument();
  document.documentElement = { lang: "zh-CN" };
  const invoked = [];
  const items = [
    ["codex-explore", "探索并理解代码"], ["codex-create", "构建新功能、应用或工具"],
    ["codex-review", "审查代码并提出修改建议"], ["codex-fix", "修复问题和失败"],
  ].map(([id, label]) => ({ id, label, onClick: () => invoked.push(id) }));
  const grid = {
    className: "grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]",
    children: [{ textContent: items[0].label }, { textContent: items[1].label }],
    append(node) { node.parent = this; this.children.push(node); },
  };
  const template = {
    cloneNode() {
      const label = { id: "old-label", textContent: "old" };
      const button = { setAttribute(name, value) { this[name] = value; },
        querySelector: () => label };
      return {
        textContent: "old", label, button,
        setAttribute(name, value) { this[name] = value; },
        querySelector(selector) { return selector === "button" ? button : label; },
        remove() { this.parent.children = this.parent.children.filter((item) => item !== this); },
      };
    },
  };
  grid.lastElementChild = template;
  grid.__reactFiber$test = { memoizedProps: {}, return: { memoizedProps: { items }, return: null } };
  document.querySelectorAll = (selector) => selector === "div.grid" ? [grid] : [];

  const context = vm.createContext({
    Event, EventTarget, Map, Object, Promise,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  });
  context.window = context;
  context.document = document;
  context.dispatchEvent = () => {};
  context.localStorage = { getItem: () => null, setItem: () => {} };
  for (const name of ["module-registry.js", "controls.js"]) {
    vm.runInContext(await fs.readFile(path.join(root, "runtime/dynamic/browser", name), "utf8"), context);
  }
  const service = context.__CODEX_DYNAMIC_SKIN_MODULES__.get("controls")({ document, window: context });
  const instance = service.create({ config: { theme: {
    id: "com.mars.space-roamer", audio: { ambient: { source: "none" }, ui: { events: {} } },
  }, themeCatalog: [], settings: {
    backgroundPlayback: true, soundEnabled: false, masterVolume: 1, ambientVolume: 0.7, uiVolume: 0.8,
    visualOpacity: 1, ambientMuted: false, uiMuted: false, hiddenAudio: "pause",
    quality: "auto", reducedMotion: "system",
  } }, modules: new Map(), ledger: createLedger() });

  assert.equal(grid.children.length, 4);
  assert.equal(grid.children[2].label.textContent, items[2].label);
  assert.equal(grid.children[3].label.textContent, items[3].label);
  grid.children[3].button.onclick({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(invoked, ["codex-fix"]);
  assert.equal(instance.diagnostics().restoredSuggestions, 2);
  await instance.destroy();
  assert.equal(grid.children.length, 2);
});

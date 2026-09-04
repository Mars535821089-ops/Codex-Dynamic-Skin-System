import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { createLedger, FakeDocument } from "./helpers/fake-media.mjs";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const browserRoot = path.join(projectRoot, "runtime", "dynamic", "browser");

async function loadService(document, reducedMotion = false) {
  const windowEvents = new EventTarget();
  const context = vm.createContext({
    AbortController, DOMException, Event, EventTarget, Map, Object, Promise,
    clearTimeout, setTimeout,
  });
  context.window = context;
  context.document = document;
  context.matchMedia = () => ({ matches: reducedMotion });
  context.addEventListener = windowEvents.addEventListener.bind(windowEvents);
  context.removeEventListener = windowEvents.removeEventListener.bind(windowEvents);
  context.dispatchEvent = windowEvents.dispatchEvent.bind(windowEvents);
  vm.runInContext(await fs.readFile(path.join(browserRoot, "module-registry.js"), "utf8"), context);
  vm.runInContext(await fs.readFile(path.join(browserRoot, "media-layer.js"), "utf8"), context);
  const service = context.__CODEX_DYNAMIC_SKIN_MODULES__.get("media-layer")({ document, window: context });
  service.__testWindow = context;
  return service;
}

function config(overrides = {}) {
  return {
    generation: "video-a",
    theme: {
      visual: {
        kind: "video", asset: "media/loop.mp4", poster: "media/poster.webp",
        fit: "cover", opacity: 0.82, loop: true,
      },
      audio: { ambient: { source: "visual" }, ui: { events: {} } },
    },
    assets: {
      "media/loop.mp4": "http://127.0.0.1:1234/t/g/media/loop.mp4",
      "media/poster.webp": "http://127.0.0.1:1234/t/g/media/poster.webp",
    },
    settings: { reducedMotion: "off", visualOpacity: 1, backgroundPlayback: true },
    ...overrides,
  };
}

async function prepareVideoLayer(layer, video) {
  const ready = layer.ready();
  video.readyState = 1;
  video.emit("loadedmetadata");
  await new Promise((resolve) => setImmediate(resolve));
  video.emitFrame();
  await ready;
  await layer.commit();
}

test("imported image uses a body-owned adaptive layer outside React's managed subtree", async () => {
  const document = new FakeDocument();
  const appRoot = document.createElement("div");
  const hiddenSentinel = document.createElement("span");
  const contentHost = document.createElement("div");
  const foreground = document.createElement("main");
  appRoot.id = "root";
  contentHost.rect = { x: 0, y: 0, width: 1200, height: 800 };
  contentHost.append(foreground);
  appRoot.append(hiddenSentinel, contentHost);
  document.body.append(appRoot);
  document.getElementById = (id) => id === "root" ? appRoot : null;
  const service = await loadService(document);
  const imageConfig = config({
    generation: "image-a",
    theme: {
      visual: { kind: "image", asset: "media/visual.webp", fit: "adaptive", opacity: 1 },
      audio: { ambient: { source: "none" }, ui: { events: {} } },
    },
    assets: { "media/visual.webp": "http://127.0.0.1:1234/t/g/media/visual.webp" },
  });
  const layer = service.create({ config: imageConfig, ledger: createLedger() });
  const root = document.created.find((element) =>
    element.getAttribute("data-dynamic-skin-root") !== null);
  const image = document.created.find((element) =>
    element.getAttribute("data-dynamic-skin-poster") !== null);
  const video = document.created.find((element) => element.tagName === "VIDEO");

  assert.ok(root);
  assert.ok(image, "an imported image must create a visible media element");
  assert.equal(image.src, imageConfig.assets["media/visual.webp"]);
  assert.equal(image.style.objectFit, "cover");
  assert.equal(video, undefined);
  await layer.ready();
  await layer.commit();
  assert.equal(root.style.visibility, "hidden");
  layer.reveal();
  assert.equal(layer.diagnostics().mode, "image");
  assert.equal(layer.diagnostics().playing, false);
  assert.equal(root.style.visibility, "visible");
  assert.equal(root.style.opacity, "1");
  assert.equal(root.parentNode, document.body,
    "React must not own the live media node or remove it during a normal Codex rerender");
  assert.equal(document.body.firstElementChild, root,
    "the media layer must be a stable body sibling behind the Codex application root");
  assert.equal(root.style.zIndex, "1");
  assert.equal(appRoot.style.position, "relative");
  assert.equal(appRoot.style.zIndex, "2",
    "the entire Codex application must remain interactive above the live media");
  contentHost.children = [], foreground.parentNode = null;
  assert.equal(root.parentNode, document.body,
    "a React reconciliation inside #root must not detach the media layer");
  assert.equal(layer.diagnostics().connected, true);
  root.remove();
  assert.equal(layer.diagnostics().connected, false,
    "diagnostics must expose an externally detached media layer");
  layer.reveal();
  assert.equal(root.parentNode, document.body,
    "reveal must self-heal a media layer detached by an external DOM owner");
  assert.equal(document.body.firstElementChild, root);
  assert.equal(layer.diagnostics().connected, true);
  await layer.destroy();
  assert.equal(appRoot.style.position, undefined,
    "destroying the theme must restore foreground positioning");
  assert.equal(appRoot.style.zIndex, undefined,
    "destroying the theme must restore foreground stacking");
});

test("hot switching keeps Codex content above the newly committed media layer", async () => {
  const document = new FakeDocument();
  const appRoot = document.createElement("div");
  const contentHost = document.createElement("div");
  const foreground = document.createElement("main");
  appRoot.id = "root";
  contentHost.append(foreground);
  appRoot.append(contentHost);
  document.body.append(appRoot);
  document.getElementById = (id) => id === "root" ? appRoot : null;
  const service = await loadService(document);

  const first = service.create({ config: config(), ledger: createLedger() });
  const second = service.create({ config: config({ generation: "video-b" }), ledger: createLedger() });
  assert.equal(appRoot.style.position, "relative");
  assert.equal(appRoot.style.zIndex, "2");

  await first.destroy();
  assert.equal(appRoot.style.position, "relative",
    "destroying the previous layer must not undo the active layer stacking contract");
  assert.equal(appRoot.style.zIndex, "2");

  await second.destroy();
  assert.equal(appRoot.style.position, undefined);
  assert.equal(appRoot.style.zIndex, undefined);
});

test("dynamic media suppresses the legacy poster beneath partial opacity and restores it on cleanup", async () => {
  const document = new FakeDocument();
  document.body.style.backgroundImage = 'url("blob:app://legacy-theme")';
  const service = await loadService(document);

  const layer = service.create({ config: config(), ledger: createLedger() });
  assert.equal(document.body.style.backgroundImage, "none",
    "partial media opacity must reveal the native surface, never a stale legacy theme poster");

  await layer.destroy();
  assert.equal(document.body.style.backgroundImage, 'url("blob:app://legacy-theme")',
    "the legacy background must be restored when the final dynamic owner is removed");
});

test("a revealed live video suppresses legacy CSS artwork without hot-switch ownership races", async () => {
  const document = new FakeDocument();
  document.documentElement = document.createElement("html");
  const service = await loadService(document);
  const first = service.create({ config: config({ generation: "video-a" }), ledger: createLedger() });
  const second = service.create({ config: config({ generation: "video-b" }), ledger: createLedger() });
  const [firstVideo, secondVideo] = document.created.filter((element) => element.tagName === "VIDEO");

  await prepareVideoLayer(first, firstVideo);
  await prepareVideoLayer(second, secondVideo);
  assert.equal(document.documentElement.getAttribute("data-dynamic-skin-video-live"), null,
    "a concealed hot-switch candidate must not remove the currently rendered CSS artwork");

  first.reveal();
  second.reveal();
  assert.equal(document.documentElement.getAttribute("data-dynamic-skin-video-live"), "true");
  first.conceal();
  await first.destroy();
  assert.equal(document.documentElement.getAttribute("data-dynamic-skin-video-live"), "true",
    "destroying the outgoing generation must not restore duplicate CSS artwork over the new video");

  second.setTier("static");
  assert.equal(document.documentElement.getAttribute("data-dynamic-skin-video-live"), null);
  second.setTier("media");
  await Promise.resolve();
  assert.equal(document.documentElement.getAttribute("data-dynamic-skin-video-live"), "true");
  second.setReducedMotion("on");
  assert.equal(document.documentElement.getAttribute("data-dynamic-skin-video-live"), null);
  second.setReducedMotion("off");
  await Promise.resolve();
  assert.equal(document.documentElement.getAttribute("data-dynamic-skin-video-live"), "true");

  await second.destroy();
  assert.equal(document.documentElement.getAttribute("data-dynamic-skin-video-live"), null);
});

test("committed media can prune untracked legacy roots without removing itself", async () => {
  const document = new FakeDocument();
  const service = await loadService(document);
  const orphan = document.createElement("div");
  orphan.setAttribute("data-dynamic-skin-root", "");
  const orphanVideo = document.createElement("video");
  orphanVideo.src = "blob:app://legacy-theme";
  orphanVideo.paused = false;
  orphan.append(orphanVideo);
  document.body.append(orphan);

  const layer = service.create({ config: config(), ledger: createLedger() });
  const currentRoot = document.created.find((element) =>
    element !== orphan && element.getAttribute("data-dynamic-skin-root") !== null);
  document.querySelectorAll = (selector) => selector === "[data-dynamic-skin-root]"
    ? [orphan, currentRoot] : [];
  orphan.querySelectorAll = (selector) => selector === "video" ? [orphanVideo] : [];
  currentRoot.querySelectorAll = () => [];

  assert.equal(layer.pruneOrphanedRoots(), 1);
  assert.equal(orphan.parentNode, null);
  assert.equal(orphanVideo.paused, true);
  assert.equal(orphanVideo.src, "");
  assert.notEqual(currentRoot.parentNode, null);

  await layer.destroy();
});

test("video stays behind its poster until metadata and first decoded frame", async () => {
  const document = new FakeDocument();
  const ledger = createLedger();
  const service = await loadService(document);
  const layer = service.create({ config: config(), ledger });
  const root = document.created.find((element) => element.getAttribute("data-dynamic-skin-root") !== null);
  const video = document.created.find((element) => element.tagName === "VIDEO");
  const poster = document.created.find((element) => element.tagName === "IMG");
  assert.equal(root.style.visibility, "hidden");
  assert.equal(video.muted, true);
  assert.equal(video.loop, true);
  assert.equal(video.playsInline, true);
  assert.equal(video.preload, "metadata");
  assert.equal(video.crossOrigin, "anonymous");
  assert.equal(video.style.objectFit, "cover");
  assert.equal(poster.src, config().assets["media/poster.webp"]);

  const ready = layer.ready();
  video.readyState = 1;
  video.emit("loadedmetadata");
  // Let the vm-context continuation register requestVideoFrameCallback.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof video.frameCallback, "function");
  video.emitFrame();
  await ready;
  assert.equal(root.style.visibility, "hidden");
  await layer.commit();
  assert.equal(root.style.visibility, "hidden",
    "a committed candidate must remain concealed until the cross-generation handoff");
  layer.reveal();
  assert.equal(root.style.visibility, "visible");
  assert.equal(video.style.opacity, "1");
  assert.equal(video.playCount, 1);
  assert.equal(root.style.opacity, "0.82");
  assert.equal(layer.setOpacity(0.5), true);
  assert.equal(root.style.opacity, "0.41");
  assert.equal(layer.visualAudioElement(), video);
  layer.setAmbientMuted(false);
  assert.equal(video.muted, false);

  document.setHidden(true);
  assert.equal(video.paused, false, "background playback defaults to continuing while hidden");
  document.setHidden(false);
  await Promise.resolve();
  assert.equal(video.playCount, 1, "returning must not restart a video that kept playing");
  await layer.destroy();
  assert.equal(root.parentNode, null);
  assert.equal(video.src, "");
});

test("hot-switch candidate stays hidden until video playback is ready", async () => {
  const document = new FakeDocument();
  const service = await loadService(document);
  const layer = service.create({ config: config(), ledger: createLedger() });
  const root = document.created.find((element) =>
    element.getAttribute("data-dynamic-skin-root") !== null);
  const video = document.created.find((element) => element.tagName === "VIDEO");

  const ready = layer.ready();
  video.readyState = 1;
  video.emit("loadedmetadata");
  await new Promise((resolve) => setImmediate(resolve));
  video.emitFrame();
  await ready;

  let releasePlayback;
  video.play = () => new Promise((resolve) => {
    video.playCount += 1;
    video.paused = false;
    releasePlayback = resolve;
  });
  const committing = layer.commit();
  await Promise.resolve();

  assert.equal(root.style.visibility, "hidden",
    "the incoming theme must not overlap the active theme while playback startup is pending");
  releasePlayback();
  await committing;
  assert.equal(root.style.visibility, "hidden",
    "playback readiness must not expose the incoming theme before handoff");
  layer.reveal();
  assert.equal(root.style.visibility, "visible");
  assert.equal(video.style.opacity, "1");
  await layer.destroy();
});

test("hot-switch video is fully opaque before the poster fallback is removed", async () => {
  const document = new FakeDocument();
  const service = await loadService(document);
  const layer = service.create({ config: config(), ledger: createLedger() });
  const root = document.created.find((element) =>
    element.getAttribute("data-dynamic-skin-root") !== null);
  const video = document.created.find((element) => element.tagName === "VIDEO");
  const poster = document.created.find((element) => element.tagName === "IMG");

  const ready = layer.ready();
  video.readyState = 1;
  video.emit("loadedmetadata");
  await new Promise((resolve) => setImmediate(resolve));
  video.emitFrame();
  await ready;
  await layer.commit();

  assert.equal(root.style.visibility, "hidden");
  assert.equal(video.style.opacity, "1");
  assert.equal(poster.style.opacity, "0");
  assert.equal(video.style.transition, "none",
    "a concealed candidate must not begin an opacity fade after its poster has been removed");

  layer.reveal();
  assert.equal(root.style.visibility, "visible");
  assert.equal(video.style.opacity, "1");
  await layer.destroy();
});

test("adaptive video fills the window as one continuous surface without bands or duplicates", async () => {
  const document = new FakeDocument();
  const service = await loadService(document);
  const adaptiveConfig = config();
  adaptiveConfig.theme.visual.fit = "adaptive";
  adaptiveConfig.theme.visual.overscan = 1.12;
  const layer = service.create({ config: adaptiveConfig, ledger: createLedger() });
  const foreground = document.created.find((element) =>
    element.getAttribute("data-dynamic-skin-video") !== null);
  const duplicate = document.created.find((element) =>
    element.getAttribute("data-dynamic-skin-video-backdrop") !== null);

  assert.ok(foreground, "adaptive mode must retain one video for visuals and embedded audio");
  assert.equal(duplicate, undefined, "adaptive mode must not split the view across duplicate video layers");
  assert.equal(foreground.style.objectFit, "cover");
  assert.equal(foreground.style.transform, "scale(1.12)");

  const ready = layer.ready();
  foreground.readyState = 1;
  foreground.emit("loadedmetadata");
  await new Promise((resolve) => setImmediate(resolve));
  foreground.emitFrame();
  await ready;
  await layer.commit();

  assert.equal(foreground.playCount, 1);
  assert.equal(layer.visualAudioElement(), foreground);
  layer.setAmbientMuted(false);
  assert.equal(foreground.muted, false);

  assert.equal(layer.setBackgroundPlayback(false), true);
  document.setHidden(true);
  assert.equal(foreground.paused, true, "disabled background playback must freeze the current frame");
  document.setHidden(false);
  await Promise.resolve();
  assert.equal(foreground.playCount, 2, "returning must resume the same video");

  document.setHidden(true);
  assert.equal(foreground.paused, true);
  assert.equal(layer.setBackgroundPlayback(true), true);
  await Promise.resolve();
  assert.equal(foreground.paused, false, "enabling the setting while hidden must resume playback immediately");
  assert.equal(foreground.playCount, 3);

  const diagnostics = layer.diagnostics();
  assert.equal(diagnostics.fit, "adaptive");
  assert.equal(diagnostics.loop, true);
  assert.equal(diagnostics.movingBackdrop, false);
  await layer.destroy();
  assert.equal(foreground.src, "");
});

test("disabled background playback freezes on app blur and resumes on focus", async () => {
  const document = new FakeDocument();
  const service = await loadService(document);
  const layer = service.create({
    config: config({ settings: { reducedMotion: "off", visualOpacity: 1, backgroundPlayback: false } }),
    ledger: createLedger(),
  });
  const video = document.created.find((element) => element.tagName === "VIDEO");
  const ready = layer.ready();
  video.readyState = 1;
  video.emit("loadedmetadata");
  await new Promise((resolve) => setImmediate(resolve));
  video.emitFrame();
  await ready;
  await layer.commit();

  service.__testWindow?.dispatchEvent?.(new Event("blur"));
  assert.equal(video.paused, true, "switching to another app must freeze the current frame");
  service.__testWindow?.dispatchEvent?.(new Event("focus"));
  await Promise.resolve();
  assert.equal(video.paused, false, "returning to Codex must resume the same video");
  await layer.destroy();
});

test("disabling background playback reconciles focus lost before the media layer observed blur", async () => {
  const document = new FakeDocument();
  let focused = true;
  document.hasFocus = () => focused;
  const service = await loadService(document);
  const layer = service.create({ config: config(), ledger: createLedger() });
  const video = document.created.find((element) => element.tagName === "VIDEO");
  const ready = layer.ready();
  video.readyState = 1;
  video.emit("loadedmetadata");
  await new Promise((resolve) => setImmediate(resolve));
  video.emitFrame();
  await ready;
  await layer.commit();
  assert.equal(video.paused, false);

  focused = false;
  assert.equal(layer.setBackgroundPlayback(false), true);
  assert.equal(video.paused, true, "saving background playback off while already unfocused must freeze immediately");
  await layer.destroy();
});

test("reduced motion uses the poster and never starts video", async () => {
  const document = new FakeDocument();
  const service = await loadService(document, true);
  const layer = service.create({
    config: config({ settings: { reducedMotion: "system", backgroundPlayback: true } }),
    ledger: createLedger(),
  });
  const video = document.created.find((element) => element.tagName === "VIDEO");
  await layer.ready();
  await layer.commit();
  assert.equal(video.playCount, 0);
  assert.equal(video.style.display, "none");
  assert.equal(layer.diagnostics().mode, "poster");
  assert.equal(layer.setReducedMotion("off"), true);
  await Promise.resolve();
  assert.equal(video.style.display, "block");
  assert.equal(video.playCount, 1, "saving motion enabled must resume the existing video without restaging the theme");
  assert.equal(layer.setReducedMotion("on"), true);
  assert.equal(video.style.display, "none");
  assert.equal(video.paused, true);
  await layer.destroy();
});

test("failed initial video playback stays uncommitted and can be retried", async () => {
  const document = new FakeDocument();
  document.documentElement = document.createElement("html");
  const service = await loadService(document);
  const layer = service.create({ config: config(), ledger: createLedger() });
  const root = document.created.find((element) =>
    element.getAttribute("data-dynamic-skin-root") !== null);
  const video = document.created.find((element) => element.tagName === "VIDEO");
  const poster = document.created.find((element) => element.tagName === "IMG");
  const ready = layer.ready();
  video.readyState = 1;
  video.emit("loadedmetadata");
  await new Promise((resolve) => setImmediate(resolve));
  video.emitFrame();
  await ready;

  const successfulPlay = video.play.bind(video);
  video.play = async () => {
    video.playCount += 1;
    video.paused = true;
    throw new Error("autoplay blocked");
  };
  await assert.rejects(layer.commit(), /autoplay blocked/u);

  assert.equal(layer.reveal(), false,
    "a playback failure must not leave the candidate eligible for reveal");
  assert.equal(root.style.visibility, "hidden");
  assert.equal(root.style.opacity, "0");
  assert.equal(poster.style.opacity, "1");
  assert.equal(video.style.opacity, "0");
  assert.equal(document.documentElement.getAttribute("data-dynamic-skin-video-live"), null);

  video.play = successfulPlay;
  await layer.commit();
  assert.equal(layer.reveal(), true, "the same decoded candidate must remain retryable");
  assert.equal(root.style.visibility, "visible");
  assert.equal(poster.style.opacity, "0");
  assert.equal(video.style.opacity, "1");
  assert.equal(document.documentElement.getAttribute("data-dynamic-skin-video-live"), "true");
  await layer.destroy();
});

test("static tier keeps the poster visible when resumed video playback is rejected", async () => {
  const document = new FakeDocument();
  document.documentElement = document.createElement("html");
  document.body.style.backgroundImage = 'url("blob:app://legacy-theme")';
  const service = await loadService(document);
  const layer = service.create({ config: config(), ledger: createLedger() });
  const video = document.created.find((element) => element.tagName === "VIDEO");
  const poster = document.created.find((element) => element.tagName === "IMG");

  await prepareVideoLayer(layer, video);
  layer.reveal();
  assert.equal(layer.setTier("static"), true);
  assert.equal(poster.style.opacity, "1");

  video.play = async () => {
    video.playCount += 1;
    video.paused = true;
    throw new Error("autoplay blocked");
  };
  assert.equal(layer.setTier("media"), true);
  await Promise.resolve();

  assert.equal(document.body.style.backgroundImage, "none",
    "legacy artwork stays suppressed while the dynamic layer owns the surface");
  assert.equal(document.documentElement.getAttribute("data-dynamic-skin-video-live"), null,
    "rejected static-to-video playback must not advertise a live video");
  assert.equal(poster.style.opacity, "1",
    "the decoded poster must remain visible when static-to-video playback cannot resume");
  assert.equal(video.style.opacity, "0");
  await layer.destroy();
});

test("disabling reduced motion keeps the poster visible when resumed video playback is rejected", async () => {
  const document = new FakeDocument();
  document.documentElement = document.createElement("html");
  document.body.style.backgroundImage = 'url("blob:app://legacy-theme")';
  const service = await loadService(document);
  const layer = service.create({ config: config(), ledger: createLedger() });
  const video = document.created.find((element) => element.tagName === "VIDEO");
  const poster = document.created.find((element) => element.tagName === "IMG");

  await prepareVideoLayer(layer, video);
  layer.reveal();
  assert.equal(layer.setReducedMotion("on"), true);
  assert.equal(poster.style.opacity, "1");

  video.play = async () => {
    video.playCount += 1;
    video.paused = true;
    throw new Error("autoplay blocked");
  };
  assert.equal(layer.setReducedMotion("off"), true);
  await Promise.resolve();

  assert.equal(document.body.style.backgroundImage, "none",
    "legacy artwork stays suppressed while the dynamic layer owns the surface");
  assert.equal(document.documentElement.getAttribute("data-dynamic-skin-video-live"), null,
    "rejected reduced-motion playback must not advertise a live video");
  assert.equal(poster.style.opacity, "1",
    "the decoded poster must remain visible when reduced-motion video playback cannot resume");
  assert.equal(video.style.opacity, "0");
  await layer.destroy();
});

test("video error rejects staging and leaves no committed visual", async () => {
  const document = new FakeDocument();
  const service = await loadService(document);
  const layer = service.create({ config: config(), ledger: createLedger() });
  const video = document.created.find((element) => element.tagName === "VIDEO");
  const pending = layer.ready();
  video.emit("error");
  await assert.rejects(pending, (error) => error?.code === "MEDIA_DECODE");
  assert.equal(layer.diagnostics().phase, "failed");
  await layer.destroy();
});

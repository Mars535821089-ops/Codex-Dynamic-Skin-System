#!/usr/bin/env node

import { CdpSession, discoverTarget } from "./isolated-codex-acceptance.mjs";

const port = Number(process.argv[2] || 19342);
const durationMs = Number(process.argv[3] || 30000);
const intervalMs = Number(process.argv[4] || 25);
const requestedThemeId = process.argv[5] || null;
const requestMode = process.argv[6] || "direct";

const target = await discoverTarget(port);
const cdp = new CdpSession(target.webSocketDebuggerUrl);
await cdp.open();

const install = `(() => {
  const key = "__CODEX_DREAM_SKIN_FLICKER_AUDIT__";
  window[key]?.stop?.();
  let nextId = 0;
  const ids = new WeakMap();
  const idFor = (node) => {
    if (!node) return null;
    if (!ids.has(node)) ids.set(node, ++nextId);
    return ids.get(node);
  };
  const samples = [];
  const rootSnapshot = (root) => {
    const style = getComputedStyle(root);
    const opacity = Number(style.opacity);
    const video = root.querySelector?.("[data-dynamic-skin-video]");
    const poster = root.querySelector?.("[data-dynamic-skin-poster]");
    const effect = root.querySelector?.("[data-dynamic-skin-effect]");
    const effectStyle = effect ? getComputedStyle(effect) : null;
    return {
      id: idFor(root),
      visibility: style.visibility,
      display: style.display,
      opacity: Number.isFinite(opacity) ? opacity : null,
      connected: root.isConnected,
      videoId: idFor(video),
      videoOpacity: video ? Number(getComputedStyle(video).opacity) : null,
      posterOpacity: poster ? Number(getComputedStyle(poster).opacity) : null,
      effectVisible: Boolean(effect && effectStyle.display !== "none"
        && effectStyle.visibility !== "hidden" && Number(effectStyle.opacity) > 0.01),
    };
  };
  const take = (reason = "timer") => {
    const state = window.__CODEX_DREAM_SKIN_STATE__;
    const roots = [...document.querySelectorAll("[data-dynamic-skin-root]")];
    const videos = [...document.querySelectorAll("[data-dynamic-skin-video]")];
    const posters = [...document.querySelectorAll("[data-dynamic-skin-poster]")];
    const rootStates = roots.map(rootSnapshot);
    const visibleRoots = rootStates.filter((item) => item.connected
      && item.display !== "none" && item.visibility !== "hidden" && Number(item.opacity) > 0.01);
    const visibleRootIds = new Set(visibleRoots.map((item) => item.id));
    const root = roots.find((item) => visibleRootIds.has(idFor(item))) || roots[0] || null;
    const video = root?.querySelector?.("[data-dynamic-skin-video]") || videos[0] || null;
    const poster = root?.querySelector?.("[data-dynamic-skin-poster]") || posters[0] || null;
    const controls = [...document.querySelectorAll("[data-dynamic-skin-controls]")];
    const visibleControls = controls.filter((item) => {
      const style = getComputedStyle(item);
      return item.isConnected && style.display !== "none" && style.visibility !== "hidden"
        && Number(style.opacity) > 0.01;
    });
    samples.push({
      at: performance.now(),
      reason,
      themeId: state?.themeId || null,
      generation: state?.revision || null,
      stateId: idFor(state),
      dynamicId: idFor(state?.dynamic),
      legacyArt: document.documentElement.style.getPropertyValue("--dream-skin-art") || null,
      legacyStyleRegistrySize: window.__CODEX_DREAM_SKIN_STYLE_SHEETS__?.size ?? null,
      rootIds: roots.map(idFor),
      rootStates,
      rootCount: roots.length,
      visibleRootCount: visibleRoots.length,
      visibleRootIds: [...visibleRootIds],
      videoIds: videos.map(idFor),
      visibleVideoId: idFor(video),
      controlsCount: controls.length,
      visibleControlsCount: visibleControls.length,
      rootVisibility: root ? getComputedStyle(root).visibility : null,
      rootOpacity: root ? getComputedStyle(root).opacity : null,
      videoOpacity: video ? getComputedStyle(video).opacity : null,
      posterOpacity: poster ? getComputedStyle(poster).opacity : null,
      currentTime: video?.currentTime ?? null,
      duration: video?.duration ?? null,
      paused: video?.paused ?? null,
      readyState: video?.readyState ?? null,
      themeRequest: window.__CODEX_DYNAMIC_SKIN_THEME_REQUEST__ ? {
        id: window.__CODEX_DYNAMIC_SKIN_THEME_REQUEST__.id,
        fromThemeId: window.__CODEX_DYNAMIC_SKIN_THEME_REQUEST__.fromThemeId,
        sequence: window.__CODEX_DYNAMIC_SKIN_THEME_REQUEST__.sequence,
      } : null,
      actionRequest: window.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__ ? {
        action: window.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.action,
        themeId: window.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.themeId,
        targetThemeId: window.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.targetThemeId,
        sequence: window.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__.sequence,
      } : null,
    });
  };
  const timer = setInterval(take, ${intervalMs});
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.type === "childList"
      || (record.type === "attributes" && record.target?.matches?.("[data-dynamic-skin-root]")))) {
      take("mutation");
      queueMicrotask(() => take("mutation-microtask"));
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class"],
  });
  take("initial");
  window[key] = { samples, stop: () => { clearInterval(timer); observer.disconnect(); } };
  return true;
})()`;

try {
  await cdp.call("Runtime.evaluate", { expression: install, returnByValue: true });
  if (requestedThemeId) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const requestExpression = requestMode === "ui"
      ? `(() => {
        const host = document.querySelector("[data-dynamic-skin-controls]");
        const theme = host?.querySelector('[data-theme-id=${JSON.stringify(requestedThemeId)}]');
        const save = host?.querySelector('[data-skin-action="save"]');
        if (!host || !theme || !save) return { ok: false, reason: "theme-center-control-missing" };
        window.__CODEX_DYNAMIC_SKIN_THEME_CENTER_OPEN__ = true;
        host.style.display = "flex";
        theme.click();
        save.click();
        return { ok: true, mode: "ui", themeId: ${JSON.stringify(requestedThemeId)} };
      })()`
      : `(() => {
        const state = window.__CODEX_DREAM_SKIN_STATE__;
        const sequence = (Number(window.__CODEX_DYNAMIC_SKIN_REQUEST_SEQUENCE__) || 0) + 1;
        window.__CODEX_DYNAMIC_SKIN_REQUEST_SEQUENCE__ = sequence;
        window.__CODEX_DYNAMIC_SKIN_THEME_REQUEST__ = {
          id: ${JSON.stringify(requestedThemeId)},
          fromThemeId: state?.themeId,
          generation: state?.revision,
          issuedAt: Date.now(),
          sequence,
        };
        return window.__CODEX_DYNAMIC_SKIN_THEME_REQUEST__;
      })()`;
    await cdp.call("Runtime.evaluate", {
      expression: requestExpression,
      returnByValue: true,
    });
  }
  await new Promise((resolve) => setTimeout(resolve,
    Math.max(0, durationMs - (requestedThemeId ? 2000 : 0))));
  const response = await cdp.call("Runtime.evaluate", {
    expression: `(() => {
      const audit = window.__CODEX_DREAM_SKIN_FLICKER_AUDIT__;
      audit?.stop?.();
      const samples = audit?.samples || [];
      const unique = (key) => [...new Set(samples.flatMap((sample) => {
        const value = sample[key];
        return Array.isArray(value) ? value : [value];
      }).filter((value) => value !== null))];
      const sequence = (key) => samples.reduce((items, sample) => {
        const value = sample[key] ?? null;
        if (items.at(-1) !== value) items.push(value);
        return items;
      }, []);
      let timeResets = 0;
      let legacyArtChanges = 0;
      const blankVisualSamples = samples.filter((sample) => sample.rootStates.some((root) =>
        sample.visibleRootIds.includes(root.id)
        && !(Number(root.videoOpacity) > 0.01)
        && !(Number(root.posterOpacity) > 0.01)
        && !root.effectVisible));
      for (let index = 1; index < samples.length; index += 1) {
        const before = samples[index - 1].currentTime;
        const after = samples[index].currentTime;
        const duration = samples[index - 1].duration;
        if (samples[index - 1].visibleVideoId === samples[index].visibleVideoId
          && Number.isFinite(before) && Number.isFinite(after) && after + 0.2 < before
          && !(Number.isFinite(duration) && before > duration - 0.75 && after < 0.75)) timeResets += 1;
        if (samples[index - 1].legacyArt !== samples[index].legacyArt) legacyArtChanges += 1;
      }
      return {
        sampleCount: samples.length,
        themeIds: unique("themeId"),
        themeSequence: sequence("themeId"),
        generations: unique("generation"),
        generationSequence: sequence("generation"),
        stateIds: unique("stateId"),
        dynamicIds: unique("dynamicId"),
        legacyArts: unique("legacyArt"),
        legacyArtChanges,
        legacyStyleRegistrySizes: unique("legacyStyleRegistrySize"),
        rootIds: unique("rootIds"),
        videoIds: unique("videoIds"),
        rootCounts: unique("rootCount"),
        visibleRootCounts: unique("visibleRootCount"),
        controlsCounts: unique("controlsCount"),
        visibleControlsCounts: unique("visibleControlsCount"),
        zeroVisibleRootSampleCount: samples.filter((sample) => sample.visibleRootCount === 0).length,
        multiVisibleRootSampleCount: samples.filter((sample) => sample.visibleRootCount > 1).length,
        multiVisibleControlsSampleCount: samples.filter((sample) => sample.visibleControlsCount > 1).length,
        blankVisualSampleCount: blankVisualSamples.length,
        zeroVisibleRootSamples: samples.filter((sample) => sample.visibleRootCount === 0).slice(0, 20),
        multiVisibleRootSamples: samples.filter((sample) => sample.visibleRootCount > 1).slice(0, 20),
        multiVisibleControlsSamples: samples.filter((sample) => sample.visibleControlsCount > 1).slice(0, 20),
        blankVisualSamples: blankVisualSamples.slice(0, 20),
        mutationSamples: samples.filter((sample) => sample.reason !== "timer").slice(0, 60),
        rootVisibilities: unique("rootVisibility"),
        rootOpacities: unique("rootOpacity"),
        videoOpacities: unique("videoOpacity"),
        posterOpacities: unique("posterOpacity"),
        themeRequests: samples.filter((sample) => sample.themeRequest).slice(0, 20),
        actionRequests: samples.filter((sample) => sample.actionRequest).slice(0, 20),
        timeResets,
        pausedSamples: samples.filter((sample) => sample.paused === true).length,
        first: samples[0] || null,
        last: samples.at(-1) || null,
      };
    })()`,
    returnByValue: true,
  });
  console.log(JSON.stringify(response.result?.value, null, 2));
} finally {
  cdp.close();
}

(() => {
  const REGISTRY_KEY = "__CODEX_DYNAMIC_SKIN_MODULES__";
  const STATE_KEY = "__CODEX_DREAM_SKIN_STATE__";
  const NATIVE_STATE_KEY = "__CODEX_DYNAMIC_SKIN_NATIVE_STATE__";
  const NATIVE_ACTIVATION_TOKEN_KEY = "__codexDynamicSkinNativeActivationToken";
  const BASE_CLEANUP_KEY = "__codexDynamicSkinBaseCleanup";
  const ACTIVATION_TOKEN_KEY = "__codexDynamicSkinActivationToken";
  const PENDING_ACTIVATION_KEY = "__codexDynamicSkinPendingActivation";
  const LAST_ERROR_KEY = "__CODEX_DYNAMIC_SKIN_LAST_ERROR__";
  const SHA256_PATTERN = /^[0-9a-f]{64}$/;

  const audioEnabled = (theme) => theme?.audio?.ambient?.source !== "none"
    || Object.keys(theme?.audio?.ui?.events ?? {}).length > 0;
  const voxelEnabled = (theme) => theme?.visual?.kind === "builtin-effect"
    && theme?.effect?.id === "voxel-field";
  const mediaEnabled = (theme) => theme?.visual?.kind === "video"
    || theme?.visual?.kind === "image"
    || theme?.visual?.kind === "builtin-effect";

  function moduleEnabled(name, config) {
    if (config?.displayMode === "native") {
      return name === "controller" || name === "controls"
        || config?.enabledExtensions?.includes(name) === true;
    }
    const theme = config?.theme;
    switch (name) {
      case "controller":
      case "performance-policy":
        return true;
      case "media-layer":
        return mediaEnabled(theme);
      case "audio-bus":
        return audioEnabled(theme);
      case "controls":
        return true;
      case "semantic-events":
        return Object.keys(theme?.audio?.ui?.events ?? {}).length > 0;
      case "signal-model":
      case "voxel-field":
        return voxelEnabled(theme);
      default:
        return config?.enabledExtensions?.includes(name) === true;
    }
  }

  function requireConfig(config, registry) {
    if (!config || typeof config !== "object" || config.protocolVersion !== 1) {
      throw new Error("Dynamic skin config protocol is invalid.");
    }
    if (!config.theme || config.theme.schemaVersion !== 2) {
      throw new Error("Dynamic skin config requires a normalized Skin API v2 theme.");
    }
    if (!["deferred", "active"].includes(config.activation)) {
      throw new Error("Dynamic skin activation mode is invalid.");
    }
    if (!["theme", "native"].includes(config.displayMode ?? "theme")) {
      throw new Error("Dynamic skin display mode is invalid.");
    }
    if (!["deferred", "loopback", "renderer-blob"].includes(config.assetTransport)) {
      throw new Error("Dynamic skin asset transport is invalid.");
    }
    if (!Array.isArray(config.moduleHashes)) {
      throw new Error("Dynamic skin module hash list is missing.");
    }
    const expected = [
      "module-registry.js",
      ...[...registry.keys()].map((name) => `${name}.js`),
      "entry.js",
    ];
    if (config.moduleHashes.length !== expected.length) {
      throw new Error("Dynamic skin module hash order does not match the loaded bundle.");
    }
    for (let index = 0; index < expected.length; index += 1) {
      const entry = config.moduleHashes[index];
      if (!entry || Object.keys(entry).sort().join(",") !== "name,sha256"
        || entry.name !== expected[index] || !SHA256_PATTERN.test(entry.sha256)) {
        throw new Error("Dynamic skin module hash order does not match the loaded bundle.");
      }
    }
  }

  function disposeInstance(instance) {
    if (typeof instance?.cleanup === "function") return instance.cleanup();
    if (typeof instance?.destroy === "function") return instance.destroy();
    return undefined;
  }

  function recordFailure(error) {
    globalThis[LAST_ERROR_KEY] = Object.freeze({
      name: typeof error?.name === "string" ? error.name.slice(0, 64) : "Error",
      code: typeof error?.code === "string" ? error.code.slice(0, 64) : "STAGE_FAILED",
    });
  }

  function isPrivateExtension(name, config) {
    return Array.isArray(config?.enabledExtensions)
      && config.enabledExtensions.includes(name);
  }

  function serializedModuleFailure(error) {
    return Object.freeze({
      name: typeof error?.name === "string" ? error.name.slice(0, 64) : "Error",
      code: typeof error?.code === "string"
        ? error.code.slice(0, 64) : "MODULE_ACTIVATION_FAILED",
    });
  }

  function createEnabledModules(config, registry, instances, moduleFailures) {
    for (const [name, factory] of registry) {
      if (!moduleEnabled(name, config)) continue;
      const context = Object.freeze({
        config,
        modules: instances,
        document: globalThis.document,
        window: globalThis,
      });
      try {
        instances.set(name, factory(context));
      } catch (error) {
        if (!isPrivateExtension(name, config)) throw error;
        moduleFailures.set(name, serializedModuleFailure(error));
      }
    }
  }

  function diagnosticsWithFailures(detail, moduleFailures) {
    if (moduleFailures.size === 0) return detail;
    return Object.freeze({
      ...(detail && typeof detail === "object" ? detail : {}),
      moduleFailures: Object.freeze(Object.fromEntries(moduleFailures)),
    });
  }

  function rendererOwnedUrls(config) {
    if (config.assetTransport !== "renderer-blob") return [];
    return [...new Set(Object.values(config.assets ?? {}).filter((value) =>
      typeof value === "string" && value.startsWith("blob:app:")))];
  }

  function revokeRendererUrls(urls) {
    for (const url of urls) {
      try { URL.revokeObjectURL(url); } catch {}
    }
    urls.length = 0;
  }

  function visibleOwnedRoot() {
    const document = globalThis.document;
    let roots;
    try {
      roots = typeof document?.querySelectorAll === "function"
        ? [...document.querySelectorAll("[data-dynamic-skin-root]")] : [];
    } catch {
      return false;
    }
    if (roots.length !== 1) return false;
    const root = roots[0];
    if (!root || root.parentNode !== document.body || root.hidden === true
      || root.isConnected === false) return false;

    if (typeof root.checkVisibility === "function") {
      try {
        if (!root.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      } catch {
        try { if (!root.checkVisibility()) return false; } catch { return false; }
      }
    }
    let style;
    try { style = globalThis.getComputedStyle?.(root) ?? root.style; } catch { return false; }
    if (style?.display === "none" || style?.visibility === "hidden"
      || style?.visibility === "collapse") return false;
    const opacity = Number.parseFloat(style?.opacity ?? "1");
    if (Number.isFinite(opacity) && opacity <= 0) return false;

    let bounds;
    try { bounds = root.getBoundingClientRect?.(); } catch { return false; }
    if (!bounds || !(Number(bounds.width) > 0) || !(Number(bounds.height) > 0)) return false;
    const viewportWidth = Number(globalThis.innerWidth ?? document.documentElement?.clientWidth ?? 0);
    const viewportHeight = Number(globalThis.innerHeight ?? document.documentElement?.clientHeight ?? 0);
    if (viewportWidth > 0 && viewportHeight > 0
      && (Number(bounds.right) <= 0 || Number(bounds.bottom) <= 0
        || Number(bounds.left) >= viewportWidth || Number(bounds.top) >= viewportHeight)) return false;
    return true;
  }

  function reusableDynamicState(state, config) {
    if (state?.generation !== config.generation || state?.activation !== config.activation) {
      return false;
    }
    if (config.activation !== "active") return true;
    let diagnostics;
    try { diagnostics = state.diagnostics?.(); } catch { return false; }
    const media = diagnostics?.modules?.["media-layer"];
    return diagnostics?.phase === "active" && media?.connected === true
      && media?.revealed === true && visibleOwnedRoot();
  }

  async function activateNativeMode(config, registry) {
    const current = globalThis[NATIVE_STATE_KEY];
    if (current?.generation === config.generation && current?.activation === config.activation) {
      return current;
    }
    const activationToken = Object.freeze({
      generation: config.generation,
      activation: config.activation,
    });
    globalThis[NATIVE_ACTIVATION_TOKEN_KEY] = activationToken;

    const rootState = globalThis[STATE_KEY];
    if (typeof rootState?.cleanup === "function") {
      await rootState.cleanup();
    }
    if (globalThis[STATE_KEY] === rootState) delete globalThis[STATE_KEY];
    if (current && current !== globalThis[NATIVE_STATE_KEY]) return globalThis[NATIVE_STATE_KEY];
    if (typeof current?.cleanup === "function") await current.cleanup();
    if (globalThis[NATIVE_ACTIVATION_TOKEN_KEY] !== activationToken) {
      return globalThis[NATIVE_STATE_KEY];
    }

    const instances = new Map();
    const moduleFailures = new Map();
    const ownedUrls = rendererOwnedUrls(config);
    let cleaned = false;
    const nativeState = {
      generation: config.generation,
      activation: config.activation,
      displayMode: "native",
      modules: Object.freeze([]),
      diagnostics() {
        const controller = instances.get("controller");
        const detail = typeof controller?.diagnostics === "function"
          ? controller.diagnostics()
          : Object.freeze({ generation: config.generation, phase: config.activation });
        const extensions = {};
        for (const [name, instance] of instances) {
          if (name === "controller" || typeof instance?.diagnostics !== "function") continue;
          try { extensions[name] = JSON.parse(JSON.stringify(instance.diagnostics())); } catch {
            extensions[name] = { error: "diagnostics-unavailable" };
          }
        }
        const combined = Object.keys(extensions).length === 0 ? detail : Object.freeze({
          ...detail,
          modules: Object.freeze({ ...(detail?.modules ?? {}), ...extensions }),
        });
        return diagnosticsWithFailures(combined, moduleFailures);
      },
      async cleanup() {
        if (cleaned) return false;
        cleaned = true;
        for (const instance of [...instances.values()].reverse()) {
          try { await disposeInstance(instance); } catch {}
        }
        instances.clear();
        revokeRendererUrls(ownedUrls);
        if (globalThis[NATIVE_STATE_KEY] === nativeState) delete globalThis[NATIVE_STATE_KEY];
        return true;
      },
    };

    try {
      if (config.activation === "active") {
        createEnabledModules(config, registry, instances, moduleFailures);
        const controller = instances.get("controller");
        if (typeof controller?.stage !== "function") {
          throw new Error("Dynamic skin controller is unavailable.");
        }
        await controller.stage(config);
        if (globalThis[NATIVE_ACTIVATION_TOKEN_KEY] !== activationToken) {
          await nativeState.cleanup();
          return globalThis[NATIVE_STATE_KEY];
        }
        if (typeof controller.activate === "function") await controller.activate();
      }
      nativeState.modules = Object.freeze([...instances.keys()]);
      globalThis[NATIVE_STATE_KEY] = nativeState;
      return nativeState;
    } catch (error) {
      await nativeState.cleanup();
      recordFailure(error);
      throw error;
    }
  }

  globalThis.__startCodexDynamicSkin = (config) => {
    delete globalThis[LAST_ERROR_KEY];
    const registry = globalThis[REGISTRY_KEY];
    if (!(registry instanceof Map)) {
      throw new Error("Dynamic skin module registry is invalid.");
    }
    requireConfig(config, registry);
    if ((config.displayMode ?? "theme") === "native") {
      return activateNativeMode(config, registry);
    }

    const rootState = globalThis[STATE_KEY];
    if (!rootState || typeof rootState !== "object" || typeof rootState.cleanup !== "function") {
      throw new Error("Dynamic skin requires the owned Dream Skin root state.");
    }
    if (reusableDynamicState(rootState.dynamic, config)) {
      return Promise.resolve(rootState.dynamic);
    }
    const pendingIdentity = `${config.displayMode ?? "theme"}\0${config.activation}\0${config.generation}`;
    const pending = globalThis[PENDING_ACTIVATION_KEY];
    if (pending?.identity === pendingIdentity && pending.promise) return pending.promise;
    // Theme media staging is asynchronous. A slower, older video can finish
    // after a newer request has already committed; without an ownership token
    // that stale activation would reveal itself and overwrite the new theme.
    const activationToken = Object.freeze({
      generation: config.generation,
      activation: config.activation,
    });
    rootState[ACTIVATION_TOKEN_KEY] = activationToken;
    const instances = new Map();
    const moduleFailures = new Map();
    const ownedUrls = rendererOwnedUrls(config);
    try {
      if (config.activation === "active") {
        createEnabledModules(config, registry, instances, moduleFailures);
      }
    } catch (error) {
      for (const instance of [...instances.values()].reverse()) {
        try { disposeInstance(instance); } catch {}
      }
      revokeRendererUrls(ownedUrls);
      recordFailure(error);
      throw error;
    }

    let cleaned = false;
    const dynamicState = {
      generation: config.generation,
      activation: config.activation,
      modules: Object.freeze([...instances.keys()]),
      diagnostics() {
        const controller = instances.get("controller");
        const detail = typeof controller?.diagnostics === "function"
          ? controller.diagnostics()
          : Object.freeze({ generation: config.generation, phase: config.activation });
        return diagnosticsWithFailures(detail, moduleFailures);
      },
      reveal() {
        const controller = instances.get("controller");
        return typeof controller?.activate === "function" ? controller.activate() : false;
      },
      conceal() {
        const controller = instances.get("controller");
        return typeof controller?.conceal === "function" ? controller.conceal() : false;
      },
      async cleanup() {
        if (cleaned) return false;
        cleaned = true;
        for (const instance of [...instances.values()].reverse()) {
          try { await disposeInstance(instance); } catch {}
        }
        instances.clear();
        revokeRendererUrls(ownedUrls);
        if (rootState.dynamic === dynamicState) delete rootState.dynamic;
        return true;
      },
    };

    if (!Object.hasOwn(rootState, BASE_CLEANUP_KEY)) {
      Object.defineProperty(rootState, BASE_CLEANUP_KEY, {
        value: rootState.cleanup,
        configurable: true,
      });
    }
    let previousForRollback = null;
    let previousWasConcealed = false;
    if (config.activation === "deferred") {
      // The persistent page bootstrap consumes this state immediately after
      // evaluating the payload. Keep the deferred shell synchronous: it owns
      // no DOM/media resources, so there is no visual handoff to await.
      const previous = rootState.dynamic;
      const baseCleanup = rootState[BASE_CLEANUP_KEY];
      rootState.themeId = config.theme.id;
      rootState.revision = config.generation;
      rootState.dynamic = dynamicState;
      rootState.cleanup = async function cleanupOwnedSkinState() {
        await dynamicState.cleanup();
        delete rootState[BASE_CLEANUP_KEY];
        rootState.cleanup = baseCleanup;
        return baseCleanup.call(rootState);
      };
      if (previous && previous !== dynamicState) {
        Promise.resolve(previous.cleanup?.()).catch(() => {});
      }
      return dynamicState;
    }
    const activate = async () => {
      if (config.activation === "active") {
        const controller = instances.get("controller");
        if (typeof controller?.stage !== "function") {
          throw new Error("Dynamic skin controller is unavailable.");
        }
        await controller.stage(config);
      }
      if (rootState[ACTIVATION_TOKEN_KEY] !== activationToken) {
        await dynamicState.cleanup();
        return rootState.dynamic;
      }
      const previous = rootState.dynamic;
      previousForRollback = previous && previous !== dynamicState ? previous : null;
      const baseCleanup = rootState[BASE_CLEANUP_KEY];
      // Cross-generation visual handoff: invoke every reveal/conceal side effect
      // in one JavaScript task, then await any asynchronous follow-up together.
      // Revealing first means there is never a compositor frame with zero
      // visible roots; concealing immediately afterwards prevents dual playback.
      let revealTask = true;
      let concealTask = true;
      if (config.activation === "active") revealTask = dynamicState.reveal();
      if (previous && previous !== dynamicState) {
        if (typeof previous.conceal === "function") {
          concealTask = previous.conceal();
          previousWasConcealed = true;
        }
        else concealTask = previous.cleanup?.();
      }
      await Promise.all([revealTask, concealTask]);
      if (rootState[ACTIVATION_TOKEN_KEY] !== activationToken) {
        await dynamicState.cleanup();
        if (previousWasConcealed && rootState.dynamic === previous
          && typeof previous?.reveal === "function") {
          try { await previous.reveal(); } catch {}
        }
        return rootState.dynamic;
      }
      // Commit the renderer identity at the same boundary as the staged
      // dynamic generation. The watcher verifies these legacy root fields;
      // leaving them on the previous theme makes a successful hot swap look
      // failed and triggers a rollback (visually: switch, then switch back).
      rootState.themeId = config.theme.id;
      rootState.revision = config.generation;
      rootState.dynamic = dynamicState;
      rootState.cleanup = async function cleanupOwnedSkinState() {
        await dynamicState.cleanup();
        delete rootState[BASE_CLEANUP_KEY];
        rootState.cleanup = baseCleanup;
        return baseCleanup.call(rootState);
      };
      if (previous && previous !== dynamicState) await previous.cleanup?.();
      // Upgrades from older injectors can leave media roots that are no longer
      // reachable through the owned state object. Remove those only after the
      // replacement is visible and the tracked previous generation has
      // completed cleanup, so one committed root remains at all times.
      if (config.activation === "active") {
        try { await instances.get("controller")?.pruneOrphanedMediaRoots?.(); } catch {}
      }
      return dynamicState;
    };
    const activationPromise = activate().catch(async (error) => {
      if (rootState[ACTIVATION_TOKEN_KEY] !== activationToken) {
        try { await dynamicState.cleanup(); } catch {}
        return rootState.dynamic;
      }
      for (const instance of [...instances.values()].reverse()) {
        try { await disposeInstance(instance); } catch {}
      }
      instances.clear();
      revokeRendererUrls(ownedUrls);
      if (previousWasConcealed && rootState.dynamic === previousForRollback
        && typeof previousForRollback?.reveal === "function") {
        try { await previousForRollback.reveal(); } catch {}
      }
      recordFailure(error);
      throw error;
    });
    globalThis[PENDING_ACTIVATION_KEY] = Object.freeze({
      identity: pendingIdentity,
      promise: activationPromise,
    });
    const clearPending = () => {
      if (globalThis[PENDING_ACTIVATION_KEY]?.promise === activationPromise) {
        delete globalThis[PENDING_ACTIVATION_KEY];
      }
    };
    activationPromise.then(clearPending, clearPending);
    return activationPromise;
  };
})();

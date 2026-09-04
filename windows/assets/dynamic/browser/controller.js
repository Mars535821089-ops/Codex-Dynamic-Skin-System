(() => {
  const register = globalThis.__registerCodexDynamicSkinModule;
  if (typeof register !== "function") throw new Error("Dynamic skin registry is unavailable.");

  class DynamicSkinControllerError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "DynamicSkinControllerError";
      this.code = code;
    }
  }

  function createResourceLedger() {
    const resources = [];
    const counts = new Map();
    let cleaned = false;
    return {
      track(kind, disposer) {
        if (cleaned || !/^[a-z][a-z0-9-]*$/.test(kind) || typeof disposer !== "function") {
          throw new DynamicSkinControllerError("RESOURCE", "Dynamic skin resource registration is invalid.");
        }
        resources.push({ kind, disposer });
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        return disposer;
      },
      snapshot() {
        return Object.fromEntries([...counts].filter(([, count]) => count > 0));
      },
      async cleanup() {
        if (cleaned) return false;
        cleaned = true;
        const errors = [];
        for (const resource of resources.reverse()) {
          try { await resource.disposer(); } catch (error) { errors.push(error); }
          counts.set(resource.kind, Math.max(0, (counts.get(resource.kind) ?? 1) - 1));
        }
        resources.length = 0;
        if (errors.length) throw new AggregateError(errors, "Dynamic skin resource cleanup failed: "
          + errors.map((error) => error?.message ?? String(error)).join("; "));
        return true;
      },
    };
  }

  async function disposeModules(instances) {
    const errors = [];
    for (const instance of [...instances].reverse()) {
      const dispose = instance?.destroy ?? instance?.cleanup;
      if (typeof dispose !== "function") continue;
      try { await dispose.call(instance); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Dynamic skin module cleanup failed: "
      + errors.map((error) => error?.message ?? String(error)).join("; "));
  }

  function moduleDiagnostics(instances) {
    const output = {};
    for (const [name, instance] of instances) {
      if (typeof instance?.diagnostics !== "function") continue;
      try { output[name] = JSON.parse(JSON.stringify(instance.diagnostics())); } catch {
        output[name] = { error: "diagnostics-unavailable" };
      }
    }
    return output;
  }

  async function createCandidate(config, modules) {
    const ledger = createResourceLedger();
    const instances = new Map();
    try {
      const creationOrder = ["media-layer", "audio-bus", "performance-policy",
        "signal-model", "voxel-field", "semantic-events", "controls"];
      for (const name of creationOrder) {
        const service = modules.get(name);
        if (typeof service?.create !== "function") continue;
        const instance = await service.create({ config, theme: config.theme, assets: config.assets,
          settings: config.settings, modules: instances, ledger });
        instances.set(name, instance);
      }
      return {
        generation: config.generation,
        ledger,
        instances,
        async ready() {
          for (const instance of instances.values()) {
            if (typeof instance?.prepare === "function") await instance.prepare();
            if (typeof instance?.ready === "function") await instance.ready();
          }
        },
        async commit() {
          for (const instance of instances.values()) {
            if (typeof instance?.commit === "function") await instance.commit();
          }
        },
        reveal() {
          const pending = [];
          for (const instance of instances.values()) {
            if (typeof instance?.reveal !== "function") continue;
            const result = instance.reveal();
            if (result && typeof result.then === "function") pending.push(result);
          }
          return pending.length ? Promise.all(pending) : true;
        },
        conceal() {
          const pending = [];
          for (const instance of [...instances.values()].reverse()) {
            if (typeof instance?.conceal !== "function") continue;
            const result = instance.conceal();
            if (result && typeof result.then === "function") pending.push(result);
          }
          return pending.length ? Promise.all(pending) : true;
        },
        pruneOrphanedMediaRoots() {
          return instances.get("media-layer")?.pruneOrphanedRoots?.() ?? 0;
        },
        async destroy() {
          const errors = [];
          try { await disposeModules(instances.values()); } catch (error) { errors.push(error); }
          instances.clear();
          try { await ledger.cleanup(); } catch (error) { errors.push(error); }
          if (errors.length) throw new AggregateError(errors, "Dynamic skin candidate cleanup failed: "
            + errors.map((error) => error?.message ?? String(error)).join("; "));
        },
        diagnostics() {
          return { modules: moduleDiagnostics(instances), resources: ledger.snapshot() };
        },
      };
    } catch (error) {
      try { await disposeModules(instances.values()); } catch {}
      try { await ledger.cleanup(); } catch {}
      throw error;
    }
  }

  register("controller", ({ modules }) => {
    let sequence = 0;
    let current = null;
    let phase = "idle";
    let stagingGeneration = null;
    let lastError = null;

    const controller = {
      async stage(config) {
        if (!config || typeof config !== "object" || typeof config.generation !== "string") {
          throw new DynamicSkinControllerError("CONFIG", "Dynamic skin generation config is invalid.");
        }
        if (phase === "active" && current?.generation === config.generation) {
          return Object.freeze({ generation: current.generation, phase, ...current.diagnostics() });
        }
        const token = ++sequence;
        phase = "staging";
        stagingGeneration = config.generation;
        lastError = null;
        let candidate;
        try {
          candidate = await createCandidate(config, modules);
          await candidate.ready();
          if (token !== sequence) {
            await candidate.destroy();
            throw new DynamicSkinControllerError("SUPERSEDED", "Dynamic skin generation was superseded.");
          }
          await candidate.commit();
          if (token !== sequence) {
            await candidate.destroy();
            throw new DynamicSkinControllerError("SUPERSEDED", "Dynamic skin generation was superseded.");
          }
          const previous = current;
          current = candidate;
          phase = "active";
          stagingGeneration = null;
          if (previous) await previous.destroy();
          return Object.freeze({ generation: current.generation, phase, ...current.diagnostics() });
        } catch (error) {
          if (candidate && candidate !== current && error?.code !== "SUPERSEDED") {
            try { await candidate.destroy(); } catch (cleanupError) {
              error = new AggregateError([error, cleanupError], `Dynamic skin staging failed: ${error.message}; ${cleanupError.message}`);
            }
          }
          if (token === sequence) {
            phase = current ? "active" : "idle";
            stagingGeneration = null;
            lastError = error?.code ?? "STAGE_FAILED";
          }
          throw error;
        }
      },
      async destroy() {
        ++sequence;
        stagingGeneration = null;
        const previous = current;
        current = null;
        phase = "idle";
        if (!previous) return false;
        await previous.destroy();
        return true;
      },
      activate() {
        if (!current) return false;
        return current.reveal();
      },
      conceal() {
        if (!current) return false;
        return current.conceal();
      },
      pruneOrphanedMediaRoots() {
        return current?.pruneOrphanedMediaRoots?.() ?? 0;
      },
      cleanup() { return controller.destroy(); },
      diagnostics() {
        const detail = current?.diagnostics() ?? { modules: {}, resources: {} };
        return Object.freeze({
          generation: current?.generation ?? stagingGeneration,
          phase,
          modules: detail.modules,
          resources: detail.resources,
          ...(lastError ? { lastError } : {}),
        });
      },
    };
    return controller;
  });
})();

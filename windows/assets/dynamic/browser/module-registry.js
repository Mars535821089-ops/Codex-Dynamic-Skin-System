(() => {
  const KEY = "__CODEX_DYNAMIC_SKIN_MODULES__";
  // Each integrity-checked payload is a complete bundle. A fresh registry
  // makes retries and hot theme replacement independent from stale modules
  // left by an earlier payload or a partially failed activation.
  const registry = new Map();
  globalThis[KEY] = registry;
  globalThis.__registerCodexDynamicSkinModule = (name, factory) => {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || typeof factory !== "function" || registry.has(name)) {
      throw new Error(`Invalid or duplicate dynamic skin module: ${String(name)}`);
    }
    registry.set(name, factory);
  };
})();

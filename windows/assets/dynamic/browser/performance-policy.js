(() => {
  const register = globalThis.__registerCodexDynamicSkinModule;
  if (typeof register !== "function") throw new Error("Dynamic skin registry is unavailable.");

  const ORDER = Object.freeze(["static", "media", "balanced", "full"]);
  const allowedTier = (value) => ORDER.includes(value);

  register("performance-policy", ({ document, window }) => ({
    create({ config, modules }) {
      const settings = config.settings ?? {};
      const effect = config.theme?.visual?.kind === "builtin-effect";
      const systemReduced = () => Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
      const resolveReduced = (preference) => preference === "on"
        || (preference === "system" && systemReduced());
      const automaticTier = () => effect && typeof window.WebGL2RenderingContext !== "function" ? "media"
        : effect && Number(window.innerWidth ?? 1024) < 700 ? "balanced" : "full";
      let reduced = resolveReduced(settings.reducedMotion);
      let current = reduced ? "static"
        : allowedTier(settings.quality) && settings.quality !== "auto" ? settings.quality : automaticTier();
      let slowVisibleMs = 0;
      let destroyed = false;

      function apply(next, reason) {
        if (destroyed || !allowedTier(next) || ORDER.indexOf(next) >= ORDER.indexOf(current)) return false;
        current = next;
        slowVisibleMs = 0;
        modules.get("media-layer")?.setTier?.(current);
        modules.get("voxel-field")?.setTier?.(current);
        return { tier: current, reason };
      }

      function setPreference(quality, reducedMotion) {
        if (!["auto", ...ORDER].includes(quality)
          || !["system", "on", "off"].includes(reducedMotion)) return false;
        reduced = resolveReduced(reducedMotion);
        current = reduced ? "static" : quality === "auto" ? automaticTier() : quality;
        slowVisibleMs = 0;
        modules.get("media-layer")?.setTier?.(current);
        modules.get("voxel-field")?.setTier?.(current);
        return current;
      }

      const api = {
        tier() { return current; },
        observeFrame(frameMs, elapsedMs = frameMs) {
          if (destroyed || document.hidden || !Number.isFinite(frameMs) || !Number.isFinite(elapsedMs)) return current;
          const threshold = current === "full" ? 25 : current === "balanced" ? 40 : Infinity;
          slowVisibleMs = frameMs > threshold ? slowVisibleMs + Math.max(0, elapsedMs) : 0;
          if (slowVisibleMs >= 5000) apply(current === "full" ? "balanced" : "media", "sustained-frame-time");
          return current;
        },
        forceFallback(reason = "runtime-failure") {
          return apply(current === "static" ? "static" : "media", reason);
        },
        setPreference,
        diagnostics() { return Object.freeze({ tier: current, reducedMotion: reduced, slowVisibleMs }); },
        destroy() { if (destroyed) return false; destroyed = true; slowVisibleMs = 0; return true; },
      };
      modules.get("media-layer")?.setTier?.(current);
      return api;
    },
  }));
})();

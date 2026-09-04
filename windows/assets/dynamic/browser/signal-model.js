(() => {
  const register = globalThis.__registerCodexDynamicSkinModule;
  if (typeof register !== "function") throw new Error("Dynamic skin registry is unavailable.");

  const BAND_COUNT = 32;
  const clamp01 = (value) => Math.min(1, Math.max(0, value));

  register("signal-model", ({ document }) => ({
    create({ config, modules }) {
      const audioBus = modules.get("audio-bus");
      const policy = modules.get("performance-policy");
      const source = config.theme.effect?.source === "ambient" ? "ambient" : "procedural";
      const smoothing = clamp01(config.theme.effect?.parameters?.smoothing ?? 0.72);
      const bands = new Float32Array(BAND_COUNT);
      let frequency = new Uint8Array(0);
      let analyser = null;
      let floor = 0.025;
      let ceiling = 0.35;
      let samples = 0;
      let destroyed = false;
      let lastTime = null;

      function ensureAnalyser() {
        const next = source === "ambient" ? audioBus?.analyser?.() : null;
        if (!next) return null;
        const fftSize = policy?.tier?.() === "full" ? 1024 : 512;
        if (next.fftSize !== fftSize) next.fftSize = fftSize;
        const count = Math.max(1, next.frequencyBinCount ?? fftSize / 2);
        if (frequency.length !== count) frequency = new Uint8Array(count);
        analyser = next;
        return next;
      }

      function procedural(time, index) {
        const t = time * 0.001;
        return 0.16 + 0.10 * (0.5 + 0.5 * Math.sin(t * 0.73 + index * 0.51))
          + 0.05 * (0.5 + 0.5 * Math.sin(t * 1.31 - index * 0.19));
      }

      const api = {
        sample(time = 0) {
          if (destroyed || document.hidden) return bands;
          if (lastTime === time) return bands;
          lastTime = time;
          const active = ensureAnalyser();
          if (active) active.getByteFrequencyData(frequency);
          let peak = 0;
          for (let index = 0; index < BAND_COUNT; index += 1) {
            let raw;
            if (active) {
              const start = Math.floor((Math.exp(index / BAND_COUNT * Math.log(frequency.length + 1)) - 1));
              const end = Math.max(start + 1,
                Math.floor((Math.exp((index + 1) / BAND_COUNT * Math.log(frequency.length + 1)) - 1)));
              let sum = 0;
              for (let cursor = start; cursor < Math.min(end, frequency.length); cursor += 1) sum += frequency[cursor];
              raw = sum / Math.max(1, Math.min(end, frequency.length) - start) / 255;
            } else raw = procedural(time, index);
            peak = Math.max(peak, raw);
            const normalized = clamp01((raw - floor) / Math.max(0.08, ceiling - floor));
            const coefficient = normalized > bands[index] ? Math.min(0.68, 1 - smoothing * 0.55)
              : Math.min(0.32, (1 - smoothing) * 0.22 + 0.035);
            bands[index] += (normalized - bands[index]) * coefficient;
          }
          floor += ((peak * 0.12) - floor) * 0.002;
          ceiling += (Math.max(0.25, peak) - ceiling) * (peak > ceiling ? 0.03 : 0.0015);
          samples += 1;
          return bands;
        },
        diagnostics() { return Object.freeze({ source: analyser ? "ambient" : "procedural", bands: BAND_COUNT, samples }); },
        destroy() { if (destroyed) return false; destroyed = true; frequency = new Uint8Array(0); bands.fill(0); return true; },
      };
      return api;
    },
  }));
})();

(() => {
  const register = globalThis.__registerCodexDynamicSkinModule;
  if (typeof register !== "function") throw new Error("Dynamic skin registry is unavailable.");

  class AudioBusError extends Error {
    constructor(code, message) { super(message); this.name = "AudioBusError"; this.code = code; }
  }
  const clamp = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const UI_CLIP_FETCH_TIMEOUT_MS = 5000;

  register("audio-bus", ({ document, window }) => ({
    create({ config, modules, ledger, now = () => Date.now() }) {
      const { theme, assets } = config;
      const ambientConfig = theme.audio.ambient;
      const uiConfig = theme.audio.ui;
      const mediaLayer = modules.get("media-layer");
      let settings = { ...config.settings };
      let context = null;
      let masterGain = null;
      let ambientGain = null;
      let uiGain = null;
      let analyserNode = null;
      let ambientSource = null;
      let unlocked = false;
      let destroyed = false;
      let status = "locked";
      let uiStatus = Object.keys(uiConfig.events).length ? "pending" : "none";
      const decodedClips = new Map();
      const mediaClips = new Map();
      const lastPlayed = new Map();
      const voices = new Set();
      const disposers = [];
      const uiPlayback = { requested: 0, played: 0, rejected: 0 };
      const uiPlaybackByEvent = new Map();

      function recordUi(eventName, outcome) {
        const name = String(eventName ?? "").slice(0, 128);
        const entry = uiPlaybackByEvent.get(name) ?? { requested: 0, played: 0, rejected: 0 };
        entry.requested += outcome === "requested" ? 1 : 0;
        entry.played += outcome === "played" ? 1 : 0;
        entry.rejected += outcome === "rejected" ? 1 : 0;
        uiPlaybackByEvent.set(name, entry);
        uiPlayback[outcome] += 1;
      }

      const ambientElement = ambientConfig.source === "asset" ? document.createElement("audio") : null;
      if (ambientElement) {
        ambientElement.preload = "metadata";
        ambientElement.crossOrigin = "anonymous";
        ambientElement.loop = ambientConfig.loop !== false;
        ambientElement.muted = true;
        ambientElement.src = assets[ambientConfig.asset];
        ambientElement.style.display = "none";
        document.body.append(ambientElement);
      }
      const visualElement = ambientConfig.source === "visual" ? mediaLayer?.visualAudioElement?.() : null;
      mediaLayer?.setAmbientMuted?.(true);

      function applyGains() {
        if (!context) return;
        const enabled = settings.soundEnabled && unlocked;
        masterGain.gain.value = enabled ? clamp(settings.masterVolume) : 0;
        ambientGain.gain.value = enabled && !settings.ambientMuted
          ? clamp(settings.ambientVolume) * clamp(ambientConfig.volume) : 0;
        uiGain.gain.value = enabled && !settings.uiMuted
          ? clamp(settings.uiVolume) * clamp(uiConfig.volume) : 0;
        const mediaVolume = clamp(masterGain.gain.value * uiGain.gain.value);
        for (const voice of voices) {
          if (voice?.tagName === "AUDIO") voice.volume = mediaVolume;
        }
        const ambientAudible = enabled && !settings.ambientMuted && ambientGain.gain.value > 0;
        if (visualElement) mediaLayer?.setAmbientMuted?.(!ambientAudible);
        if (ambientElement) ambientElement.muted = !ambientAudible;
      }

      async function decodeUiClip(assetUrl, eventName) {
        const controller = new window.AbortController();
        let timeout = null;
        const deadline = new Promise((_resolve, reject) => {
          timeout = window.setTimeout(() => {
            controller.abort();
            reject(new AudioBusError("AUDIO_TIMEOUT",
              `Dynamic skin UI audio timed out: ${eventName}`));
          }, UI_CLIP_FETCH_TIMEOUT_MS);
        });
        try {
          return await Promise.race([
            (async () => {
              const response = await window.fetch(assetUrl, {
                cache: "no-store", credentials: "omit", signal: controller.signal,
              });
              if (!response?.ok) {
                throw new AudioBusError("AUDIO_FETCH",
                  `Dynamic skin UI audio could not be loaded: ${eventName}`);
              }
              return await context.decodeAudioData(await response.arrayBuffer());
            })(),
            deadline,
          ]);
        } finally {
          window.clearTimeout(timeout);
        }
      }

      async function prepareUiClips() {
        let failures = 0;
        for (const [eventName, assetPath] of Object.entries(uiConfig.events)) {
          if (decodedClips.has(eventName) || mediaClips.has(eventName)) continue;
          const assetUrl = assets[assetPath];
          if (typeof assetUrl !== "string") { failures += 1; continue; }
          // Electron renderer-owned blob URLs can play as media but cannot reliably be fetched.
          // Keep UI clips independent from the WebAudio ambient graph so one bad clip never
          // disables video audio, the analyser, or the first-party voxel response.
          if (assetUrl.startsWith("blob:")) { mediaClips.set(eventName, assetUrl); continue; }
          try {
            decodedClips.set(eventName, await decodeUiClip(assetUrl, eventName));
          } catch {
            failures += 1;
          }
        }
        uiStatus = failures ? "degraded" : (Object.keys(uiConfig.events).length ? "ready" : "none");
      }

      function onVisibility() {
        if (!context || !unlocked || settings.hiddenAudio !== "pause") return;
        if (document.hidden) context.suspend().catch(() => {});
        else if (settings.soundEnabled) context.resume().catch(() => {});
      }
      document.addEventListener("visibilitychange", onVisibility);
      const removeVisibility = () => document.removeEventListener("visibilitychange", onVisibility);
      disposers.push(removeVisibility);
      ledger.track("listener", removeVisibility);

      const api = {
        async prepare() {
          if (destroyed) throw new AudioBusError("DESTROYED", "Dynamic skin audio bus was destroyed.");
          if (ambientElement) ambientElement.load();
          status = "ready";
        },
        async unlockFromGesture(event) {
          if (!event?.isTrusted) throw new AudioBusError("GESTURE_REQUIRED", "A trusted user gesture is required to enable sound.");
          if (destroyed) throw new AudioBusError("DESTROYED", "Dynamic skin audio bus was destroyed.");
          if (unlocked) { await context.resume(); return true; }
          try {
            const AudioContext = window.AudioContext ?? window.webkitAudioContext;
            if (typeof AudioContext !== "function") throw new AudioBusError("AUDIO_CONTEXT", "Web Audio is unavailable.");
            if (!context) {
              context = new AudioContext();
              masterGain = context.createGain();
              ambientGain = context.createGain();
              uiGain = context.createGain();
              analyserNode = context.createAnalyser();
              analyserNode.fftSize = 1024;
              masterGain.connect(context.destination);
              ambientGain.connect(masterGain);
              uiGain.connect(masterGain);
            }
            const element = ambientConfig.source === "visual" ? visualElement : ambientElement;
            if (element && !ambientSource) {
              ambientSource = context.createMediaElementSource(element);
              if (ambientConfig.analyze) {
                ambientSource.connect(analyserNode);
                analyserNode.connect(ambientGain);
              } else ambientSource.connect(ambientGain);
            }
            await context.resume();
            await prepareUiClips();
            unlocked = true;
            status = "active";
            applyGains();
            if (ambientElement && !document.hidden) await ambientElement.play();
            return true;
          } catch (error) {
            status = "failed";
            unlocked = false;
            applyGains();
            throw error?.code ? error : new AudioBusError("AUDIO_CONTEXT", error?.message ?? "Dynamic skin audio failed.");
          }
        },
        setSettings(next) {
          const previousHiddenAudio = settings.hiddenAudio;
          settings = { ...settings, ...next };
          applyGains();
          if (context && unlocked && document.hidden && settings.soundEnabled
            && previousHiddenAudio === "pause" && settings.hiddenAudio === "continue") {
            context.resume().catch(() => {});
          }
          return api.diagnostics();
        },
        async playUi(eventName) {
          recordUi(eventName, "requested");
          const reject = () => { recordUi(eventName, "rejected"); return false; };
          if (!unlocked || destroyed || document.hidden || settings.uiMuted || !settings.soundEnabled) return reject();
          const buffer = decodedClips.get(eventName);
          const mediaUrl = mediaClips.get(eventName);
          if (!buffer && !mediaUrl) return reject();
          const timestamp = now();
          if (timestamp - (lastPlayed.get(eventName) ?? -Infinity) < 500 || voices.size >= 4) return reject();
          lastPlayed.set(eventName, timestamp);
          if (buffer) {
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(uiGain);
            voices.add(source);
            source.onended = () => { voices.delete(source); try { source.disconnect(); } catch {} };
            source.start(0);
          } else {
            const voice = document.createElement("audio");
            voice.preload = "auto";
            voice.src = mediaUrl;
            voice.style.display = "none";
            voice.volume = clamp(masterGain.gain.value * uiGain.gain.value);
            const release = () => { voices.delete(voice); voice.removeAttribute("src"); voice.src = ""; voice.remove(); };
            voice.addEventListener("ended", release, { once: true });
            voice.addEventListener("error", release, { once: true });
            voices.add(voice);
            document.body.append(voice);
            try { await voice.play(); } catch { release(); return reject(); }
          }
          recordUi(eventName, "played");
          return true;
        },
        analyser() { return unlocked && ambientConfig.analyze ? analyserNode : null; },
        diagnostics() {
          return Object.freeze({ status, unlocked, source: ambientConfig.source, uiStatus, uiVoices: voices.size,
            uiPlayback: Object.freeze({ ...uiPlayback, byEvent: Object.freeze(Object.fromEntries(
              [...uiPlaybackByEvent].map(([name, value]) => [name, Object.freeze({ ...value })]),
            )) }),
            gains: Object.freeze({ master: masterGain?.gain.value ?? 0,
              ambient: ambientGain?.gain.value ?? 0, ui: uiGain?.gain.value ?? 0 }) });
        },
        async destroy() {
          if (destroyed) return false;
          destroyed = true;
          unlocked = false;
          status = "destroyed";
          for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch {} }
          for (const voice of voices) {
            try {
              if (voice?.tagName === "AUDIO") { voice.pause(); voice.removeAttribute("src"); voice.src = ""; voice.remove(); }
              else { voice.stop(); voice.disconnect(); }
            } catch {}
          }
          voices.clear();
          if (ambientElement) {
            ambientElement.pause();
            ambientElement.removeAttribute("src");
            ambientElement.src = "";
            ambientElement.load();
            ambientElement.remove();
          }
          mediaLayer?.setAmbientMuted?.(true);
          for (const node of [ambientSource, analyserNode, ambientGain, uiGain, masterGain]) {
            try { node?.disconnect(); } catch {}
          }
          if (context && context.state !== "closed") await context.close();
          decodedClips.clear();
          mediaClips.clear();
          return true;
        },
      };
      return api;
    },
  }));
})();

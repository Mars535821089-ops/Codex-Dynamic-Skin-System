(() => {
  const register = globalThis.__registerCodexDynamicSkinModule;
  if (typeof register !== "function") throw new Error("Dynamic skin registry is unavailable.");

  class MediaLayerError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "MediaLayerError";
      this.code = code;
    }
  }

  function once(target, successTypes, failureTypes, timeoutMs, disposers) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const cleanup = () => {
        for (const type of successTypes) target.removeEventListener(type, success);
        for (const type of failureTypes) target.removeEventListener(type, failure);
        clearTimeout(timer);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const success = () => finish(resolve);
      const failure = () => finish(reject,
        new MediaLayerError("MEDIA_DECODE", "Dynamic skin media could not be decoded."));
      for (const type of successTypes) target.addEventListener(type, success, { once: true });
      for (const type of failureTypes) target.addEventListener(type, failure, { once: true });
      timer = setTimeout(() => finish(reject,
        new MediaLayerError("MEDIA_TIMEOUT", "Dynamic skin media readiness timed out.")), timeoutMs);
      disposers.push(cleanup);
    });
  }

  function prefersReducedMotion(settings, window) {
    if (settings?.reducedMotion === "on") return true;
    if (settings?.reducedMotion === "off") return false;
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  }

  function videoAsset(theme) {
    if (theme.visual.kind === "video") return theme.visual.asset;
    return theme.visual.kind === "builtin-effect" ? theme.visual.fallback?.video : null;
  }

  function posterAsset(theme) {
    if (theme.visual.kind === "image") return theme.visual.asset;
    if (theme.visual.kind === "video") return theme.visual.poster ?? null;
    return theme.visual.kind === "builtin-effect" ? theme.visual.fallback?.poster : null;
  }

  const CONTENT_LAYER_KEY = "__CODEX_DYNAMIC_SKIN_CONTENT_LAYER__";
  const VIDEO_LIVE_OWNERS_KEY = "__CODEX_DYNAMIC_SKIN_VIDEO_LIVE_OWNERS__";
  const MEDIA_LAYER_Z_INDEX = "1";
  const CONTENT_LAYER_Z_INDEX = "2";
  const LEGACY_CONTENT_LAYER_Z_INDEX = "2147482001";

  function updateVideoLiveMarker(document, window, mediaRoot, live) {
    let owners = window[VIDEO_LIVE_OWNERS_KEY];
    if (!owners || typeof owners.add !== "function" || typeof owners.delete !== "function") {
      owners = new Set();
      window[VIDEO_LIVE_OWNERS_KEY] = owners;
    }
    for (const owner of owners) {
      if (owner?.parentNode !== document.body) owners.delete(owner);
    }
    if (live) owners.add(mediaRoot);
    else owners.delete(mediaRoot);

    const html = document.documentElement;
    if (owners.size > 0) {
      html?.setAttribute?.("data-dynamic-skin-video-live", "true");
    } else {
      html?.removeAttribute?.("data-dynamic-skin-video-live");
      if (window[VIDEO_LIVE_OWNERS_KEY] === owners) delete window[VIDEO_LIVE_OWNERS_KEY];
    }
  }

  function acquireContentLayer(document, window, mediaRoot) {
    const appRoot = document.getElementById?.("root") ?? null;
    // Migrate a renderer that was hot-injected with the former body-sibling
    // strategy. That version left #root at a near-maximum z-index.
    if (appRoot?.style?.zIndex === LEGACY_CONTENT_LAYER_Z_INDEX) {
      appRoot.style.zIndex = "";
      if (appRoot.style.position === "relative") appRoot.style.position = "";
    }
    // Never append an injected node below #root. React owns that subtree and
    // is entitled to remove unknown children during any reconciliation. That
    // left the controller reporting an active video whose DOM root had already
    // vanished, producing a static fallback followed by reinjection flashes.
    const host = document.body;
    if (!host) {
      return () => {};
    }
    let state = window[CONTENT_LAYER_KEY];
    if (state && state.host !== host) {
      for (const [node, previous] of state.foreground ?? []) {
        if (node?.style?.position === "relative") node.style.position = previous.position;
        if (node?.style?.zIndex === CONTENT_LAYER_Z_INDEX) node.style.zIndex = previous.zIndex;
      }
      delete window[CONTENT_LAYER_KEY];
      state = null;
    }
    if (!state || state.host !== host) {
      const style = host.style;
      const backgroundImage = typeof style?.getPropertyValue === "function"
        ? style.getPropertyValue("background-image") : style?.backgroundImage;
      const backgroundImagePriority = typeof style?.getPropertyPriority === "function"
        ? style.getPropertyPriority("background-image") : "";
      state = {
        host,
        owners: 0,
        foreground: new Map(),
        backgroundImage,
        backgroundImagePriority,
      };
      window[CONTENT_LAYER_KEY] = state;
      if (typeof style?.setProperty === "function") {
        style.setProperty("background-image", "none", "important");
      } else if (style) {
        style.backgroundImage = "none";
      }
    }
    state.owners += 1;
    if (appRoot?.style) {
      if (!state.foreground.has(appRoot)) {
        state.foreground.set(appRoot, {
          position: appRoot.style.position,
          zIndex: appRoot.style.zIndex,
        });
      }
      appRoot.style.position = "relative";
      appRoot.style.zIndex = CONTENT_LAYER_Z_INDEX;
    }
    if (typeof host.prepend === "function") host.prepend(mediaRoot);
    else host.append(mediaRoot);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.owners = Math.max(0, state.owners - 1);
      if (state.owners > 0 || window[CONTENT_LAYER_KEY] !== state) return;
      for (const [node, previous] of state.foreground) {
        if (node.style.position === "relative") node.style.position = previous.position;
        if (node.style.zIndex === CONTENT_LAYER_Z_INDEX) node.style.zIndex = previous.zIndex;
      }
      const style = state.host?.style;
      if (typeof style?.setProperty === "function") {
        if (state.backgroundImage) {
          style.setProperty("background-image", state.backgroundImage, state.backgroundImagePriority);
        } else {
          style.removeProperty("background-image");
        }
      } else if (style) {
        style.backgroundImage = state.backgroundImage;
      }
      delete window[CONTENT_LAYER_KEY];
    };
  }

  register("media-layer", ({ document, window }) => ({
    create({ config, ledger }) {
      const { theme, assets, settings } = config;
      const visual = theme.visual;
      const adaptive = visual.fit === "adaptive";
      const root = document.createElement("div");
      root.setAttribute("data-dynamic-skin-root", "");
      root.setAttribute("aria-hidden", "true");
      Object.assign(root.style, {
        position: "fixed", inset: "0", overflow: "hidden", pointerEvents: "none",
        zIndex: MEDIA_LAYER_Z_INDEX, visibility: "hidden", opacity: "0",
        transition: "none",
      });

      const posterPath = posterAsset(theme);
      const poster = posterPath ? document.createElement("img") : null;
      if (poster) {
        poster.setAttribute("data-dynamic-skin-poster", "");
        poster.alt = "";
        poster.src = assets[posterPath];
        Object.assign(poster.style, {
          position: "absolute", inset: "0", width: "100%", height: "100%",
          objectFit: adaptive ? "cover" : (visual.fit ?? "cover"), opacity: "1",
        });
        root.append(poster);
      }

      const videoPath = videoAsset(theme);
      const video = videoPath ? document.createElement("video") : null;
      if (video) {
        video.setAttribute("data-dynamic-skin-video", "");
        video.muted = true;
        video.defaultMuted = true;
        video.playsInline = true;
        video.preload = "metadata";
        video.crossOrigin = "anonymous";
        video.loop = visual.loop !== false;
        video.src = assets[videoPath];
        Object.assign(video.style, {
          position: "absolute", inset: "0", width: "100%", height: "100%",
          objectFit: adaptive ? "cover" : (visual.fit ?? "cover"), opacity: "0",
          transform: `scale(${visual.overscan ?? 1})`, transformOrigin: "center center",
          // The poster is removed while this root is still concealed. An
          // opacity transition would start only when Chromium composites the
          // revealed root, briefly exposing stale artwork beneath it.
          transition: "none",
        });
        root.append(video);
      }

      const canvas = visual.kind === "builtin-effect" ? document.createElement("canvas") : null;
      if (canvas) {
        canvas.setAttribute("data-dynamic-skin-effect", "");
        Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%" });
        root.append(canvas);
      }
      const localDisposers = [];
      const releaseContentLayer = acquireContentLayer(document, window, root);
      localDisposers.push(releaseContentLayer);
      ledger.track("listener", releaseContentLayer);
      let phase = "staged";
      let committed = false;
      let revealed = false;
      let destroyed = false;
      let playingBeforeBackground = false;
      let appFocused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
      let tier = "media";
      let reduced = prefersReducedMotion(settings, window);
      let backgroundPlayback = settings?.backgroundPlayback !== false;
      let presentationEpoch = 0;
      let videoPresentationLive = false;

      function canPlayVideo() {
        return Boolean(video && committed && !destroyed && !reduced && tier !== "static");
      }

      function syncVideoLiveMarker() {
        updateVideoLiveMarker(document, window, root,
          Boolean(video && videoPresentationLive && committed && revealed
            && !destroyed && !reduced && tier !== "static"));
      }

      function mayPlayInCurrentVisibility() {
        return backgroundPlayback || (!document.hidden && appFocused);
      }

      function showPosterFallback() {
        videoPresentationLive = false;
        if (!video) return;
        video.style.opacity = "0";
        if (poster) poster.style.opacity = "1";
        syncVideoLiveMarker();
      }

      function showLiveVideo() {
        if (!video) return;
        videoPresentationLive = true;
        video.style.opacity = "1";
        if (poster) poster.style.opacity = "0";
        syncVideoLiveMarker();
      }

      function resumeVideoFromPoster() {
        if (!video || !canPlayVideo() || !mayPlayInCurrentVisibility()) {
          showPosterFallback();
          return;
        }
        if (!video.paused) {
          presentationEpoch += 1;
          showLiveVideo();
          return;
        }

        const epoch = ++presentationEpoch;
        showPosterFallback();
        let playback;
        try {
          playback = video.play();
        } catch {
          showPosterFallback();
          return;
        }
        Promise.resolve(playback).then(() => {
          if (epoch !== presentationEpoch || !canPlayVideo() || !mayPlayInCurrentVisibility()) {
            if (!canPlayVideo()) video.pause();
            return;
          }
          if (video.paused) {
            showPosterFallback();
            return;
          }
          showLiveVideo();
        }, () => {
          if (epoch === presentationEpoch) showPosterFallback();
        });
      }

      function pauseForBackground() {
        if (!video || video.paused) return;
        playingBeforeBackground = true;
        video.pause();
      }

      function resumeFromBackground() {
        if (!canPlayVideo() || document.hidden || !appFocused || !playingBeforeBackground) return;
        playingBeforeBackground = false;
        video.play().catch(() => {});
      }

      function decodedFrames() {
        if (!video) return null;
        try {
          const qualityFrames = video.getVideoPlaybackQuality?.().totalVideoFrames;
          if (Number.isFinite(qualityFrames)) return qualityFrames;
        } catch {}
        return Number.isFinite(video.webkitDecodedFrameCount) ? video.webkitDecodedFrameCount : null;
      }

      function frameSignature() {
        if (!video || video.readyState < 2) return null;
        try {
          const sample = document.createElement("canvas");
          sample.width = 8;
          sample.height = 8;
          const context = sample.getContext?.("2d", { willReadFrequently: true });
          if (!context) return null;
          context.drawImage(video, 0, 0, 8, 8);
          const pixels = context.getImageData(0, 0, 8, 8).data;
          let hash = 0x811c9dc5;
          for (const value of pixels) {
            hash ^= value;
            hash = Math.imul(hash, 0x01000193);
          }
          return (hash >>> 0).toString(16).padStart(8, "0");
        } catch {
          return null;
        }
      }

      const onVisibility = () => {
        if (!video || destroyed || reduced) return;
        if (document.hidden) {
          if (backgroundPlayback) return;
          pauseForBackground();
        } else {
          resumeFromBackground();
        }
      };
      document.addEventListener("visibilitychange", onVisibility);
      const removeVisibility = () => document.removeEventListener("visibilitychange", onVisibility);
      localDisposers.push(removeVisibility);
      ledger.track("listener", removeVisibility);

      const onBlur = () => {
        appFocused = false;
        if (!backgroundPlayback && !destroyed && !reduced) pauseForBackground();
      };
      const onFocus = () => {
        appFocused = true;
        if (!backgroundPlayback && !destroyed && !reduced) resumeFromBackground();
      };
      window.addEventListener?.("blur", onBlur);
      window.addEventListener?.("focus", onFocus);
      const removeWindowFocus = () => {
        window.removeEventListener?.("blur", onBlur);
        window.removeEventListener?.("focus", onFocus);
      };
      localDisposers.push(removeWindowFocus);
      ledger.track("listener", removeWindowFocus);

      async function waitForVideo() {
        if (!video || reduced) return;
        if (video.readyState < 1) {
          await once(video, ["loadedmetadata"], ["error", "abort"], 10_000, localDisposers);
        }
        if (typeof video.requestVideoFrameCallback === "function") {
          await new Promise((resolve, reject) => {
            let settled = false;
            const onError = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              reject(new MediaLayerError("MEDIA_DECODE", "Dynamic skin video frame could not be decoded."));
            };
            video.addEventListener("error", onError, { once: true });
            const callbackId = video.requestVideoFrameCallback(() => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              video.removeEventListener("error", onError);
              resolve();
            });
            const timer = setTimeout(onError, 10_000);
            localDisposers.push(() => {
              clearTimeout(timer);
              video.removeEventListener("error", onError);
              video.cancelVideoFrameCallback?.(callbackId);
            });
          });
        } else if (video.readyState < 3) {
          await once(video, ["canplay"], ["error", "abort"], 10_000, localDisposers);
        }
      }

      const api = {
        pruneOrphanedRoots() {
          if (destroyed || !root?.parentNode) return 0;
          const candidates = typeof document.querySelectorAll === "function"
            ? [...document.querySelectorAll("[data-dynamic-skin-root]")] : [];
          let removed = 0;
          for (const candidate of candidates) {
            if (!candidate || candidate === root) continue;
            const videos = typeof candidate.querySelectorAll === "function"
              ? [...candidate.querySelectorAll("video")] : [];
            for (const staleVideo of videos) {
              try { staleVideo.pause?.(); } catch {}
              try { staleVideo.removeAttribute?.("src"); } catch {}
              try { staleVideo.src = ""; } catch {}
              try { staleVideo.load?.(); } catch {}
            }
            try { candidate.remove?.(); removed += 1; } catch {}
          }
          const contentState = window[CONTENT_LAYER_KEY];
          if (removed > 0 && contentState?.host === root.parentNode) {
            contentState.owners = Math.max(1, Number(contentState.owners || 1) - removed);
          }
          return removed;
        },
        async ready() {
          if (destroyed) throw new MediaLayerError("DESTROYED", "Dynamic skin media layer was destroyed.");
          try {
            if (reduced) {
              if (poster?.decode) await poster.decode();
              if (video) video.style.display = "none";
              phase = "ready";
              return;
            }
            // Attach video readiness/error listeners before waiting for poster
            // decoding so an immediately available media event cannot be lost.
            await Promise.all([
              poster?.decode ? poster.decode() : Promise.resolve(),
              waitForVideo(),
            ]);
            phase = "ready";
          } catch (error) {
            phase = "failed";
            throw error;
          }
        },
        async commit() {
          if (phase !== "ready") throw new MediaLayerError("NOT_READY", "Dynamic skin media is not ready to commit.");
          try {
            if (video && !reduced && mayPlayInCurrentVisibility()) {
              await video.play();
              showLiveVideo();
            }
            committed = true;
            // A committed candidate is decoded, playing and fully opaque, but
            // remains concealed until entry performs the atomic handoff.
            phase = "prepared";
          } catch (error) {
            committed = false;
            showPosterFallback();
            phase = "ready";
            throw error;
          }
        },
        reveal() {
          if (!committed || destroyed) return false;
          // Recover if a renderer upgrade or foreign DOM owner detached the
          // stable body sibling without destroying this generation.
          const mountHost = document.body;
          if (mountHost && root.parentNode !== mountHost) {
            if (typeof mountHost.prepend === "function") mountHost.prepend(root);
            else mountHost.append(root);
          }
          revealed = true;
          syncVideoLiveMarker();
          root.style.opacity = String((visual.opacity ?? 1) * (settings.visualOpacity ?? 1));
          root.style.visibility = "visible";
          phase = "active";
          return true;
        },
        conceal() {
          if (destroyed) return false;
          revealed = false;
          root.style.opacity = "0";
          root.style.visibility = "hidden";
          syncVideoLiveMarker();
          if (committed) phase = "prepared";
          return true;
        },
        setTier(next) {
          if (!["full", "balanced", "media", "static"].includes(next)) return false;
          tier = next;
          const staticMode = reduced || next === "static";
          if (video) {
            video.style.display = staticMode ? "none" : "block";
            if (staticMode) {
              presentationEpoch += 1;
              video.pause();
              showPosterFallback();
            } else {
              resumeVideoFromPoster();
            }
          }
          if (poster && !video) poster.style.opacity = "1";
          if (canvas) canvas.style.display = !staticMode && ["full", "balanced"].includes(next) ? "block" : "none";
          return true;
        },
        setReducedMotion(preference) {
          if (!["system", "on", "off"].includes(preference)) return false;
          reduced = preference === "on" || (preference === "system"
            && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches));
          api.setTier(tier);
          return true;
        },
        setBackgroundPlayback(value) {
          if (typeof value !== "boolean") return false;
          backgroundPlayback = value;
          if (typeof document.hasFocus === "function") appFocused = document.hasFocus();
          if (!canPlayVideo()) return true;
          if (!backgroundPlayback) {
            if (document.hidden || !appFocused) pauseForBackground();
          } else if (video.paused) {
            playingBeforeBackground = false;
            video.play().catch(() => {});
          }
          return true;
        },
        setOpacity(value) {
          if (!Number.isFinite(value) || value < 0 || value > 1) return false;
          if (revealed) root.style.opacity = String((visual.opacity ?? 1) * value);
          return true;
        },
        setAmbientMuted(value) { if (video) video.muted = Boolean(value); },
        visualAudioElement() { return theme.audio?.ambient?.source === "visual" ? video : null; },
        effectCanvas() { return canvas; },
        diagnostics() {
          const bounds = root.getBoundingClientRect?.();
          return Object.freeze({
            phase,
            mode: reduced ? "poster"
              : visual.kind === "image" ? "image"
                : visual.kind === "builtin-effect" ? "effect" : "video",
            fit: visual.fit ?? "cover",
            loop: Boolean(video?.loop),
            movingBackdrop: false,
            playing: Boolean(video && !video.paused),
            currentTime: Number.isFinite(video?.currentTime) ? video.currentTime : 0,
            decodedFrames: decodedFrames(),
            frameSignature: frameSignature(),
            viewport: bounds ? {
              width: Math.round(bounds.width),
              height: Math.round(bounds.height),
            } : null,
            tier,
            backgroundPlayback,
            revealed,
            connected: root.parentNode === document.body,
          });
        },
        async destroy() {
          if (destroyed) return false;
          destroyed = true;
          phase = "destroyed";
          syncVideoLiveMarker();
          for (const dispose of localDisposers.splice(0).reverse()) { try { dispose(); } catch {} }
          if (video) {
            video.pause();
            video.removeAttribute("src");
            video.src = "";
            video.load();
          }
          if (poster) { poster.removeAttribute("src"); poster.src = ""; }
          root.remove();
          return true;
        },
      };
      return api;
    },
  }));
})();

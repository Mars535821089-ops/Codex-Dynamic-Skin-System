(() => {
  const register = globalThis.__registerCodexDynamicSkinModule;
  if (typeof register !== "function") throw new Error("Dynamic skin registry is unavailable.");

  const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
uniform float uBands[32];
uniform vec2 uGrid;
uniform float uTime;
uniform float uHeight;
uniform vec2 uViewport;
out float vEnergy;
out float vDepth;
void main() {
  float n = float(gl_InstanceID);
  float gx = mod(n, uGrid.x);
  float gz = floor(n / uGrid.x);
  vec2 p = (vec2(gx, gz) / max(vec2(1.0), uGrid - 1.0)) * 2.0 - 1.0;
  float radius = length(p);
  float wave = 0.5 + 0.5 * sin(radius * 13.0 - uTime * 1.35 + atan(p.y,p.x) * 2.0);
  int band = int(clamp(floor(radius * 31.0), 0.0, 31.0));
  float energy = clamp(uBands[band] * 0.82 + wave * 0.28, 0.04, 1.25);
  float h = 0.05 + energy * uHeight * 0.34;
  vec3 local = vec3(aPosition.x, aPosition.y * h + h * 0.5, aPosition.z);
  vec3 world = local * vec3(1.55 / uGrid.x, 1.0, 1.55 / uGrid.y) + vec3(p.x, -0.72, p.y);
  float angle = -0.72;
  mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
  world.yz = rot * world.yz;
  world.z -= 2.55;
  float aspect = max(0.5, uViewport.x / max(1.0, uViewport.y));
  gl_Position = vec4(world.x / aspect * 1.85, world.y * 1.72, -world.z * 0.35, -world.z);
  vEnergy = energy;
  vDepth = radius;
}`;
  const FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 uPalette[3];
in float vEnergy;
in float vDepth;
out vec4 outColor;
void main() {
  vec3 low = mix(uPalette[0], uPalette[1], smoothstep(0.0, 0.65, vEnergy));
  vec3 color = mix(low, uPalette[2], smoothstep(0.62, 1.15, vEnergy));
  float glow = 0.38 + vEnergy * 0.78 + (1.0 - vDepth) * 0.12;
  outColor = vec4(color * glow, clamp(0.35 + vEnergy * 0.55, 0.28, 0.94));
}`;
  const CUBE = new Float32Array([
    -1,-1,1, 1,-1,1, 1,1,1, -1,-1,1, 1,1,1, -1,1,1,
    1,-1,-1, -1,-1,-1, -1,1,-1, 1,-1,-1, -1,1,-1, 1,1,-1,
    -1,-1,-1, -1,-1,1, -1,1,1, -1,-1,-1, -1,1,1, -1,1,-1,
    1,-1,1, 1,-1,-1, 1,1,-1, 1,-1,1, 1,1,-1, 1,1,1,
    -1,1,1, 1,1,1, 1,1,-1, -1,1,1, 1,1,-1, -1,1,-1,
    -1,-1,-1, 1,-1,-1, 1,-1,1, -1,-1,-1, 1,-1,1, -1,-1,1,
  ]);

  const rgb = (hex) => {
    const value = Number.parseInt(String(hex).slice(1), 16);
    return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
  };

  register("voxel-field", ({ document, window }) => ({
    create({ config, modules, ledger }) {
      const media = modules.get("media-layer");
      const signal = modules.get("signal-model");
      const policy = modules.get("performance-policy");
      const canvas = media?.effectCanvas?.();
      const params = config.theme.effect.parameters;
      const colors = params.palette.slice(0, 3);
      while (colors.length < 3) colors.push(colors.at(-1));
      const palette = new Float32Array(colors.flatMap(rgb));
      let gl = null; let program = null; let buffer = null; let vao = null;
      let raf = null; let phase = "created"; let destroyed = false; let contextLosses = 0;
      let prepared = false; let commitRequested = false;
      let lastFrame = null; let frameCount = 0;
      const locations = {};

      function shader(type, source) {
        const item = gl.createShader(type); gl.shaderSource(item, source); gl.compileShader(item);
        if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) throw new Error("voxel-field shader compilation failed.");
        return item;
      }
      function release() {
        if (!gl) return;
        if (buffer) gl.deleteBuffer(buffer); if (vao) gl.deleteVertexArray(vao); if (program) gl.deleteProgram(program);
        buffer = null; vao = null; program = null;
      }
      function initialize() {
        const tier = policy?.tier?.() ?? "media";
        if (!["full", "balanced"].includes(tier)) {
          phase = tier === "static" ? "static" : "fallback";
          canvas.style.display = "none";
          return false;
        }
        gl = canvas?.getContext?.("webgl2", { alpha: true, antialias: policy?.tier?.() === "full",
          depth: true, powerPreference: "high-performance" }) ?? null;
        if (!gl) { phase = "fallback"; media?.setTier?.("media"); return false; }
        const vertex = shader(gl.VERTEX_SHADER, VERTEX); const fragment = shader(gl.FRAGMENT_SHADER, FRAGMENT);
        program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
        gl.deleteShader(vertex); gl.deleteShader(fragment);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("voxel-field program link failed.");
        vao = gl.createVertexArray(); gl.bindVertexArray(vao);
        buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, CUBE, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        for (const name of ["uBands", "uGrid", "uTime", "uHeight", "uViewport", "uPalette"]) {
          locations[name] = gl.getUniformLocation(program, name);
        }
        gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        phase = "ready"; return true;
      }
      function resize() {
        const bounds = canvas.getBoundingClientRect();
        const dpr = policy?.tier?.() === "full" ? Math.min(1.5, window.devicePixelRatio || 1) : 1;
        const width = Math.max(1, Math.min(4096, Math.round(bounds.width * dpr)));
        const height = Math.max(1, Math.min(4096, Math.round(bounds.height * dpr)));
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        gl.viewport(0, 0, width, height); return [width, height];
      }
      function frame(time) {
        raf = null;
        if (destroyed || phase !== "active") return;
        const elapsed = lastFrame === null ? 16.7 : Math.min(100, Math.max(0, time - lastFrame)); lastFrame = time;
        const tier = policy?.observeFrame?.(elapsed, elapsed) ?? "full";
        if (!["full", "balanced"].includes(tier) || document.hidden) { media?.setTier?.(tier); raf = null; return; }
        const [width, height] = resize(); const grid = tier === "full" ? params.gridSize : Math.min(32, params.gridSize);
        gl.useProgram(program); gl.bindVertexArray(vao); gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.uniform1fv(locations.uBands, signal.sample(time)); gl.uniform2f(locations.uGrid, grid, grid);
        gl.uniform1f(locations.uTime, time * 0.001); gl.uniform1f(locations.uHeight, params.height);
        gl.uniform2f(locations.uViewport, width, height); gl.uniform3fv(locations.uPalette, palette);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, grid * grid); frameCount += 1;
        raf = window.requestAnimationFrame(frame);
      }
      const scheduleFrame = () => {
        if (destroyed || phase !== "active" || document.hidden || raf !== null) return false;
        if (!["full", "balanced"].includes(policy?.tier?.() ?? "media")) return false;
        lastFrame = null;
        raf = window.requestAnimationFrame(frame);
        return true;
      };
      const onLost = (event) => { event.preventDefault?.(); contextLosses += 1; phase = "fallback";
        if (raf !== null) window.cancelAnimationFrame(raf); raf = null;
        if (!policy?.forceFallback?.("webgl-context-lost")) media?.setTier?.("media"); };
      const onRestored = () => { if (destroyed || !prepared || contextLosses > 1
          || !["full", "balanced"].includes(policy?.tier?.() ?? "media")) return; release();
        try { if (initialize()) { phase = commitRequested ? "active" : "ready"; if (commitRequested) scheduleFrame(); } }
        catch { phase = "fallback"; } };
      const onVisibilityChange = () => {
        if (!document.hidden && commitRequested) scheduleFrame();
      };
      canvas?.addEventListener?.("webglcontextlost", onLost);
      canvas?.addEventListener?.("webglcontextrestored", onRestored);
      document?.addEventListener?.("visibilitychange", onVisibilityChange);
      const removeListeners = () => { canvas?.removeEventListener?.("webglcontextlost", onLost); canvas?.removeEventListener?.("webglcontextrestored", onRestored);
        document?.removeEventListener?.("visibilitychange", onVisibilityChange); };
      ledger.track("listener", removeListeners);

      return {
        async prepare() { if (destroyed) throw new Error("voxel-field was destroyed."); prepared = true; return initialize(); },
        async ready() { if (phase === "created") initialize(); return phase !== "created"; },
        async commit() { commitRequested = true; if (!["ready", "active"].includes(phase)) return false; phase = "active"; canvas.style.display = "block";
          scheduleFrame(); return true; },
        setTier(tier) { if (!["full", "balanced"].includes(tier)) { canvas.style.display = "none";
            if (raf !== null) window.cancelAnimationFrame(raf); raf = null;
            if (tier === "static") { release(); gl = null; phase = "static"; }
            else if (phase !== "fallback") phase = "fallback";
            return false; }
          canvas.style.display = "block";
          if (!prepared) return true;
          if (!["ready", "active"].includes(phase)) {
            try { if (!initialize()) return false; } catch { phase = "fallback"; media?.setTier?.("media"); return false; }
          }
          phase = commitRequested ? "active" : "ready";
          if (commitRequested) scheduleFrame();
          return true; },
        diagnostics() { return Object.freeze({ phase, renderer: phase === "static" ? "static" : gl ? "webgl2" : "fallback", frames: frameCount,
          contextLosses, tier: policy?.tier?.() ?? "media", instances: params.gridSize * params.gridSize }); },
        destroy() { if (destroyed) return false; destroyed = true; phase = "destroyed";
          if (raf !== null) window.cancelAnimationFrame(raf); raf = null; removeListeners(); release(); gl = null; return true; },
      };
    },
  }));
})();

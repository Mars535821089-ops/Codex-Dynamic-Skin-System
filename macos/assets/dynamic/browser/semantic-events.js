(() => {
  const register = globalThis.__registerCodexDynamicSkinModule;
  if (typeof register !== "function") throw new Error("Dynamic skin registry is unavailable.");

  const STATE_EVENT = Object.freeze({
    completed: "taskCompleted", complete: "taskCompleted", succeeded: "taskCompleted", success: "taskCompleted",
    approval: "approvalRequested", "approval-requested": "approvalRequested", waiting: "approvalRequested",
    failed: "taskFailed", failure: "taskFailed", error: "taskFailed",
  });

  register("semantic-events", ({ document, window }) => ({
    create({ config, modules, ledger }) {
      const audio = modules.get("audio-bus");
      const allowed = new Set(Object.keys(config.theme.audio.ui.events));
      const lastByElement = new WeakMap();
      const seenFinalAssistant = new WeakSet();
      const pendingNative = new Map();
      const replay = new Map();
      let observer = null;
      let destroyed = false;
      let emitted = 0;
      let nativeFinalBoundaries = 0;

      function normalize(value) {
        return STATE_EVENT[String(value ?? "").trim().toLowerCase()] ?? null;
      }
      function emit(name, identity = name, timestamp = Date.now()) {
        if (destroyed || document.hidden || !allowed.has(name)) return false;
        const key = `${name}:${String(identity).slice(0, 128)}`;
        if (timestamp - (replay.get(key) ?? -Infinity) < 750) return false;
        replay.set(key, timestamp);
        if (replay.size > 128) replay.delete(replay.keys().next().value);
        emitted += 1;
        audio?.playUi?.(name);
        return true;
      }
      function inspect(node, timestamp) {
        if (!node || typeof node.getAttribute !== "function") return false;
        const taskState = node.getAttribute("data-task-state");
        const testId = node.getAttribute("data-testid");
        const taskId = node.getAttribute("data-task-id");
        const nativeApproval = node.getAttribute("data-codex-approval-surface") !== null;
        // `data-state` and `data-status` are widely used by generic Codex/Radix
        // controls.  They carry task semantics only when the element also owns
        // an explicit task identity.  Dedicated task-state and approval markers
        // remain valid without that companion attribute.
        const raw = nativeApproval ? "approval-requested" : taskState
          ?? (String(testId ?? "").includes("approval") ? testId : null)
          ?? (taskId ? (node.getAttribute("data-state") ?? node.getAttribute("data-status")) : null);
        const name = normalize(raw) ?? (String(raw ?? "").includes("approval") ? "approvalRequested" : null);
        if (!name || lastByElement.get(node) === name) return false;
        lastByElement.set(node, name);
        const identity = taskId ?? node.id ?? raw;
        return emit(name, identity, timestamp);
      }
      function isFinalAssistant(node) {
        return Boolean(node && typeof node.getAttribute === "function"
          && node.getAttribute("data-local-conversation-final-assistant") !== null);
      }
      function finalAssistantNodes(root) {
        const nodes = [];
        if (isFinalAssistant(root)) nodes.push(root);
        for (const node of root?.querySelectorAll?.("[data-local-conversation-final-assistant]") ?? []) {
          nodes.push(node);
        }
        return nodes;
      }
      function baselineFinalAssistants() {
        for (const node of finalAssistantNodes(document)) seenFinalAssistant.add(node);
      }
      function nativeTurnOutcome(node) {
        const fiberKey = Object.getOwnPropertyNames(node ?? {})
          .find((name) => name.startsWith("__reactFiber"));
        let fiber = fiberKey ? node[fiberKey] : null;
        let foundTurn = false;
        let completedTurn = false;
        for (let depth = 0; fiber && depth < 8; fiber = fiber.return, depth += 1) {
          for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
            for (const turn of [props?.mcpTurn, props?.turn]) {
              if (!turn || typeof turn !== "object") continue;
              foundTurn = true;
              if (turn.error != null) return "taskFailed";
              for (const hook of Array.isArray(turn.hookRuns) ? turn.hookRuns : []) {
                const run = hook?.run ?? hook;
                const outcome = normalize(run?.status) ?? normalize(run?.executionStatus)
                  ?? normalize(run?.state);
                if (outcome === "taskFailed") return "taskFailed";
              }
              for (const item of Array.isArray(turn.items) ? turn.items : []) {
                const outcome = normalize(item?.status) ?? normalize(item?.executionStatus) ?? normalize(item?.state);
                if (outcome === "taskFailed") return "taskFailed";
              }
              if (normalize(turn.status) === "taskCompleted") completedTurn = true;
            }
          }
        }
        if (foundTurn) return completedTurn ? "taskCompleted" : null;
        return "taskCompleted";
      }
      function clearPendingNative() {
        for (const pending of pendingNative.values()) window.clearTimeout?.(pending.timer);
        pendingNative.clear();
      }
      function settleNativeBoundary(node, boundary, deadline = Date.now() + 60_000) {
        const existing = pendingNative.get(node);
        if (existing?.timer != null) window.clearTimeout?.(existing.timer);
        if (destroyed || Date.now() >= deadline) {
          pendingNative.delete(node);
          return false;
        }
        const liveNode = node?.isConnected === false
          ? finalAssistantNodes(document).filter((candidate) => candidate?.isConnected !== false).at(-1)
          : node;
        const outcome = liveNode ? nativeTurnOutcome(liveNode) : null;
        if (outcome) {
          clearPendingNative();
          return emit(outcome, `native-final-${boundary}`, Date.now());
        }
        if (typeof window.setTimeout !== "function") return false;
        const timer = window.setTimeout(() => settleNativeBoundary(node, boundary, deadline), 100);
        pendingNative.set(node, { timer, boundary, deadline });
        return false;
      }
      function inspectFinalAssistants(root, timestamp) {
        let count = 0;
        for (const node of finalAssistantNodes(root)) {
          if (seenFinalAssistant.has(node)) continue;
          seenFinalAssistant.add(node);
          nativeFinalBoundaries += 1;
          const outcome = nativeTurnOutcome(node);
          if (outcome) {
            if (emit(outcome, `native-final-${nativeFinalBoundaries}`, timestamp)) count += 1;
          } else {
            settleNativeBoundary(node, nativeFinalBoundaries);
          }
        }
        return count;
      }
      function scan(root = document, timestamp = Date.now()) {
        let count = inspect(root, timestamp) ? 1 : 0;
        const nodes = root.querySelectorAll?.("[data-task-state],[data-task-id][data-state],[data-task-id][data-status],[data-testid*='approval'],[data-codex-approval-surface]") ?? [];
        for (const node of nodes) if (inspect(node, timestamp)) count += 1;
        return count;
      }
      const onState = (event) => {
        const name = normalize(event?.detail?.state) ?? normalize(event?.detail?.event);
        if (name) emit(name, event?.detail?.id ?? name, Number(event?.detail?.timestamp) || Date.now());
      };
      window.addEventListener?.("codex-task-state-change", onState);
      const removeState = () => window.removeEventListener?.("codex-task-state-change", onState);
      ledger.track("listener", removeState);
      // Existing final-assistant boundaries belong to conversation history.
      // Baseline them before observing so a hot injection or theme switch does
      // not replay completion audio for old turns. A newly inserted boundary is
      // the native Codex 26.727+ structural completion signal; no message text
      // is inspected.
      baselineFinalAssistants();
      if (typeof window.MutationObserver === "function") {
        observer = new window.MutationObserver((records) => {
          const timestamp = Date.now();
          for (const record of records) {
            if (record.type === "attributes") {
              inspect(record.target, timestamp);
              inspectFinalAssistants(record.target, timestamp);
            }
            for (const node of record.addedNodes ?? []) {
              scan(node, timestamp);
              inspectFinalAssistants(node, timestamp);
            }
          }
        });
        observer.observe(document.documentElement ?? document.body, {
          subtree: true, childList: true, attributes: true,
          attributeFilter: ["data-task-id", "data-task-state", "data-state", "data-status", "data-testid", "data-codex-approval-surface", "data-local-conversation-final-assistant"],
        });
        ledger.track("observer", () => observer?.disconnect());
      }
      scan();
      return {
        ingest(state, identity, timestamp) { const name = normalize(state); return name ? emit(name, identity, timestamp) : false; },
        diagnostics() {
          return Object.freeze({ allowed: allowed.size, emitted, nativeFinalBoundaries, observing: Boolean(observer) });
        },
        destroy() {
          if (destroyed) return false;
          destroyed = true;
          removeState();
          observer?.disconnect();
          for (const pending of pendingNative.values()) window.clearTimeout?.(pending.timer);
          pendingNative.clear();
          replay.clear();
          return true;
        },
      };
    },
  }));
})();

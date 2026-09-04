import assert from "node:assert/strict";
import test from "node:test";

import { CdpSession } from "../../macos/scripts/injector.mjs";

test("persistent CDP session does not subscribe to unused high-volume Runtime events", async (t) => {
  const original = globalThis.WebSocket;
  const methods = [];
  class FakeWebSocket {
    listeners = new Map();
    addEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener); this.listeners.set(type, list);
      if (type === "open") queueMicrotask(() => listener({}));
    }
    send(raw) {
      const message = JSON.parse(raw); methods.push(message.method);
      queueMicrotask(() => {
        for (const listener of this.listeners.get("message") ?? []) {
          listener({ data: JSON.stringify({ id: message.id, result: {} }) });
        }
      });
    }
    close() {}
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  const target = {
    id: "TARGET_1",
    type: "page",
    url: "app://codex/index.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:19342/devtools/page/TARGET_1",
  };
  const session = await new CdpSession(target, 19342).open();
  session.close();
  assert.deepEqual(methods, ["Page.enable"]);
});

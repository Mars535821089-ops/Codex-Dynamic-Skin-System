import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { stageRendererAssets } from "../../macos/scripts/renderer-asset-bridge.mjs";

function rendererSession({ failCreateAt = null } = {}) {
  let sequence = 0;
  const revoked = [];
  const context = vm.createContext({
    Blob,
    Uint8Array,
    atob,
    URL: {
      createObjectURL() {
        sequence += 1;
        if (sequence === failCreateAt) throw new Error("finalize failed");
        return `blob:app://codex/${sequence}`;
      },
      revokeObjectURL(value) { revoked.push(value); },
    },
  });
  context.globalThis = context;
  return {
    revoked,
    expressions: [],
    async evaluate(expression) {
      this.expressions.push(expression);
      return await vm.runInContext(expression, context);
    },
  };
}

test("stages declared bytes as renderer-owned blob URLs without filesystem or loopback URLs", async () => {
  const session = rendererSession();
  const assets = [
    { path: "media/loop.mp4", mediaType: "video/mp4", bytes: Buffer.from("video-bytes") },
    { path: "media/poster.png", mediaType: "image/png", bytes: Buffer.from("poster-bytes") },
  ];

  const result = await stageRendererAssets(session, assets, "generation-a", { chunkBytes: 6 });

  assert.deepEqual(result, {
    "media/loop.mp4": "blob:app://codex/1",
    "media/poster.png": "blob:app://codex/2",
  });
  const transport = session.expressions.join("\n");
  assert.doesNotMatch(transport, /file:\/\//i);
  assert.doesNotMatch(transport, /127\.0\.0\.1|localhost/i);
  assert.doesNotMatch(transport, /renderer-asset-bridge\.test/i);
  assert.equal(globalThis.__CODEX_DYNAMIC_SKIN_ASSET_STAGE__, undefined);
});

test("revokes partially created renderer URLs when finalization fails", async () => {
  const session = rendererSession({ failCreateAt: 2 });

  await assert.rejects(
    stageRendererAssets(session, [
      { path: "media/loop.mp4", mediaType: "video/mp4", bytes: Buffer.from("video") },
      { path: "media/poster.png", mediaType: "image/png", bytes: Buffer.from("poster") },
    ], "generation-b"),
    /finalize failed/,
  );
  assert.deepEqual(session.revoked, ["blob:app://codex/1"]);
});

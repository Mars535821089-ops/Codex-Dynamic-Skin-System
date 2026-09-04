import assert from "node:assert/strict";
import test from "node:test";

import {
  createStaticPayloadAssetLoader,
  isStaticPayloadWatchFilename,
} from "../scripts/injector.mjs";

test("static payload loader observes changed bytes without relying on a watch event", async () => {
  let css = "root { color: red; }";
  let template = "renderer-v1";
  const loader = createStaticPayloadAssetLoader({
    readCss: async () => css,
    readTemplate: async () => template,
  });

  assert.deepEqual(await loader.load(), {
    css: "root { color: red; }",
    template: "renderer-v1",
    cacheHit: false,
  });
  assert.deepEqual(await loader.load(), {
    css: "root { color: red; }",
    template: "renderer-v1",
    cacheHit: true,
  });

  // Keep the replacement the same byte length. Metadata-only cache keys can
  // miss atomic updater swaps that preserve both size and coarse timestamps.
  css = "root { color: tan; }";
  assert.deepEqual(await loader.load(), {
    css: "root { color: tan; }",
    template: "renderer-v1",
    cacheHit: false,
  });

  template = "renderer-v2";
  assert.deepEqual(await loader.load(), {
    css: "root { color: tan; }",
    template: "renderer-v2",
    cacheHit: false,
  });
});

test("static payload loader invalidation makes the next identical read a miss", async () => {
  const loader = createStaticPayloadAssetLoader({
    readCss: async () => "css",
    readTemplate: async () => "template",
  });

  await loader.load();
  assert.equal((await loader.load()).cacheHit, true);
  loader.invalidate();
  assert.equal((await loader.load()).cacheHit, false);
});

test("static payload watch treats only the committed manifest as a generation change", () => {
  assert.equal(isStaticPayloadWatchFilename(""), false);
  assert.equal(isStaticPayloadWatchFilename("dream-skin.css"), false);
  assert.equal(isStaticPayloadWatchFilename("renderer-inject.js"), false);
  assert.equal(isStaticPayloadWatchFilename("dynamic-runtime-manifest.json"), true);
  assert.equal(isStaticPayloadWatchFilename("dream-skin.css.tmp-123-abcdef"), false);
  assert.equal(isStaticPayloadWatchFilename("renderer-inject.js.tmp-123-abcdef"), false);
  assert.equal(
    isStaticPayloadWatchFilename("dynamic-runtime-manifest.json.tmp-123-abcdef"),
    false,
  );
  assert.equal(isStaticPayloadWatchFilename("selectors.json.tmp-123-abcdef"), false);
  assert.equal(isStaticPayloadWatchFilename("portal-hero.png"), false);
});

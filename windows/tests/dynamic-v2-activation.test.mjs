import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadPayload } from "../scripts/injector.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureTheme = path.resolve(here, "../../tools/tests/fixtures/themes/v2-video/theme.json");
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function makeVideoTheme(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-windows-active-v2-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const theme = JSON.parse(await fs.readFile(fixtureTheme, "utf8"));
  theme.visual.poster = "media/poster.png";
  await fs.writeFile(path.join(root, "theme.json"), `${JSON.stringify(theme, null, 2)}\n`);
  for (const asset of [
    "audio/ui/approval.wav", "audio/ui/completed.wav", "audio/ui/error.wav", "media/loop.mp4",
  ]) {
    const target = path.join(root, asset);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `fixture:${asset}\n`);
  }
  await fs.writeFile(path.join(root, "media/poster.png"), tinyPng);
  await fs.mkdir(path.join(root, "styles"), { recursive: true });
  await fs.writeFile(path.join(root, "styles/theme.css"), '[data-ds-part="composer"] { opacity: .9; }\n');
  return root;
}

test("a Windows watcher-backed v2 payload is active and uses hosted media URLs", async (t) => {
  const themeDir = await makeVideoTheme(t);
  const staged = [];
  const assetHost = {
    async stageGeneration(manifest) {
      staged.push(manifest);
      return {
        urlFor: (asset) => `http://127.0.0.1:19876/token/generation/${asset}`,
        release: async () => {},
      };
    },
  };
  const loaded = await loadPayload(themeDir, null, {
    assetHost,
    backgroundPlaybackSupport: "supported",
    displayMode: "theme",
  });

  assert.equal(loaded.sourceApiVersion, 2);
  assert.equal(loaded.activation, "active");
  assert.equal(staged.length, 1);
  assert.ok(staged[0].manifest.some((entry) => entry.path === "media/loop.mp4"));
  assert.ok(loaded.payload.includes("http://127.0.0.1:19876/"));
  assert.doesNotMatch(loaded.payload, /dream-skin-deferred:\/\/asset/);
  assert.match(loaded.payload, /"activation":"active"/);
});

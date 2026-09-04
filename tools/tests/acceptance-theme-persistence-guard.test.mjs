import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs as parseMacArgs } from "../../macos/scripts/injector.mjs";
import { parseArgs as parseWindowsArgs } from "../../windows/scripts/injector.mjs";

test("macOS watcher requires an explicit switch before acceptance theme persistence is enabled", () => {
  assert.equal(parseMacArgs(["--watch"]).allowAcceptanceThemePersistence, false);
  assert.equal(parseMacArgs([
    "--watch",
    "--allow-acceptance-theme-persistence",
  ]).allowAcceptanceThemePersistence, true);
  assert.throws(
    () => parseMacArgs(["--once", "--allow-acceptance-theme-persistence"]),
    /watch mode/i,
  );
});

test("Windows watcher requires an explicit switch before acceptance theme persistence is enabled", () => {
  const watcher = ["--watch", "--browser-id", "isolated-acceptance-browser"];
  assert.equal(parseWindowsArgs(watcher).allowAcceptanceThemePersistence, false);
  assert.equal(parseWindowsArgs([
    ...watcher,
    "--allow-acceptance-theme-persistence",
  ]).allowAcceptanceThemePersistence, true);
  assert.throws(
    () => parseWindowsArgs(["--once", "--allow-acceptance-theme-persistence"]),
    /watch mode/i,
  );
});

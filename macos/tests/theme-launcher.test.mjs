import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const macosRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builder = path.join(macosRoot, "scripts/build-theme-launcher.sh");
const native = { skip: process.platform !== "darwin" };
const temporaryRoots = [];
let compiled;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function temporaryDirectory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cdss-launcher-test-"));
  temporaryRoots.push(root);
  return root;
}

async function baseApp() {
  if (!compiled) compiled = (async () => {
    assert.ok(await fs.stat(builder).then(() => true, () => false), "the native launcher builder must exist");
    const root = await temporaryDirectory();
    const app = path.join(root, "Codex Theme Launcher.app");
    const result = await run("/bin/bash", [builder, "--engine-root", path.join(root, "unused engine"), "--output", app, "--port", "9341"]);
    assert.equal(result.code, 0, result.stderr);
    return app;
  })();
  return compiled;
}

async function fixture(scriptBody = "printf '%s\\0' \"$@\" >> \"$root/arguments\"\n") {
  const appTemplate = await baseApp();
  const root = await temporaryDirectory();
  const engine = path.join(root, "engine <&> with spaces");
  await fs.mkdir(path.join(engine, "scripts"), { recursive: true });
  const start = path.join(engine, "scripts/open-dream-skin-macos.sh");
  await fs.writeFile(start, `#!/bin/bash\nset -eu\nroot="$(cd "$(dirname "$0")/.." && pwd)"\n${scriptBody}`);
  const app = path.join(root, "Codex Theme Launcher.app");
  await fs.cp(appTemplate, app, { recursive: true });
  const plist = path.join(app, "Contents/Info.plist");
  for (const args of [["-replace", "CDSSEngineRoot", "-string", engine], ["-replace", "CDSSPort", "-integer", "19431"]]) {
    const result = await run("/usr/bin/plutil", [...args, plist]);
    assert.equal(result.code, 0, result.stderr);
  }
  const resigned = await run("/usr/bin/codesign", ["--force", "--timestamp=none", "--sign", "-", app]);
  assert.equal(resigned.code, 0, resigned.stderr);
  return { root, engine, start, app, plist, binary: path.join(app, "Contents/MacOS/CodexThemeLauncher") };
}

after(async () => {
  for (const root of temporaryRoots) await fs.rm(root, { recursive: true, force: true });
});

test("builder creates a separate application and does not execute the engine", native, async () => {
  const app = await baseApp();
  const result = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(app, "Contents/Info.plist")]);
  assert.equal(result.stdout.trim(), "io.github.codex-dynamic-skin-system.launcher");
  assert.deepEqual((await fs.readdir(path.dirname(app))).sort(), ["Codex Theme Launcher.app"]);
});

test("builder uses a stable code-signing identity when one is available", native, async (t) => {
  const identities = await run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
  if (!/\b[0-9A-F]{40}\b/.test(identities.stdout)) t.skip("no local code-signing identity");
  const app = await baseApp();
  const details = await run("/usr/bin/codesign", ["-dvvv", app]);
  assert.equal(details.code, 0, details.stderr);
  assert.doesNotMatch(details.stderr, /Signature=adhoc/);
  assert.match(details.stderr, /TeamIdentifier=(?!not set\b).+/);
});

test("builder embeds a caller-supplied local icon without requiring a repository asset", native, async () => {
  const root = await temporaryDirectory();
  const app = path.join(root, "Icon Launcher.app");
  const icon = path.join(root, "local.icns");
  const bytes = Buffer.from("fixture local icon");
  await fs.writeFile(icon, bytes);
  const result = await run("/bin/bash", [builder, "--engine-root", path.join(root, "engine"),
    "--output", app, "--icon-source", icon]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await fs.readFile(path.join(app, "Contents/Resources/CodexThemeLauncher.icns")), bytes);
  const key = await run("/usr/bin/plutil", ["-extract", "CFBundleIconFile", "raw", "-o", "-",
    path.join(app, "Contents/Info.plist")]);
  assert.equal(key.stdout.trim(), "CodexThemeLauncher.icns");
});

test("the compiled executable honors the app's advertised macOS 12 deployment target", native, async () => {
  const app = await baseApp();
  const result = await run("/usr/bin/xcrun", ["vtool", "-show-build", path.join(app, "Contents/MacOS/CodexThemeLauncher")]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\bminos\s+12\.0\b/);
});

test("check validates a spaced path and port without invoking the engine or creating a lock", native, async () => {
  const f = await fixture();
  const result = await run(f.binary, ["--check"]);
  assert.equal(result.code, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.engineRoot, f.engine);
  assert.equal(status.port, 19431);
  assert.equal(status.entryScript, f.start);
  assert.deepEqual(await fs.readdir(f.engine), ["scripts"]);
});

test("launcher invokes bash with only the configured port and preserves shell-special paths", native, async () => {
  const f = await fixture();
  const result = await run(f.binary, ["--no-alert"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await fs.readFile(path.join(f.engine, "arguments"), "utf8")).split("\0"), ["--port", "19431", ""]);
});

test("engine failure returns its status and useful diagnostics without automatically retrying", native, async () => {
  const f = await fixture("printf 'attempt\\n' >> \"$root/attempts\"\nprintf 'fixture engine refused\\n' >&2\nexit 23\n");
  const result = await run(f.binary, ["--no-alert"]);
  assert.equal(result.code, 23);
  assert.match(result.stderr, /fixture engine refused/);
  assert.equal(await fs.readFile(path.join(f.engine, "attempts"), "utf8"), "attempt\n");
});

test("missing entry script fails check and launch without creating state", native, async () => {
  const f = await fixture();
  await fs.unlink(f.start);
  for (const args of [["--check"], ["--no-alert"]]) {
    const result = await run(f.binary, args);
    assert.equal(result.code, 78);
    assert.match(result.stderr, /open-dream-skin-macos\.sh/);
  }
  assert.deepEqual(await fs.readdir(f.engine), ["scripts"]);
});

test("simultaneous launcher processes share one engine invocation", native, async () => {
  const f = await fixture("printf 'attempt\\n' >> \"$root/attempts\"\n/bin/sleep 1\n");
  const results = await Promise.all([run(f.binary, ["--no-alert"]), run(f.binary, ["--no-alert"])]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(f.engine, "attempts"), "utf8"), "attempt\n");
});

test("a failed invocation releases its lock so a later user invocation may retry", native, async () => {
  const f = await fixture("printf 'attempt\\n' >> \"$root/attempts\"\nif [ ! -f \"$root/allow\" ]; then exit 23; fi\n");
  assert.equal((await run(f.binary, ["--no-alert"])).code, 23);
  await fs.writeFile(path.join(f.engine, "allow"), "");
  assert.equal((await run(f.binary, ["--no-alert"])).code, 0);
  assert.equal(await fs.readFile(path.join(f.engine, "attempts"), "utf8"), "attempt\nattempt\n");
});

test("unsafe configuration and restart arguments fail before the engine can run", native, async () => {
  const f = await fixture();
  assert.equal((await run(f.binary, ["--restart-existing", "--no-alert"])).code, 64);
  for (const value of ["0", "65536"]) {
    assert.equal((await run("/usr/bin/plutil", ["-replace", "CDSSPort", "-integer", value, f.plist])).code, 0);
    assert.equal((await run(f.binary, ["--check"])).code, 78);
  }
  assert.equal((await run("/usr/bin/plutil", ["-replace", "CDSSPort", "-integer", "19431", f.plist])).code, 0);
  assert.equal((await run("/usr/bin/plutil", ["-replace", "CDSSEngineRoot", "-string", "relative/engine", f.plist])).code, 0);
  assert.equal((await run(f.binary, ["--check"])).code, 78);
  assert.deepEqual(await fs.readdir(f.engine), ["scripts"]);
});

test("large failure diagnostics are drained without blocking and preserve the final reason", native, async () => {
  const f = await fixture("/usr/bin/yes diagnostic | /usr/bin/head -c 262144 >&2\nprintf '\\nfinal fixture reason\\n' >&2\nexit 31\n");
  const result = await run(f.binary, ["--no-alert"]);
  assert.equal(result.code, 31);
  assert.match(result.stderr, /final fixture reason/);
  assert.ok(Buffer.byteLength(result.stderr) < 18_000, "failure dialogs retain a bounded diagnostic tail");
});

test("builder refuses an existing output directory without changing it", native, async () => {
  await baseApp();
  const root = await temporaryDirectory();
  const output = path.join(root, "Existing.app");
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, "keep.txt"), "unrelated existing data");
  const result = await run("/bin/bash", [builder, "--output", output]);
  assert.notEqual(result.code, 0);
  assert.equal(await fs.readFile(path.join(output, "keep.txt"), "utf8"), "unrelated existing data");
  assert.deepEqual(await fs.readdir(output), ["keep.txt"]);
});

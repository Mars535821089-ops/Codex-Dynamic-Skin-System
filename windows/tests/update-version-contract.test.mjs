import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "scripts", "check-update.ps1"), "utf8");
const bootstrap = readFileSync(join(root, "installer", "setup-bootstrap.ps1"), "utf8");

test("Windows update versions do not depend on bounded .NET version integers", () => {
  assert.doesNotMatch(source, /\[version\]::TryParse/i);
  assert.match(source, /function Compare-DreamSkinVersionComponent\s*\{/);
  assert.match(source, /function Compare-DreamSkinVersion\s*\{/);
  assert.match(source, /\.Length\s+-gt\s+\$Right\.Length/);
  assert.match(source, /\[System\.StringComparison\]::Ordinal/);
  assert.match(source, /Compare-DreamSkinVersion\s+-Left\s+\$latest\s+-Right\s+\$current/);
});

test("Windows installer compares arbitrarily long valid version components without .NET version casts", () => {
  assert.doesNotMatch(bootstrap, /\[version\]/i);
  assert.match(bootstrap, /function Compare-DreamSkinBootstrapVersionComponent\s*\{/);
  assert.match(bootstrap, /function Compare-DreamSkinBootstrapVersion\s*\{/);
  assert.match(
    bootstrap,
    /Compare-DreamSkinBootstrapVersion\s+-Left\s+\$installedVersion\s+-Right\s+\$payloadVersion/,
  );
});

test("Windows update check caps the downloaded release response before JSON parsing", () => {
  assert.doesNotMatch(source, /Invoke-RestMethod/);
  assert.match(source, /Invoke-WebRequest[\s\S]*-OutFile\s+\$responsePath/);
  assert.match(source, /\.Length\s*-gt\s*1048576/);
  assert.match(source, /ReadAllText\(\$responsePath\)[\s\S]*ConvertFrom-Json/);
});

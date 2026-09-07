import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => readFileSync(resolve(root, relative), "utf8");

test("published runtime requirements match the platform installers", () => {
  const windowsRuntime = read("windows/scripts/common-windows.ps1");
  assert.match(
    windowsRuntime,
    /function Get-DreamSkinNodeRuntime \{\s*param\(\[int\]\$MinimumMajor = 22\)/,
    "the documentation contract must follow the Windows runtime gate",
  );

  for (const relative of ["docs/install-windows.md", "windows/README.md", "windows/README.en.md"]) {
    assert.match(read(relative), /Node\.js 22 or newer/, `${relative} understates the Windows Node.js requirement`);
  }

  for (const relative of ["docs/install-macos.md", "macos/README.md"]) {
    const source = read(relative);
    assert.match(source, /signed Node\.js runtime bundled with (?:the official )?Codex/i,
      `${relative} must explain that macOS uses Codex's signed bundled runtime`);
    assert.doesNotMatch(source, /Node\.js 20 or newer for source installation/,
      `${relative} must not tell macOS users to install an unused system Node.js`);
  }

  const readme = read("README.md");
  const macSection = readme.match(/### macOS\s+([\s\S]*?)\s+### Windows/)?.[1] ?? "";
  const windowsSection = readme.match(/### Windows\s+([\s\S]*?)\s+\u8be6\u7ec6\u6b65\u9aa4/)?.[1] ?? "";
  assert.match(macSection, /\u65e0\u9700\u53e6\u884c\u5b89\u88c5 Node\.js/);
  assert.match(windowsSection, /Node\.js 22 \u6216\u66f4\u9ad8\u7248\u672c/);

  const englishReadme = read("README.en.md");
  assert.match(englishReadme, /macOS uses the signed Node\.js runtime bundled with (?:the official )?Codex/i);
  assert.match(englishReadme, /Windows source installation requires Node\.js 22 or newer/i);
  assert.doesNotMatch(englishReadme, /Node\.js 20 or newer is required/);
});

test("Windows documentation points to the tray UI instead of the internal theme library", () => {
  for (const relative of ["README.md", "README.en.md", "docs/install-windows.md", "windows/README.md", "windows/README.en.md"]) {
    const source = read(relative);
    assert.doesNotMatch(
      source,
      /(?:run|Run|\u8fd0\u884c|\u4f7f\u7528)[^\n`]*`?(?:windows[\\/]scripts[\\/])?theme-windows\.ps1`?[^\n]*(?:manage|\u7ba1\u7406|\u5bfc\u5165|\u5207\u6362)/,
      `${relative} presents the internal function library as an interactive user entrypoint`,
    );
    assert.match(source, /(?:system tray|notification area|\u7cfb\u7edf\u6258\u76d8)/i,
      `${relative} must identify the actual Windows theme-management UI`);
  }
});

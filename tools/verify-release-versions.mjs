#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SEMANTIC_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function readText(root, relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function readVersionFile(root, relative) {
  const raw = readText(root, relative).replace(/\r?\n$/, "");
  if (!SEMANTIC_VERSION.test(raw)) {
    throw new Error(`${relative} must contain a three-part semantic version: ${raw}`);
  }
  return raw;
}

function extractSingleVersion(root, relative, pattern) {
  const matches = [...readText(root, relative).matchAll(pattern)];
  if (matches.length !== 1 || !SEMANTIC_VERSION.test(matches[0][1])) {
    throw new Error(`${relative} must contain exactly one semantic SKIN_VERSION assignment`);
  }
  return matches[0][1];
}

export function verifyReleaseVersions(repositoryRoot) {
  const root = fs.realpathSync(repositoryRoot);
  const packageVersion = JSON.parse(readText(root, "macos/package.json")).version;
  if (typeof packageVersion !== "string" || !SEMANTIC_VERSION.test(packageVersion)) {
    throw new Error(`macos/package.json must contain a three-part semantic version: ${packageVersion}`);
  }

  const versions = {
    macos: readVersionFile(root, "macos/VERSION"),
    windows: readVersionFile(root, "windows/VERSION"),
    package: packageVersion,
    macosCommon: extractSingleVersion(
      root,
      "macos/scripts/common-macos.sh",
      /^SKIN_VERSION="([^"]+)"$/gm,
    ),
    macosInjector: extractSingleVersion(
      root,
      "macos/scripts/injector.mjs",
      /^const SKIN_VERSION = "([^"]+)";$/gm,
    ),
    windowsInjector: extractSingleVersion(
      root,
      "windows/scripts/injector.mjs",
      /^const SKIN_VERSION = "([^"]+)";$/gm,
    ),
  };
  if (new Set(Object.values(versions)).size !== 1) {
    throw new Error(`Release versions differ: ${Object.entries(versions)
      .map(([name, version]) => `${name}=${version}`).join(" ")}`);
  }
  return { ok: true, version: versions.macos, versions };
}

function parseRoot(argv) {
  if (argv.length === 0) return process.cwd();
  if (argv.length === 2 && argv[0] === "--root") return argv[1];
  throw new Error("Usage: verify-release-versions.mjs [--root REPOSITORY]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(verifyReleaseVersions(parseRoot(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

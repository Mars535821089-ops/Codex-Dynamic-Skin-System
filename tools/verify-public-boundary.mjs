#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const retiredProductName = String.fromCharCode(119, 97, 105, 102, 117, 120);
const chars = (...points) => String.fromCharCode(...points);
const allowedBinaryExtensions = new Set([
  ".avif", ".gif", ".ico", ".jpeg", ".jpg", ".m4a", ".mp3", ".mp4", ".ogg",
  ".otf", ".png", ".ttf", ".wav", ".webm", ".webp", ".woff", ".woff2",
]);
const restrictedPathFragments = [
  "client-delivery/",
  "menubar-app/",
  "private/injection-core/",
  chars(112, 114, 111, 102, 105, 108, 101, 45, 116, 111, 107, 101, 110),
  chars(99, 108, 111, 110, 101, 45, 116, 104, 114, 101, 97, 100),
  chars(116, 104, 114, 101, 101, 45, 105, 110, 45, 111, 110, 101),
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function slash(value) {
  return value.split(path.sep).join("/");
}

function forbiddenVariants() {
  const bytes = Buffer.from(retiredProductName, "utf8");
  return [
    retiredProductName,
    bytes.toString("hex"),
    bytes.toString("base64"),
    [...retiredProductName]
      .map((character) => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
    [...bytes].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""),
  ].map((value) => value.toLowerCase());
}

const blockedVariants = forbiddenVariants();

function inspectPath(relative) {
  const normalized = `${slash(relative).toLowerCase().replace(/^\.\//u, "")}/`;
  if (blockedVariants.some((variant) => normalized.includes(variant))) {
    throw new Error(`forbidden path in public release: ${relative}`);
  }
  if (restrictedPathFragments.some((fragment) => normalized.includes(fragment))) {
    throw new Error(`restricted path in public release: ${relative}`);
  }
}

function inspectBytes(bytes, label) {
  const text = bytes.toString("utf8");
  const lower = text.toLowerCase();
  if (blockedVariants.some((variant) => lower.includes(variant))) {
    throw new Error(`${label} contains forbidden content`);
  }
  if (/(?:^|[\s"'`=:(])\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/|$)|(?:^|[\s"'`=:(])[A-Za-z]:\\Users\\[^\\\s]+/mu.test(text)) {
    throw new Error(`${label} contains an absolute local path`);
  }
  const secretPatterns = [
    /\bsk-[A-Za-z0-9_-]{12,}\b/u,
    /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/u,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /\b(?:api[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"'\r\n]{12,}["']/iu,
  ];
  if (secretPatterns.some((pattern) => pattern.test(text))) {
    throw new Error(`${label} contains secret-shaped content`);
  }
  if (bytes.includes(0) && !allowedBinaryExtensions.has(path.extname(label).toLowerCase())) {
    throw new Error(`${label} is an unapproved binary artifact`);
  }
}

async function git(root, arguments_, options = {}) {
  return execFileAsync("git", arguments_, {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

async function inspectTrackedTree(root) {
  const { stdout } = await git(root, ["ls-files", "-z"], { encoding: "buffer" });
  const tracked = Buffer.from(stdout).toString("utf8").split("\0").filter(Boolean);
  for (const relative of tracked) {
    inspectPath(relative);
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`symbolic link in public release: ${relative}`);
    if (!stat.isFile()) throw new Error(`tracked entry is not a regular file: ${relative}`);
    inspectBytes(await fs.readFile(absolute), relative);
  }
  return tracked.length;
}

async function inspectReachableHistory(root) {
  const { stdout } = await git(root, ["rev-list", "--objects", "--all"]);
  const objects = new Map();
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const match = /^([0-9a-f]{40,64})(?:\s+(.*))?$/u.exec(line);
    invariant(match, "unable to parse Git object inventory");
    const labels = objects.get(match[1]) ?? new Set();
    if (match[2]) {
      inspectPath(match[2]);
      labels.add(match[2]);
    }
    objects.set(match[1], labels);
  }

  let inspected = 0;
  for (const [object, labels] of objects) {
    const { stdout: rawType } = await git(root, ["cat-file", "-t", object]);
    const type = rawType.trim();
    if (type !== "blob" && type !== "commit" && type !== "tag") continue;
    const { stdout: content } = await git(root, ["cat-file", "-p", object], { encoding: "buffer" });
    const bytes = Buffer.from(content);
    if (type === "blob" && labels.size > 0) {
      for (const label of labels) inspectBytes(bytes, `Git object ${object} ${label}`);
    } else {
      inspectBytes(bytes, `Git object ${object}`);
    }
    inspected += 1;
  }
  return inspected;
}

export async function scanPublicBoundary({ root }) {
  const absoluteRoot = await fs.realpath(path.resolve(root));
  invariant((await fs.stat(absoluteRoot)).isDirectory(), "public release root must be a directory");
  const { stdout } = await git(absoluteRoot, ["rev-parse", "--show-toplevel"]);
  const gitRoot = await fs.realpath(path.resolve(stdout.trim()));
  invariant(gitRoot === absoluteRoot, "public release root must be the Git repository root");
  const files = await inspectTrackedTree(absoluteRoot);
  const gitObjects = await inspectReachableHistory(absoluteRoot);
  return Object.freeze({ ok: true, files, git: true, gitObjects });
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") options.root = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  return { root: options.root ?? path.resolve(scriptDirectory, "..") };
}

async function main() {
  const result = await scanPublicBoundary(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

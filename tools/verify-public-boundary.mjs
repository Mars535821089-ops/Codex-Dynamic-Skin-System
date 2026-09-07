#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
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

function inspectPortablePath(relative) {
  const portable = slash(relative);
  if (portable !== portable.normalize("NFC")) {
    throw new Error(`non-NFC path in public release: ${relative}`);
  }
  for (const segment of portable.split("/")) {
    if (/[<>:"\\|?*\u0000-\u001f]/u.test(segment) || /[ .]$/u.test(segment)) {
      throw new Error(`Windows-invalid path in public release: ${relative}`);
    }
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)) {
      throw new Error(`Windows-reserved path in public release: ${relative}`);
    }
  }
  return portable;
}

function inspectPortablePathSet(paths) {
  const seen = new Map();
  for (const relative of paths) {
    const portable = inspectPortablePath(relative);
    const key = portable.toLowerCase();
    const previous = seen.get(key);
    if (previous && previous !== portable) {
      throw new Error(`case-insensitive path collision: ${previous} and ${portable}`);
    }
    seen.set(key, portable);
  }
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
  inspectPortablePath(relative);
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
  inspectPortablePathSet(tracked);
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

async function inspectWorkingTreeCandidates(root) {
  const { stdout } = await git(root, [
    "ls-files", "--cached", "--others", "--exclude-standard", "-z",
  ], { encoding: "buffer" });
  const candidates = Buffer.from(stdout).toString("utf8").split("\0").filter(Boolean);
  inspectPortablePathSet(candidates);
  for (const relative of candidates) {
    inspectPath(relative);
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`symbolic link in public release: ${relative}`);
    if (!stat.isFile()) throw new Error(`working-tree entry is not a regular file: ${relative}`);
    inspectBytes(await fs.readFile(absolute), relative);
  }
  return candidates.length;
}

async function inspectGitObjectStream(root, objects) {
  const entries = [...objects];
  if (entries.length === 0) return 0;

  return new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let pending = Buffer.alloc(0);
    let current = null;
    let entryIndex = 0;
    let inspected = 0;
    let stderr = "";
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(error);
    };

    const consume = () => {
      while (entryIndex < entries.length) {
        if (!current) {
          const newline = pending.indexOf(0x0a);
          if (newline === -1) return;
          const header = pending.subarray(0, newline).toString("utf8");
          pending = pending.subarray(newline + 1);
          const match = /^([0-9a-f]{40,64}) ([a-z]+) ([0-9]+)$/u.exec(header);
          invariant(match, `unable to parse Git batch header: ${header}`);
          const [expectedObject] = entries[entryIndex];
          invariant(match[1] === expectedObject, "Git batch object order changed unexpectedly");
          const size = Number(match[3]);
          invariant(Number.isSafeInteger(size) && size >= 0, "invalid Git object size");
          current = { object: match[1], type: match[2], size };
        }

        if (pending.length < current.size + 1) return;
        invariant(pending[current.size] === 0x0a, "Git batch object delimiter is missing");
        const bytes = Buffer.from(pending.subarray(0, current.size));
        pending = pending.subarray(current.size + 1);
        const [, labels] = entries[entryIndex];
        if (current.type === "blob" && labels.size > 0) {
          for (const label of labels) {
            inspectBytes(bytes, `Git object ${current.object} ${label}`);
          }
          inspected += 1;
        } else if (current.type === "commit" || current.type === "tag") {
          inspectBytes(bytes, `Git object ${current.object}`);
          inspected += 1;
        }
        entryIndex += 1;
        current = null;
      }
    };

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      try {
        pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
        consume();
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      try {
        consume();
        invariant(code === 0, `git cat-file --batch failed: ${stderr.trim() || `exit ${code}`}`);
        invariant(entryIndex === entries.length, "Git batch output ended before every object was read");
        invariant(current === null && pending.length === 0, "Git batch output contained trailing data");
        settled = true;
        resolve(inspected);
      } catch (error) {
        fail(error);
      }
    });
    child.stdin.end(`${entries.map(([object]) => object).join("\n")}\n`);
  });
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

  return inspectGitObjectStream(root, objects);
}

export async function scanPublicBoundary({ root }) {
  const absoluteRoot = await fs.realpath(path.resolve(root));
  invariant((await fs.stat(absoluteRoot)).isDirectory(), "public release root must be a directory");
  const { stdout } = await git(absoluteRoot, ["rev-parse", "--show-toplevel"]);
  const gitRoot = await fs.realpath(path.resolve(stdout.trim()));
  invariant(gitRoot === absoluteRoot, "public release root must be the Git repository root");
  const files = await inspectTrackedTree(absoluteRoot);
  const workingFiles = await inspectWorkingTreeCandidates(absoluteRoot);
  const gitObjects = await inspectReachableHistory(absoluteRoot);
  return Object.freeze({ ok: true, files, workingFiles, git: true, gitObjects });
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

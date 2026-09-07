#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readOption(args, name, { required = true } = {}) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  if (required) throw new Error(`Missing required option ${name}`);
  return null;
}

function normalizePathText(source) {
  return source.replaceAll("\\", "/");
}

function readShellMatrix(workflow) {
  const matrixMatch = workflow.match(/matrix\s*:\s*[\r\n]+([\s\S]*?)(?=\n\s{4}\S|\n\S|$)/);
  const matrix = matrixMatch?.[1] ?? "";
  const inline = matrix.match(/shell\s*:\s*\[([^\]]+)\]/)?.[1];
  if (!inline) return [];
  return inline
    .split(",")
    .map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

export function verifyWindowsNativeCiChain(rootDirectory) {
  const root = resolve(rootDirectory);
  const workflow = normalizePathText(
    readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")
  );
  const entrypoint = normalizePathText(
    readFileSync(resolve(root, "windows/tests/run-tests.ps1"), "utf8")
  );

  if (!/runs-on:\s*windows-latest/.test(workflow)) {
    throw new Error("Windows CI must run on windows-latest");
  }

  const shells = readShellMatrix(workflow);
  if (!shells.includes("powershell.exe") || !shells.includes("pwsh.exe")) {
    throw new Error("Windows CI must execute under both powershell.exe and pwsh.exe");
  }
  if (!/\$\{\{\s*matrix\.shell\s*\}\}[\s\S]*?-File\s+\.\/windows\/tests\/run-tests\.ps1/.test(workflow)) {
    throw new Error("Windows CI must invoke windows/tests/run-tests.ps1 through matrix.shell");
  }
  if (!/node[\s\S]*?windows\/tests\/native-suite-runner\.mjs/.test(entrypoint)) {
    throw new Error("windows/tests/run-tests.ps1 must invoke native-suite-runner.mjs");
  }
  if (!/\$LASTEXITCODE\s+-ne\s+0[\s\S]*?throw/.test(entrypoint)) {
    throw new Error("windows/tests/run-tests.ps1 must fail when the native suite runner fails");
  }

  return {
    shells: ["powershell.exe", "pwsh.exe"],
    entrypoint: "windows/tests/run-tests.ps1",
    nativeRunner: "windows/tests/native-suite-runner.mjs"
  };
}

function main(args) {
  const root = readOption(args, "--root", { required: false }) ?? process.cwd();
  const result = verifyWindowsNativeCiChain(root);
  process.stdout.write(
    `PASS: Windows CI runs ${result.nativeRunner} through ${result.entrypoint} under ${result.shells.join(" and ")}\n`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

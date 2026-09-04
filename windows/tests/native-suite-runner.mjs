#!/usr/bin/env node

import { readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const expectedSuites = [
  "config-startup-rollback.tests.ps1",
  "dynamic-v2-import.Tests.ps1",
  "start-cdp-failure-appearance-recovery.tests.ps1",
  "start-post-launch-appearance-recovery.tests.ps1",
  "start-renderer-readiness.tests.ps1",
  "start-verified-skin-preserved.tests.ps1",
  "theme-zip-import.tests.ps1",
  "zip-structure.Tests.ps1"
];

function readOption(args, name, { required = true } = {}) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  if (required) throw new Error(`Missing required option ${name}`);
  return null;
}

export function validateNativeSuiteNames(suiteNames) {
  const expectedSuiteNamesCaseFolded = new Set(expectedSuites.map((name) => name.toLowerCase()));
  const suiteNameCountsCaseFolded = new Map();
  for (const name of suiteNames) {
    const caseFoldedName = name.toLowerCase();
    suiteNameCountsCaseFolded.set(caseFoldedName, (suiteNameCountsCaseFolded.get(caseFoldedName) ?? 0) + 1);
  }
  const suiteNamesCaseFolded = new Set(suiteNameCountsCaseFolded.keys());
  const duplicates = [...suiteNameCountsCaseFolded]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
  const missing = expectedSuites.filter((name) => !suiteNamesCaseFolded.has(name.toLowerCase()));
  const unexpected = suiteNames.filter((name) => !expectedSuiteNamesCaseFolded.has(name.toLowerCase()));
  if (missing.length > 0 || unexpected.length > 0 || duplicates.length > 0) {
    const details = [
      missing.length > 0 ? `Missing: ${missing.join(", ")}` : null,
      unexpected.length > 0 ? `Unexpected: ${unexpected.join(", ")}` : null,
      duplicates.length > 0 ? `Case-insensitive duplicates: ${duplicates.join(", ")}` : null
    ].filter(Boolean).join("\n");
    throw new Error(`Windows PowerShell native suite set changed:\n${details}`);
  }
}

function main(args) {
  const shell = resolve(readOption(args, "--shell"));
  const shellPrefix = readOption(args, "--shell-prefix", { required: false });
  const testsDirectory = resolve(readOption(args, "--tests-dir"));
  const root = resolve(readOption(args, "--root"));
  const suites = readdirSync(testsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".tests.ps1"))
    .map((entry) => resolve(testsDirectory, entry.name))
    .sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));

  const suiteNames = suites.map((suite) => basename(suite));
  validateNativeSuiteNames(suiteNames);

  const failures = [];
  for (const suite of suites) {
    process.stdout.write(`RUN: ${suite}\n`);
    const result = spawnSync(shell, [
      ...(shellPrefix ? [resolve(shellPrefix)] : []),
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "RemoteSigned",
      "-File",
      suite,
      "-Root",
      root
    ], { stdio: "inherit" });
    if (result.error) {
      failures.push(`${suite}: ${result.error.message}`);
    } else if (result.status !== 0) {
      failures.push(`${suite}: exit code ${result.status ?? `signal ${result.signal}`}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Windows PowerShell native test failures:\n${failures.join("\n")}`);
  }
  process.stdout.write(`PASS: ${suites.length} Windows PowerShell native test suites\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

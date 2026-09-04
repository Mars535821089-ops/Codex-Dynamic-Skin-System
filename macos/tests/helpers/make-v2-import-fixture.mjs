#!/usr/bin/env node

import process from "node:process";
import { makeV2Package } from "../../../tools/tests/helpers/theme-fixtures.mjs";

const [parent, name, mode = "valid"] = process.argv.slice(2);
if (!parent || !name || !["valid", "undeclared", "long-id"].includes(mode)) {
  console.error("Usage: make-v2-import-fixture.mjs <parent> <name> [valid|undeclared|long-id]");
  process.exit(2);
}

const fixture = await makeV2Package(parent, name, {
  undeclared: mode === "undeclared",
  mutateTheme: mode === "long-id"
    ? (theme) => {
        theme.id = `test.${"a".repeat(100)}`;
        theme.name = "Long ID dynamic test";
      }
    : undefined,
});
process.stdout.write(fixture.root);

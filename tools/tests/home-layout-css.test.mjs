import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const css = await fs.readFile(new URL("../../runtime/dream-skin.css", import.meta.url), "utf8");

test("home skin does not render a theme-name badge or constrain suggestions to a two-card measurement", () => {
  assert.doesNotMatch(css, /content:\s*var\(--dream-skin-name/u);
  assert.doesNotMatch(css, /width:\s*min\(58%/u);
  assert.match(css, /__DREAM_SELECTOR_HOME_SUGGESTIONS__[\s\S]*grid-template-columns:\s*repeat\(4/u);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*grid-template-columns:\s*repeat\(2/u);
  assert.match(css, /@media \(max-width: 420px\)[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/u);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../api/rank.js", import.meta.url),
  "utf8"
);

const module = await import(
  `data:text/javascript;base64,${Buffer.from(
    `${source}\nexport { normalizeDeepLimit };`
  ).toString("base64")}`
);

test("omitted and empty screener limits use the documented default", () => {
  for (const value of [null, undefined, "", "   "]) {
    assert.equal(module.normalizeDeepLimit(value), 18);
  }
});

test("explicit screener limits preserve the 5..24 bounds", () => {
  assert.equal(module.normalizeDeepLimit("3"), 5);
  assert.equal(module.normalizeDeepLimit("12"), 12);
  assert.equal(module.normalizeDeepLimit("18"), 18);
  assert.equal(module.normalizeDeepLimit("30"), 24);
  assert.equal(module.normalizeDeepLimit("invalid"), 18);
});

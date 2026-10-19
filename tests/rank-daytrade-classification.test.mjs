import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("rank exposes short-term daytrade classification without weakening swing gate", async () => {
  const source = await readFile(
    new URL("../api/rank.js", import.meta.url),
    "utf8"
  );

  assert.match(source, /function shortTermAssessment\(/);
  assert.match(source, /daytradeGrade/);
  assert.match(source, /daytradeChecksPassed/);
  assert.match(source, /daytradeChecksTotal/);
  assert.match(source, /missingChecks/);
  assert.match(source, /pullback_or_breakout_retest/);
  assert.match(source, /volume_expansion/);
  assert.match(source, /external_market_filter/);

  // Missing richer inputs must stay UNKNOWN rather than becoming false.
  assert.match(
    source,
    /missingChecks\.push\([\s\S]*?"pullback_or_breakout_retest"[\s\S]*?"volume_expansion"[\s\S]*?"external_market_filter"/
  );

  // Strict swing/actionable gate remains unchanged.
  assert.match(
    source,
    /x\.confidence\s*>=\s*60/
  );
  assert.match(
    source,
    /executionQuality[\s\S]*?score[\s\S]*?>=\s*0\.7/
  );
});

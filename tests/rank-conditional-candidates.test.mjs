import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("rank screener exposes conditional daytrade candidates without changing strict candidates", async () => {
  const source = await readFile(
    new URL("../api/rank.js", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /const conditionalCandidates\s*=/
  );
  assert.match(
    source,
    /conditionalCandidates,/
  );
  assert.match(
    source,
    /nearCandidates:\s*conditionalCandidates/
  );
  assert.match(
    source,
    /grade:\s*"WATCH"/
  );
  assert.match(
    source,
    /timeHorizon:\s*"DAYTRADE"/
  );
  assert.match(
    source,
    /upgradeConditions/
  );
  assert.match(
    source,
    /x\?\.components\?\.quality/
  );

  // Existing strict actionable gate must remain intact.
  assert.match(
    source,
    /x\.confidence\s*>=\s*60/
  );
  assert.match(
    source,
    /executionQuality[\s\S]*?score[\s\S]*?>=\s*0\.7/
  );
});

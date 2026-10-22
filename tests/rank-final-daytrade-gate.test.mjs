import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../api/rank.js", import.meta.url),
  "utf8"
);
const { isDaytradeTrade } = await import(
  `data:text/javascript;base64,${Buffer.from(`${source}\nexport { isDaytradeTrade };`).toString("base64")}`
);

function result({
  grade = "A",
  passed = 5,
  total = 7,
  execution = 0.7,
  dataStatus = "NORMAL",
} = {}) {
  return {
    executionQuality: { score: execution },
    shortTerm: {
      daytradeGrade: grade,
      daytradeChecksPassed: passed,
      daytradeChecksTotal: total,
      dataQuality: { status: dataStatus },
    },
  };
}

test("final daytrade gate requires 5/7, execution >= 0.70, and normal data", () => {
  assert.equal(isDaytradeTrade(result()), true);
  assert.equal(isDaytradeTrade(result({ passed: 4 })), false);
  assert.equal(isDaytradeTrade(result({ execution: 0.69 })), false);
  assert.equal(isDaytradeTrade(result({ dataStatus: "DEGRADED" })), false);
  assert.equal(isDaytradeTrade(result({ dataStatus: "INCOMPLETE" })), false);
  assert.equal(isDaytradeTrade(result({ grade: "UNKNOWN" })), false);
  assert.equal(isDaytradeTrade(result({ total: 6 })), false);
});

test("rank exposes a separately gated daytradeCandidates list", () => {
  assert.match(
    source,
    /const daytradeCandidates\s*=\s*deep\s*\.filter\(\s*isDaytradeTrade\s*\)\s*\.slice\(\s*0,\s*3\s*\)/
  );
  assert.match(source, /candidates,\s*\n\s*daytradeCandidates,/);
  assert.match(source, /daytradeCandidateCoins\.has\(\s*x\.coin\s*\)/);
});

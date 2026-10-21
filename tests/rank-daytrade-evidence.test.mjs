import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../api/rank.js", import.meta.url), "utf8");
const { shortTermAssessment, evaluate } = await import(
  `data:text/javascript;base64,${Buffer.from(`${source}\nexport { shortTermAssessment, evaluate };`).toString("base64")}`
);

function fixture(direction = 1) {
  return {
    coin: "SUI",
    live: {
      price: { mid: 10, bid: 9.999, ask: 10.001, spreadBps: 2 },
      momentum: { m15: { returnPct: direction }, m60: { returnPct: direction } },
      context: { funding: 0, openInterest: 2_000_000, dayNtlVlm: 50_000_000 },
      orderBook: {
        top5: { imbalance: direction * 0.8 },
        top20: { imbalance: direction * 0.6, bidSize: 20_000, askSize: 20_000 },
      },
    },
    history: { windows: { m60: { ready: true, pricePct: direction, oiPct: 1 } } },
    quality: { liveFresh: true, historyAvailable: true, full60mReady: true, historyAgeMs: 0 },
  };
}

test("execution/data quality cannot inflate seven evidence groups into A", () => {
  for (const direction of [1, -1]) {
    const result = shortTermAssessment(fixture(direction), { score: 1 }, 1);
    assert.notEqual(result.daytradeGrade, "A");
    assert.equal(result.daytradeChecksTotal, 7);
    assert.equal(result.checks.length, 7);
    assert.ok(result.daytradeChecksPassed <= 4);
    assert.ok(!result.checks.some(x => ["execution_quality", "data_quality"].includes(x.name)));
    assert.equal(result.dataQuality.status, "INCOMPLETE");
    for (const name of result.missingChecks) assert.ok(result.upgradeConditions.includes(name));
    assert.ok(result.upgradeConditions.includes("confirmed_m15_m60_required"));
    assert.ok(result.upgradeConditions.includes("h4_non_adverse_required"));
  }
});

test("missing/null inputs remain UNKNOWN, not failed or zero-valued evidence", () => {
  const intel = fixture();
  intel.live.momentum.m15.returnPct = null;
  intel.live.context.funding = null;
  intel.live.orderBook.top5.imbalance = null;
  intel.history.windows.m60.oiPct = null;
  const result = shortTermAssessment(intel, { score: 1 }, 1);
  assert.equal(result.daytradeGrade, "UNKNOWN");
  for (const name of ["m15_m60_direction", "price_oi_alignment", "funding_not_overheated", "orderbook_alignment"]) {
    const check = result.checks.find(x => x.name === name);
    assert.equal(check.status, "UNKNOWN");
    assert.equal(check.passed, null);
    assert.ok(result.missingChecks.includes(name));
  }
});

test("opposing Top5/Top20 cannot pass by weighted cancellation", () => {
  const intel = fixture();
  intel.live.orderBook.top20.imbalance = -0.1;
  const result = shortTermAssessment(intel, { score: 1 }, 1);
  assert.equal(result.checks.find(x => x.name === "orderbook_alignment").passed, false);
});

test("stale or incomplete history cannot produce A despite good execution", () => {
  const intel = fixture();
  intel.quality.liveFresh = false;
  intel.quality.historyAvailable = false;
  intel.quality.full60mReady = false;
  const result = evaluate(intel);
  assert.notEqual(result.daytradeGrade, "A");
  assert.equal(result.shortTerm.dataQuality.status, "DEGRADED");
  assert.ok(result.upgradeConditions.includes("data_quality"));
  assert.equal(result.shortTerm.checks.find(x => x.name === "m15_m60_direction").status, "UNKNOWN");
});

test("short-term data quality is separate from unchanged swing evaluation", async () => {
  const legacySource = source.replace(
    /function shortTermAssessment\([\s\S]*?\nfunction evaluate\(/,
    'function shortTermAssessment() { return {}; }\nfunction evaluate('
  );
  const legacy = await import(`data:text/javascript;base64,${Buffer.from(`${legacySource}\nexport { evaluate };`).toString("base64")}`);
  const additions = new Set(["shortTerm", "timeHorizon", "daytradeGrade", "daytradeChecksPassed", "daytradeChecksTotal", "missingChecks", "upgradeConditions"]);
  const swing = value => Object.fromEntries(Object.entries(value).filter(([key]) => !additions.has(key)));
  for (const direction of [1, -1]) {
    assert.deepEqual(swing(evaluate(fixture(direction))), swing(legacy.evaluate(fixture(direction))));
  }
});

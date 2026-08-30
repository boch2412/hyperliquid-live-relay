export const PERSISTENCE_WEIGHTS = Object.freeze([0.05, 0.10, 0.15]);
export const PRODUCTION_PERSISTENCE_WEIGHT = 0.10;

export function scoreWithPersistence(baseScore, persistenceScore, weight) {
  const base = Number(baseScore);
  const persistence = Number(persistenceScore);
  const w = Number(weight);

  if (!Number.isFinite(base) || !Number.isFinite(persistence)) {
    throw new TypeError("baseScore and persistenceScore must be finite numbers");
  }
  if (!Number.isFinite(w) || w < 0 || w > 1) {
    throw new RangeError("weight must be between 0 and 1");
  }

  return (1 - w) * base + w * persistence;
}

export function buildShadowScores(baseScore, persistenceScore) {
  return Object.fromEntries(
    PERSISTENCE_WEIGHTS.map((weight) => [
      String(Math.round(weight * 100)),
      scoreWithPersistence(baseScore, persistenceScore, weight),
    ])
  );
}

function stableKey(row) {
  return String(row?.coin ?? row?.symbol ?? "");
}

export function rankShadowRows(rows, weight) {
  return rows
    .map((row) => ({
      ...row,
      shadowScore: scoreWithPersistence(
        row.baseScore,
        row.persistenceScore,
        weight
      ),
    }))
    .sort((a, b) => {
      const scoreDiff = b.shadowScore - a.shadowScore;
      if (scoreDiff !== 0) return scoreDiff;

      const baseDiff = Number(b.baseScore) - Number(a.baseScore);
      if (baseDiff !== 0) return baseDiff;

      return stableKey(a).localeCompare(stableKey(b));
    })
    .map((row, index) => ({ ...row, shadowRank: index + 1 }));
}

export function buildShadowSnapshot({
  snapshotId,
  inputTimestamp,
  dataVersion = null,
  apiVersion = null,
  codeVersion = null,
  rows,
  assumptions = {},
}) {
  if (!snapshotId) throw new Error("snapshotId is required");
  if (!inputTimestamp) throw new Error("inputTimestamp is required");
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");

  const normalizedRows = rows.map((row) => ({
    coin: row.coin ?? null,
    bias: row.bias ?? null,
    baseScore: Number(row.baseScore),
    persistenceScore: Number(row.persistenceScore),
    confidence: row.confidence ?? null,
    executionScore: row.executionScore ?? null,
    bid: row.bid ?? null,
    ask: row.ask ?? null,
    freshnessMs: row.freshnessMs ?? null,
    live: row.live ?? null,
    mappingKnown: row.mappingKnown ?? null,
    marketOpen: row.marketOpen ?? null,
    shadowScores: buildShadowScores(row.baseScore, row.persistenceScore),
  }));

  const rankings = Object.fromEntries(
    PERSISTENCE_WEIGHTS.map((weight) => [
      String(Math.round(weight * 100)),
      rankShadowRows(normalizedRows, weight).map((row) => ({
        coin: row.coin,
        bias: row.bias,
        rank: row.shadowRank,
        finalScore: row.shadowScore,
      })),
    ])
  );

  return Object.freeze({
    snapshotId,
    inputTimestamp,
    versions: Object.freeze({ dataVersion, apiVersion, codeVersion }),
    assumptions: Object.freeze({ ...assumptions }),
    productionWeightPct: 10,
    shadowWeightPcts: Object.freeze([5, 10, 15]),
    rows: Object.freeze(normalizedRows),
    rankings: Object.freeze(rankings),
  });
}

export function classifyObservation({
  status = 200,
  requiredFieldsPresent = true,
  freshnessMs,
  live,
  mappingKnown,
  marketOpen,
  allWeightsSucceeded = true,
  candidateCount = 0,
}) {
  const reasons = [];

  if (status === 429) reasons.push("http_429");
  if (status >= 500) reasons.push("http_5xx");
  if (!requiredFieldsPresent) reasons.push("required_field_missing");
  if (Number.isFinite(Number(freshnessMs)) && Number(freshnessMs) > 10000) {
    reasons.push("stale_gt_10000ms");
  }
  if (live === false) reasons.push("live_false");
  if (mappingKnown === false) reasons.push("mapping_unknown");
  if (marketOpen === false) reasons.push("market_closed");
  if (!allWeightsSucceeded) reasons.push("partial_weight_failure");

  if (reasons.length) {
    return { valid: false, noTrade: false, reasons };
  }

  return {
    valid: true,
    noTrade: Number(candidateCount) === 0,
    reasons: [],
  };
}

export function netReturn({ direction, entryBid, entryAsk, exitBid, exitAsk, feeRate = 0, slippageRate = 0 }) {
  const fee = Number(feeRate);
  const slip = Number(slippageRate);

  if (![fee, slip].every(Number.isFinite)) throw new TypeError("feeRate/slippageRate must be finite");

  if (direction === "LONG") {
    const entry = Number(entryAsk) * (1 + slip);
    const exit = Number(exitBid) * (1 - slip);
    if (!(entry > 0) || !(exit > 0)) return null;
    return exit / entry - 1 - 2 * fee;
  }

  if (direction === "SHORT") {
    const entry = Number(entryBid) * (1 - slip);
    const exit = Number(exitAsk) * (1 + slip);
    if (!(entry > 0) || !(exit > 0)) return null;
    return entry / exit - 1 - 2 * fee;
  }

  return null;
}

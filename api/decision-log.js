const COINS = [
  "BTC",
  "SUI",
  "xyz:MU",
  "xyz:SNDK",
  "xyz:SKHX",
];

const LOOKBACK_MS = 30 * 60 * 1000;
const MAX_RECORDS = 6;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_TOTAL_MARGIN = 5000;
const MAX_LEVERAGE = 10;
const MAX_PORTFOLIO_STOP_RISK_USD =
  MAX_TOTAL_MARGIN * 0.01;
const MAX_POSITIONS = 3;

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function envFirst(names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return null;
}

function redisConfig() {
  const url =
    envFirst([
      "STORAGE_URL",
      "STORAGE_REST_API_URL",
      "STORAGE_REDIS_REST_URL",
      "STORAGE_UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_URL",
      "KV_REST_API_URL",
    ]) ||
    Object.entries(process.env).find(
      ([k, v]) =>
        /(?:REDIS|KV|STORAGE).*URL/i.test(k) &&
        !/QSTASH/i.test(k) &&
        typeof v === "string" &&
        v.includes("upstash")
    )?.[1];

  const token =
    envFirst([
      "STORAGE_TOKEN",
      "STORAGE_REST_API_TOKEN",
      "STORAGE_REDIS_REST_TOKEN",
      "STORAGE_UPSTASH_REDIS_REST_TOKEN",
      "UPSTASH_REDIS_REST_TOKEN",
      "KV_REST_API_TOKEN",
    ]) ||
    Object.entries(process.env).find(
      ([k]) =>
        /(?:REDIS|KV|STORAGE).*TOKEN/i.test(k) &&
        !/QSTASH/i.test(k) &&
        !/SIGNING/i.test(k)
    )?.[1];

  return { url, token };
}

async function redis(cmd) {
  const { url, token } = redisConfig();

  if (!url || !token) {
    throw new Error(
      "Redis environment variables not found"
    );
  }

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });

  const text = await r.text();

  if (!r.ok) {
    throw new Error(
      `Redis ${r.status}: ${text.slice(0, 200)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseRecord(v) {
  if (!v) return null;

  try {
    return typeof v === "string"
      ? JSON.parse(v)
      : v;
  } catch {
    return null;
  }
}

async function loadHistory(coin) {
  const now = Date.now();
  const key = `hl:rank:${coin}`;

  const raw = await redis([
    "ZRANGEBYSCORE",
    key,
    String(now - LOOKBACK_MS),
    "+inf",
  ]);

  const values =
    Array.isArray(raw?.result)
      ? raw.result
      : [];

  return values
    .map(parseRecord)
    .filter(Boolean)
    .sort(
      (a, b) =>
        Number(a.t) - Number(b.t)
    )
    .slice(-MAX_RECORDS);
}

function direction(row) {
  if (row?.bias === "LONG") return 1;
  if (row?.bias === "SHORT") return -1;
  return 0;
}

function scoreDirection(row) {
  const score = n(row?.compositeScore);

  if (score == null) return 0;
  if (score > 0) return 1;
  if (score < 0) return -1;

  return 0;
}

function evaluateDirection(rows, wanted) {
  const recent = rows.slice(-3);

  const wantedBias =
    wanted > 0 ? "LONG" : "SHORT";

  const sameBias =
    recent.filter(
      (x) => x?.bias === wantedBias
    );

  const twoOfThree =
    recent.length >= 3 &&
    sameBias.length >= 2;

  const last =
    rows[rows.length - 1];

  const prev =
    rows[rows.length - 2];

  let consecutive = false;
  let improving = false;

  if (last && prev) {
    consecutive =
      direction(last) === wanted &&
      direction(prev) === wanted;

    const lastScore =
      n(last.compositeScore);

    const prevScore =
      n(prev.compositeScore);

    if (
      lastScore != null &&
      prevScore != null
    ) {
      improving =
        wanted > 0
          ? lastScore > prevScore
          : lastScore < prevScore;
    }
  }

  const consecutiveImproving =
    consecutive && improving;

  const latestStillValid =
    last &&
    (
      direction(last) === wanted ||
      (
        direction(last) === 0 &&
        scoreDirection(last) === wanted &&
        Math.abs(
          n(last.compositeScore) ?? 0
        ) >= 0.55
      )
    );

  const passed =
    Boolean(
      latestStillValid &&
      (
        twoOfThree ||
        consecutiveImproving
      )
    );

  let reason =
    "not_persistent";

  if (passed) {
    reason =
      consecutiveImproving
        ? "consecutive_and_improving"
        : "two_of_three";
  } else if (!latestStillValid) {
    reason =
      "latest_signal_weakened";
  } else if (rows.length < 2) {
    reason =
      "insufficient_history";
  }

  return {
    direction: wantedBias,
    passed,
    reason,
    sampleCount: rows.length,
    twoOfThree,
    consecutive,
    improving,
    consecutiveImproving,
    latest: last ?? null,
    previous: prev ?? null,
  };
}

function evaluateCoin(coin, rows) {
  const long =
    evaluateDirection(rows, 1);

  const short =
    evaluateDirection(rows, -1);

  let persistentBias =
    "NEUTRAL";

  let passed = false;

  let reason =
    "no_persistent_signal";

  if (
    long.passed &&
    !short.passed
  ) {
    persistentBias =
      "LONG";

    passed = true;
    reason = long.reason;
  } else if (
    short.passed &&
    !long.passed
  ) {
    persistentBias =
      "SHORT";

    passed = true;
    reason = short.reason;
  } else if (
    long.passed &&
    short.passed
  ) {
    const latest =
      rows[rows.length - 1];

    const d =
      scoreDirection(latest);

    if (d > 0) {
      persistentBias =
        "LONG";

      reason =
        "both_passed_latest_long";
    } else if (d < 0) {
      persistentBias =
        "SHORT";

      reason =
        "both_passed_latest_short";
    }

    passed =
      persistentBias !==
      "NEUTRAL";
  }

  return {
    coin,
    passed,
    persistentBias,
    reason,
    sampleCount: rows.length,
    latest:
      rows[rows.length - 1] ??
      null,
  };
}

function rangePct(window) {
  const high =
    n(window?.high);

  const low =
    n(window?.low);

  const close =
    n(window?.close);

  if (
    high == null ||
    low == null ||
    close == null ||
    close === 0
  ) {
    return null;
  }

  return (
    ((high - low) / close) *
    100
  );
}

function leverageFor(
  ranked,
  stopPct
) {
  const confidence =
    n(ranked?.confidence) ?? 0;

  const observedVol =
    n(
      ranked
        ?.volatility
        ?.observedPct
    ) ?? 0.3;

  let lev = 4;

  if (confidence >= 82) {
    lev = 7;
  } else if (
    confidence >= 75
  ) {
    lev = 6;
  } else if (
    confidence >= 67
  ) {
    lev = 5;
  } else if (
    confidence >= 60
  ) {
    lev = 4;
  }

  if (observedVol >= 0.6) {
    lev -= 2;
  } else if (
    observedVol >= 0.35
  ) {
    lev -= 1;
  }

  if (stopPct >= 1.2) {
    lev -= 2;
  } else if (
    stopPct >= 0.7
  ) {
    lev -= 1;
  }

  return clamp(
    lev,
    2,
    MAX_LEVERAGE
  );
}

function structuralStop(ranked) {
  const baseline =
    clamp(
      n(
        ranked
          ?.volatility
          ?.baselinePct
      ) ?? 0.3,
      0.08,
      1.5
    );

  const momentum =
    ranked
      ?.marketSnapshot
      ?.momentum;

  const m5Range =
    rangePct(momentum?.m5);

  const m15Range =
    rangePct(momentum?.m15);

  const m60Range =
    rangePct(momentum?.m60);

  const spreadBps =
    n(
      ranked
        ?.marketSnapshot
        ?.price
        ?.spreadBps
    ) ?? 0;

  const spreadPct =
    spreadBps / 100;

  const candidates = [
    baseline * 1.35,

    m5Range != null
      ? m5Range * 0.85
      : null,

    m15Range != null
      ? m15Range * 0.65
      : null,

    m60Range != null
      ? m60Range * 0.30
      : null,

    spreadPct * 8,
  ].filter(
    (x) =>
      Number.isFinite(x)
  );

  let stopPct =
    Math.max(
      0.18,
      ...candidates
    );

  stopPct =
    clamp(
      stopPct,
      0.18,
      2.25
    );

  return {
    stopPct,

    inputs: {
      baselinePct:
        baseline,

      m5RangePct:
        m5Range,

      m15RangePct:
        m15Range,

      m60RangePct:
        m60Range,

      spreadPct,
    },
  };
}

function entryParameters(
  ranked
) {
  const baseline =
    clamp(
      n(
        ranked
          ?.volatility
          ?.baselinePct
      ) ?? 0.3,
      0.08,
      1.5
    );

  const momentum =
    ranked
      ?.marketSnapshot
      ?.momentum;

  const m5Range =
    rangePct(momentum?.m5);

  const m15Range =
    rangePct(momentum?.m15);

  let pullbackPct =
    baseline * 0.20;

  if (m5Range != null) {
    pullbackPct =
      Math.max(
        pullbackPct,
        m5Range * 0.15
      );
  }

  if (m15Range != null) {
    pullbackPct =
      Math.max(
        pullbackPct,
        m15Range * 0.08
      );
  }

  return {
    pullbackPct:
      clamp(
        pullbackPct,
        0.015,
        0.35
      ),
  };
}

function targetParameters(
  ranked,
  stopPct
) {
  const confidence =
    n(
      ranked?.confidence
    ) ?? 0;

  const strength =
    Math.abs(
      n(
        ranked
          ?.compositeScore
      ) ?? 0
    );

  let rr1 = 1.25;
  let rr2 = 2.10;

  if (
    confidence >= 78 &&
    strength >= 0.9
  ) {
    rr1 = 1.35;
    rr2 = 2.40;
  } else if (
    confidence < 66
  ) {
    rr1 = 1.10;
    rr2 = 1.80;
  }

  let tp1ClosePct = 50;

  if (confidence < 67) {
    tp1ClosePct = 65;
  } else if (
    confidence >= 80
  ) {
    tp1ClosePct = 40;
  }

  return {
    rr1,
    rr2,

    tp1Pct:
      stopPct * rr1,

    tp2Pct:
      stopPct * rr2,

    tp1ClosePct,

    tp2ClosePct:
      100 - tp1ClosePct,
  };
}

function riskWeights(
  actionable
) {
  const raw =
    actionable.map(
      (x) => {
        const opportunity =
          n(
            x?.opportunity
          ) ?? 0;

        const confidence =
          n(
            x?.confidence
          ) ?? 0;

        const execution =
          n(
            x
              ?.executionQuality
              ?.score
          ) ??
          n(x?.execution) ??
          0;

        return Math.max(
          0.01,
          opportunity *
            (confidence / 100) *
            execution
        );
      }
    );

  const total =
    raw.reduce(
      (a, b) => a + b,
      0
    );

  return raw.map(
    (x) =>
      total > 0
        ? x / total
        : 1 / raw.length
  );
}

function makeRawPlan(
  ranked,
  riskBudgetUsd
) {
  const side =
    ranked.bias;

  const price =
    ranked
      ?.marketSnapshot
      ?.price;

  const mid =
    n(price?.mid);

  const bid =
    n(price?.bid);

  const ask =
    n(price?.ask);

  if (
    mid == null ||
    bid == null ||
    ask == null
  ) {
    throw new Error(
      `${ranked.coin}: stored price unavailable`
    );
  }

  const structural =
    structuralStop(ranked);

  const stopPct =
    structural.stopPct;

  const entryModel =
    entryParameters(ranked);

  const pullbackPct =
    entryModel.pullbackPct;

  const targets =
    targetParameters(
      ranked,
      stopPct
    );

  const leverage =
    leverageFor(
      ranked,
      stopPct
    );

  let entryIdeal;
  let entryAggressive;

  if (side === "LONG") {
    entryIdeal =
      mid *
      (
        1 -
        pullbackPct / 100
      );

    entryAggressive =
      ask;
  } else {
    entryIdeal =
      mid *
      (
        1 +
        pullbackPct / 100
      );

    entryAggressive =
      bid;
  }

  const desiredNotional =
    riskBudgetUsd /
    (stopPct / 100);

  const requiredMargin =
    desiredNotional /
    leverage;

  return {
    ranked,
    coin:
      ranked.coin,
    side,
    riskBudgetUsd,
    stopPct,
    structuralStop:
      structural,
    leverage,
    entryIdeal,
    entryAggressive,
    pullbackPct,
    targets,
    desiredNotional,
    requiredMargin,
  };
}

function scaleForMargin(
  rawPlans
) {
  const totalRequiredMargin =
    rawPlans.reduce(
      (sum, x) =>
        sum +
        x.requiredMargin,
      0
    );

  const scale =
    totalRequiredMargin >
    MAX_TOTAL_MARGIN
      ? MAX_TOTAL_MARGIN /
        totalRequiredMargin
      : 1;

  return {
    scale,
    totalRequiredMargin,
  };
}

function finalizePlan(
  raw,
  scale
) {
  const margin =
    raw.requiredMargin *
    scale;

  const notional =
    raw.desiredNotional *
    scale;

  const actualRiskUsd =
    notional *
    (
      raw.stopPct /
      100
    );

  const entry =
    raw.entryIdeal;

  let stop;
  let tp1;
  let tp2;

  if (
    raw.side === "LONG"
  ) {
    stop =
      entry *
      (
        1 -
        raw.stopPct / 100
      );

    tp1 =
      entry *
      (
        1 +
        raw.targets.tp1Pct /
          100
      );

    tp2 =
      entry *
      (
        1 +
        raw.targets.tp2Pct /
          100
      );
  } else {
    stop =
      entry *
      (
        1 +
        raw.stopPct / 100
      );

    tp1 =
      entry *
      (
        1 -
        raw.targets.tp1Pct /
          100
      );

    tp2 =
      entry *
      (
        1 -
        raw.targets.tp2Pct /
          100
      );
  }

  const marginLossPct =
    raw.stopPct *
    raw.leverage;

  const chaseDistancePct =
    Math.abs(
      (
        raw.entryAggressive -
        raw.entryIdeal
      ) /
      raw.entryIdeal
    ) * 100;

  const maxChasePct =
    clamp(
      raw.pullbackPct *
        1.75,
      0.05,
      0.60
    );

  return {
    coin:
      raw.coin,

    side:
      raw.side,

    confidence:
      raw.ranked.confidence,

    compositeScore:
      raw.ranked
        .compositeScore,

    opportunity:
      raw.ranked
        .opportunity,

    margin:
      Math.round(
        margin
      ),

    leverage:
      raw.leverage,

    positionNotional:
      Math.round(
        notional
      ),

    market: {
      bid:
        raw.ranked
          ?.marketSnapshot
          ?.price
          ?.bid ?? null,

      ask:
        raw.ranked
          ?.marketSnapshot
          ?.price
          ?.ask ?? null,

      mid:
        raw.ranked
          ?.marketSnapshot
          ?.price
          ?.mid ?? null,

      spreadBps:
        raw.ranked
          ?.marketSnapshot
          ?.price
          ?.spreadBps ?? null,
    },

    entry: {
      ideal:
        raw.entryIdeal,

      aggressiveLimit:
        raw.entryAggressive,

      pullbackPct:
        raw.pullbackPct,

      chaseDistancePct,

      maxChasePct,

      chaseAllowed:
        chaseDistancePct <=
        maxChasePct,
    },

    risk: {
      stop,

      stopPct:
        raw.stopPct,

      allocatedRiskUsd:
        actualRiskUsd,

      marginLossPct,

      structuralInputs:
        raw
          .structuralStop
          .inputs,
    },

    targets: {
      tp1,

      tp1Pct:
        raw.targets.tp1Pct,

      tp1ClosePct:
        raw.targets
          .tp1ClosePct,

      tp2,

      tp2Pct:
        raw.targets.tp2Pct,

      tp2ClosePct:
        raw.targets
          .tp2ClosePct,

      rr1:
        raw.targets.rr1,

      rr2:
        raw.targets.rr2,
    },

    executionQuality:
      raw.ranked
        .executionQuality,

    volatility:
      raw.ranked
        .volatility,

    reasons:
      raw.ranked
        .reasons ?? [],
  };
}

function buildDecision(
  actionable,
  persistence
) {
  if (!actionable.length) {
    return {
      t:
        Date.now(),

      decision:
        "NO TRADE",

      tradeAllowed:
        false,

      reason:
        "no_actionable_persistent_signal",

      coin:
        null,

      side:
        null,

      confidence:
        null,

      score:
        null,

      marginUsd:
        null,

      leverage:
        null,

      entry:
        null,

      aggressiveLimit:
        null,

      stop:
        null,

      tp1:
        null,

      tp2:
        null,

      riskUsd:
        null,

      persistentSignals:
        persistence,

      plans:
        [],

      constraints: {
        maxTotalMargin:
          MAX_TOTAL_MARGIN,

        maxLeverage:
          MAX_LEVERAGE,

        maxPortfolioStopRiskUsd:
          MAX_PORTFOLIO_STOP_RISK_USD,

        maxPositions:
          MAX_POSITIONS,
      },

      system: {
        planOk:
          true,

        planSkipped:
          true,

        rankEmbedded:
          true,

        persistenceEmbedded:
          true,

        source:
          "redis_rank_persistence_local_plan",
      },
    };
  }

  const weights =
    riskWeights(
      actionable
    );

  const rawPlans =
    actionable.map(
      (ranked, i) =>
        makeRawPlan(
          ranked,
          MAX_PORTFOLIO_STOP_RISK_USD *
            weights[i]
        )
    );

  const sizing =
    scaleForMargin(
      rawPlans
    );

  const plans =
    rawPlans.map(
      (x) =>
        finalizePlan(
          x,
          sizing.scale
        )
    );

  const first =
    plans[0] ?? null;

  const totalMargin =
    plans.reduce(
      (sum, x) =>
        sum + x.margin,
      0
    );

  const totalStopRisk =
    plans.reduce(
      (sum, x) =>
        sum +
        x.risk
          .allocatedRiskUsd,
      0
    );

  return {
    t:
      Date.now(),

    decision:
      plans.length === 1
        ? `${first.side} ${first.coin}`
        : `${plans.length} TRADES`,

    tradeAllowed:
      true,

    reason:
      null,

    coin:
      first?.coin ?? null,

    side:
      first?.side ?? null,

    confidence:
      first?.confidence ??
      null,

    score:
      first
        ?.compositeScore ??
      null,

    marginUsd:
      first?.margin ??
      null,

    leverage:
      first?.leverage ??
      null,

    entry:
      first?.entry?.ideal ??
      null,

    aggressiveLimit:
      first
        ?.entry
        ?.aggressiveLimit ??
      null,

    stop:
      first?.risk?.stop ??
      null,

    tp1:
      first?.targets?.tp1 ??
      null,

    tp2:
      first?.targets?.tp2 ??
      null,

    riskUsd:
      first
        ?.risk
        ?.allocatedRiskUsd ??
      null,

    persistentSignals:
      persistence,

    plans,

    constraints: {
      maxTotalMargin:
        MAX_TOTAL_MARGIN,

      maxLeverage:
        MAX_LEVERAGE,

      maxPortfolioStopRiskUsd:
        MAX_PORTFOLIO_STOP_RISK_USD,

      maxPositions:
        MAX_POSITIONS,

      totalMargin,

      totalStopRiskUsd:
        totalStopRisk,

      marginScale:
        sizing.scale,
    },

    system: {
      planOk:
        true,

      planSkipped:
        false,

      rankEmbedded:
        true,

      persistenceEmbedded:
        true,

      source:
        "redis_rank_persistence_local_plan",
    },
  };
}

async function saveDecision(
  record
) {
  const key =
    "hl:decision";

  await redis([
    "ZADD",
    key,
    String(record.t),
    JSON.stringify(record),
  ]);

  await redis([
    "ZREMRANGEBYSCORE",
    key,
    "0",
    String(
      Date.now() -
      KEEP_MS
    ),
  ]);
}

export default async function handler(
  req,
  res
) {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  try {
    const evaluations = [];

    for (
      const coin of COINS
    ) {
      const rows =
        await loadHistory(
          coin
        );

      evaluations.push(
        evaluateCoin(
          coin,
          rows
        )
      );
    }

    const persistentSignals =
      evaluations
        .filter(
          (x) => x.passed
        )
        .map(
          (x) => ({
            coin:
              x.coin,

            bias:
              x.persistentBias,

            reason:
              x.reason,
          })
        );

    const persistentMap =
      new Map(
        persistentSignals.map(
          (x) => [
            x.coin,
            x.bias,
          ]
        )
      );

    const actionable =
      evaluations
        .map(
          (x) => x.latest
        )
        .filter(Boolean)
        .filter(
          (x) =>
            (
              x.bias === "LONG" ||
              x.bias === "SHORT"
            ) &&
            persistentMap.get(
              x.coin
            ) === x.bias &&
            x
              .marketSnapshot
              ?.price
              ?.mid != null &&
            x
              .marketSnapshot
              ?.price
              ?.bid != null &&
            x
              .marketSnapshot
              ?.price
              ?.ask != null
        )
        .sort(
          (a, b) =>
            (
              n(
                b.opportunity
              ) ?? 0
            ) -
            (
              n(
                a.opportunity
              ) ?? 0
            )
        )
        .slice(
          0,
          MAX_POSITIONS
        );

    const record =
      buildDecision(
        actionable,
        persistentSignals
      );

    await saveDecision(
      record
    );

    return res
      .status(200)
      .json({
        ok:
          true,

        saved:
          record,
      });
  } catch (e) {
    return res
      .status(500)
      .json({
        ok:
          false,

        error:
          String(e),

        generatedAt:
          Date.now(),
      });
  }
}

const BASE = "https://hyperliquid-live-relay.vercel.app";

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

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
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
    throw new Error("Redis environment variables not found");
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
    throw new Error(`Redis ${r.status}: ${text.slice(0, 200)}`);
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
    return typeof v === "string" ? JSON.parse(v) : v;
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

  const values = Array.isArray(raw?.result) ? raw.result : [];

  return values
    .map(parseRecord)
    .filter(Boolean)
    .sort((a, b) => Number(a.t) - Number(b.t))
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
  const wantedBias = wanted > 0 ? "LONG" : "SHORT";

  const sameBias = recent.filter(
    (x) => x?.bias === wantedBias
  );

  const twoOfThree =
    recent.length >= 3 &&
    sameBias.length >= 2;

  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];

  let consecutive = false;
  let improving = false;

  if (last && prev) {
    consecutive =
      direction(last) === wanted &&
      direction(prev) === wanted;

    const lastScore = n(last.compositeScore);
    const prevScore = n(prev.compositeScore);

    if (lastScore != null && prevScore != null) {
      improving =
        wanted > 0
          ? lastScore > prevScore
          : lastScore < prevScore;
    }
  }

  const consecutiveImproving =
    consecutive && improving;

  const directionalRows = recent.filter(
    (x) => scoreDirection(x) === wanted
  );

  const pressureConsistency =
    recent.length >= 3
      ? directionalRows.length / recent.length
      : 0;

  const scores = recent
    .map((x) => n(x.compositeScore))
    .filter((x) => x != null);

  const averageScore = scores.length
    ? scores.reduce((a, b) => a + b, 0) /
      scores.length
    : null;

  const averageMagnitude = scores.length
    ? scores.reduce(
        (a, b) => a + Math.abs(b),
        0
      ) / scores.length
    : null;

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

  const passed = Boolean(
    latestStillValid &&
    (
      twoOfThree ||
      consecutiveImproving
    )
  );

  let reason = "not_persistent";

  if (passed) {
    reason = consecutiveImproving
      ? "consecutive_and_improving"
      : "two_of_three";
  } else if (!latestStillValid) {
    reason = "latest_signal_weakened";
  } else if (rows.length < 2) {
    reason = "insufficient_history";
  }

  return {
    direction: wantedBias,
    passed,
    reason,
    sampleCount: rows.length,
    recentCount: recent.length,
    sameBiasCount: sameBias.length,
    twoOfThree,
    consecutive,
    improving,
    consecutiveImproving,
    pressureConsistency,
    averageScore,
    averageMagnitude,
    latest: last ?? null,
    previous: prev ?? null,
  };
}

function evaluateCoin(coin, rows) {
  const long = evaluateDirection(rows, 1);
  const short = evaluateDirection(rows, -1);

  let persistentBias = "NEUTRAL";
  let passed = false;
  let reason = "no_persistent_signal";

  if (long.passed && !short.passed) {
    persistentBias = "LONG";
    passed = true;
    reason = long.reason;
  } else if (short.passed && !long.passed) {
    persistentBias = "SHORT";
    passed = true;
    reason = short.reason;
  } else if (long.passed && short.passed) {
    const latest = rows[rows.length - 1];
    const d = scoreDirection(latest);

    if (d > 0) {
      persistentBias = "LONG";
      reason = "both_passed_latest_long";
    } else if (d < 0) {
      persistentBias = "SHORT";
      reason = "both_passed_latest_short";
    }

    passed =
      persistentBias !== "NEUTRAL";
  }

  return {
    coin,
    passed,
    persistentBias,
    reason,
    sampleCount: rows.length,
    latest:
      rows[rows.length - 1] ?? null,
    long,
    short,
  };
}

async function getPlan() {
  const r = await fetch(
    `${BASE}/api/plan`,
    {
      cache: "no-store",
    }
  );

  const text = await r.text();

  if (!r.ok) {
    throw new Error(
      `/api/plan ${r.status}: ${text.slice(0, 200)}`
    );
  }

  return JSON.parse(text);
}

function compactPlanDecision(
  plan,
  persistentSignals
) {
  const persistentMap = new Map(
    persistentSignals.map(
      (x) => [x.coin, x.bias]
    )
  );

  const plans = Array.isArray(plan?.plans)
    ? plan.plans.filter(
        (x) =>
          persistentMap.get(x?.coin) ===
          x?.side
      )
    : [];

  const firstPlan = plans[0] ?? null;

  const tradeAllowed =
    plan?.tradeAllowed === true &&
    plans.length > 0;

  return {
    t: Number(
      plan?.generatedAt ??
      Date.now()
    ),

    decision: tradeAllowed
      ? plans.length === 1
        ? `${firstPlan.side} ${firstPlan.coin}`
        : `${plans.length} TRADES`
      : "NO TRADE",

    tradeAllowed,

    reason: tradeAllowed
      ? null
      : plan?.reason ??
        "no_actionable_signal",

    coin:
      firstPlan?.coin ?? null,

    side:
      firstPlan?.side ?? null,

    confidence:
      firstPlan?.confidence ??
      firstPlan?.confidencePct ??
      null,

    score:
      firstPlan?.compositeScore ??
      null,

    marginUsd:
      firstPlan?.margin ??
      firstPlan?.marginUsd ??
      null,

    leverage:
      firstPlan?.leverage ?? null,

    entry:
      firstPlan?.entry?.ideal ??
      null,

    aggressiveLimit:
      firstPlan
        ?.entry
        ?.aggressiveLimit ??
      null,

    stop:
      firstPlan?.risk?.stop ??
      firstPlan?.stopLoss?.price ??
      null,

    tp1:
      firstPlan?.targets?.tp1 ??
      firstPlan?.takeProfit?.tp1?.price ??
      null,

    tp2:
      firstPlan?.targets?.tp2 ??
      firstPlan?.takeProfit?.tp2?.price ??
      null,

    riskUsd:
      firstPlan
        ?.risk
        ?.allocatedRiskUsd ??
      firstPlan
        ?.stopLoss
        ?.riskUsd ??
      null,

    persistentSignals,

    system: {
      planOk:
        plan?.ok === true,

      rankEmbedded:
        plan?.rank != null ||
        plan?.rankSnapshot != null,

      persistenceEmbedded:
        true,

      source:
        "redis_persistence_then_plan",
    },
  };
}

async function saveDecision(record) {
  const key = "hl:decision";

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
      Date.now() - KEEP_MS
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

    for (const coin of COINS) {
      const rows =
        await loadHistory(coin);

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

    if (
      !persistentSignals.length
    ) {
      const record = {
        t:
          Date.now(),

        decision:
          "NO TRADE",

        tradeAllowed:
          false,

        reason:
          "no_persistent_signal",

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
          [],

        system: {
          planOk:
            null,

          planSkipped:
            true,

          rankEmbedded:
            true,

          persistenceEmbedded:
            true,

          source:
            "redis_persistence_gate",
        },
      };

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
    }

    let record;

    try {
      const plan =
        await getPlan();

      record =
        compactPlanDecision(
          plan,
          persistentSignals
        );
    } catch (e) {
      record = {
        t:
          Date.now(),

        decision:
          "NO TRADE",

        tradeAllowed:
          false,

        reason:
          "plan_unavailable",

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

        persistentSignals,

        system: {
          planOk:
            false,

          planError:
            String(e),

          rankEmbedded:
            true,

          persistenceEmbedded:
            true,

          source:
            "redis_persistence_gate_plan_failed_safe",
        },
      };
    }

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

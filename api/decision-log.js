const BASE =
  "https://hyperliquid-live-relay.vercel.app";

const KEEP_MS =
  30 * 24 * 60 * 60 * 1000;

function envFirst(names) {
  for (const n of names) {
    if (process.env[n]) {
      return process.env[n];
    }
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
  const {
    url,
    token,
  } = redisConfig();

  if (!url || !token) {
    throw new Error(
      "Redis environment variables not found"
    );
  }

  const r = await fetch(url, {
    method: "POST",

    headers: {
      Authorization:
        `Bearer ${token}`,

      "Content-Type":
        "application/json",
    },

    body:
      JSON.stringify(cmd),

    cache:
      "no-store",
  });

  const text =
    await r.text();

  if (!r.ok) {
    throw new Error(
      `Redis ${r.status}: ` +
      text.slice(0, 200)
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function getPlan() {
  const r = await fetch(
    `${BASE}/api/plan`,
    {
      cache: "no-store",
    }
  );

  const text =
    await r.text();

  if (!r.ok) {
    throw new Error(
      `/api/plan ${r.status}: ` +
      text.slice(0, 200)
    );
  }

  return JSON.parse(text);
}

function compactDecision(d) {
  const firstPlan =
    Array.isArray(d?.plans) &&
    d.plans.length
      ? d.plans[0]
      : null;

  return {
    t:
      Number(
        d?.sourceGeneratedAt ??
        d?.generatedAt ??
        Date.now()
      ),

    decision:
      d?.decision ??
      "NO TRADE",

    tradeAllowed:
      d?.tradeAllowed === true,

    reason:
      d?.reason ??
      null,

    coin:
      firstPlan?.coin ??
      d?.summary?.bestCoin ??
      null,

    side:
      firstPlan?.side ??
      d?.summary?.bestBias ??
      null,

    confidence:
      firstPlan
        ?.confidencePct ??
      d?.summary
        ?.bestConfidencePct ??
      null,

    score:
      firstPlan
        ?.compositeScore ??
      d?.summary
        ?.bestScore ??
      null,

    marginUsd:
      firstPlan
        ?.marginUsd ??
      null,

    leverage:
      firstPlan
        ?.leverage ??
      null,

    entry:
      firstPlan
        ?.entry
        ?.ideal ??
      null,

    aggressiveLimit:
      firstPlan
        ?.entry
        ?.aggressiveLimit ??
      null,

    stop:
      firstPlan
        ?.stopLoss
        ?.price ??
      null,

    tp1:
      firstPlan
        ?.takeProfit
        ?.tp1
        ?.price ??
      null,

    tp2:
      firstPlan
        ?.takeProfit
        ?.tp2
        ?.price ??
      null,

    riskUsd:
      firstPlan
        ?.stopLoss
        ?.riskUsd ??
      null,

    persistentSignals:
      d?.summary
        ?.persistentSignals ??
      [],

    system:
      d?.system ??
      null,
  };
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
   const plan =
  await getPlan();

const rank =
  plan?.rankSnapshot ??
  plan?.rank ??
  null;

const persistence =
  rank?.persistence ??
  null;

const decision = {
  generatedAt:
    Date.now(),

  sourceGeneratedAt:
    plan?.generatedAt ??
    rank?.generatedAt ??
    null,

  decision:
    plan?.tradeAllowed === true
      ? (
          Array.isArray(plan?.plans) &&
          plan.plans.length === 1
            ? `${plan.plans[0].side} ${plan.plans[0].coin}`
            : `${plan.plans?.length ?? 0} TRADES`
        )
      : "NO TRADE",

  tradeAllowed:
    plan?.tradeAllowed === true,

  reason:
    plan?.tradeAllowed === true
      ? null
      : plan?.reason ??
        "no_actionable_signal",

  summary: {
    bestCoin:
      rank?.bestActionable?.coin ??
      rank?.best?.coin ??
      null,

    bestBias:
      rank?.bestActionable?.bias ??
      rank?.best?.bias ??
      null,

    bestConfidencePct:
      rank?.bestActionable?.confidence ??
      rank?.best?.confidence ??
      null,

    bestScore:
      rank?.bestActionable?.compositeScore ??
      rank?.best?.compositeScore ??
      null,

    persistentSignals:
      persistence?.persistentSignals ??
      [],
  },

  plans:
    Array.isArray(plan?.plans)
      ? plan.plans
      : [],

  system: {
    planOk:
      plan?.ok === true,

    rankEmbedded:
      rank != null,

    persistenceEmbedded:
      persistence != null,
  },
};

const record =
  compactDecision(
    decision
  ); 

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

    return res
      .status(200)
      .json({
        ok: true,

        saved:
          record,
      });
  } catch (e) {
    return res
      .status(500)
      .json({
        ok: false,

        error:
          String(e),

        generatedAt:
          Date.now(),
      });
  }
}

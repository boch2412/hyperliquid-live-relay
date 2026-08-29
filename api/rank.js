const BASE = "https://hyperliquid-live-relay.vercel.app";

const COINS = [
  "BTC",
  "SUI",
  "xyz:MU",
  "xyz:SNDK",
  "xyz:SKHX",
];

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function abs(v) {
  const x = n(v);
  return x == null ? null : Math.abs(x);
}

async function getIntel(coin) {
  const r = await fetch(
    `${BASE}/api/intel?coin=${encodeURIComponent(coin)}`,
    { cache: "no-store" }
  );

  const text = await r.text();

  if (!r.ok) {
    throw new Error(
      `${coin} ${r.status}: ${text.slice(0, 150)}`
    );
  }

  return JSON.parse(text);
}

function estimateVolatility(intel) {
  const vals = [
    abs(intel?.live?.momentum?.m5?.returnPct),
    abs(intel?.live?.momentum?.m15?.returnPct),
    abs(intel?.live?.momentum?.m60?.returnPct),

    abs(intel?.history?.windows?.m5?.pricePct),
    abs(intel?.history?.windows?.m15?.pricePct),
    abs(intel?.history?.windows?.m60?.pricePct),
  ].filter((x) => x != null);

  if (!vals.length) {
    return {
      observedPct: 0.3,
      baselinePct: 0.3,
      sourceCount: 0,
    };
  }

  vals.sort((a, b) => a - b);

  const mid = Math.floor(vals.length / 2);

  const median =
    vals.length % 2
      ? vals[mid]
      : (vals[mid - 1] + vals[mid]) / 2;

  const baselinePct = clamp(
    median * 1.5,
    0.08,
    1.5
  );

  return {
    observedPct: median,
    baselinePct,
    sourceCount: vals.length,
  };
}

function momentumScore(momentum, volBaseline) {
  const weights = {
    m5: 1,
    m15: 2,
    m60: 3,
  };

  let score = 0;
  let weight = 0;

  const returns = {};

  for (const k of ["m5", "m15", "m60"]) {
    const r = n(momentum?.[k]?.returnPct);

    returns[k] = r;

    if (r == null) continue;

    const scaled = clamp(
      r / volBaseline,
      -1.75,
      1.75
    );

    score += scaled * weights[k];
    weight += weights[k];
  }

  return {
    score: weight ? score / weight : 0,
    returns,
  };
}

function historyDirectionalScore(history, volBaseline) {
  const weights = {
    m5: 1,
    m15: 2,
    m60: 3,
  };

  let total = 0;
  let weight = 0;

  for (const k of ["m5", "m15", "m60"]) {
    const w = history?.windows?.[k];

    if (!w?.ready) continue;

    const price = n(w.pricePct);
    const oi = n(w.oiPct);
    const funding = n(w.fundingDelta);

    if (price == null) continue;

    let s = clamp(
      price / volBaseline,
      -1.5,
      1.5
    );

    if (oi != null) {
      const oiMagnitude =
        Math.abs(oi);

      if (oiMagnitude >= 0.05) {
        if (price > 0 && oi > 0) {
          s += 0.5;
        }

        if (price < 0 && oi > 0) {
          s -= 0.5;
        }

        if (price > 0 && oi < 0) {
          s += 0.2;
        }

        if (price < 0 && oi < 0) {
          s -= 0.2;
        }
      }
    }

    if (funding != null) {
      if (funding > 0.00002) {
        s -= 0.15;
      }

      if (funding < -0.00002) {
        s += 0.15;
      }
    }

    total +=
      clamp(s, -2, 2) *
      weights[k];

    weight += weights[k];
  }

  return weight
    ? total / weight
    : 0;
}

function bookScore(book) {
  const top5 =
    n(book?.top5?.imbalance) ?? 0;

  const top20 =
    n(book?.top20?.imbalance) ?? 0;

  return clamp(
    top5 * 1.25 +
      top20 * 0.75,
    -1,
    1
  );
}

function fundingScore(funding) {
  const f = n(funding);

  if (f == null) return 0;

  if (f >= 0.00015) return -0.75;
  if (f >= 0.00008) return -0.35;

  if (f <= -0.00015) return 0.75;
  if (f <= -0.00008) return 0.35;

  return 0;
}

function qualityScore(intel) {
  let q = 1;

  const age =
    n(intel?.quality?.historyAgeMs);

  if (
    intel?.quality?.liveFresh !== true
  ) {
    q -= 0.4;
  }

  if (
    intel?.quality?.historyAvailable !== true
  ) {
    q -= 0.3;
  }

  if (
    intel?.quality?.full60mReady !== true
  ) {
    q -= 0.15;
  }

  if (
    age != null &&
    age > 7 * 60 * 1000
  ) {
    q -= 0.2;
  }

  return clamp(q, 0, 1);
}

function agreementScore(intel) {
  const signs = [];

  const add = (v) => {
    const x = n(v);

    if (
      x == null ||
      Math.abs(x) < 0.03
    ) {
      return;
    }

    signs.push(Math.sign(x));
  };

  add(
    intel?.live?.momentum?.m5?.returnPct
  );

  add(
    intel?.live?.momentum?.m15?.returnPct
  );

  add(
    intel?.live?.momentum?.m60?.returnPct
  );

  add(
    intel?.history?.windows?.m5?.pricePct
  );

  add(
    intel?.history?.windows?.m15?.pricePct
  );

  add(
    intel?.history?.windows?.m60?.pricePct
  );

  if (signs.length < 2) {
    return 0.5;
  }

  const sum =
    Math.abs(
      signs.reduce(
        (a, b) => a + b,
        0
      )
    );

  return sum / signs.length;
}

function structureConflict(
  history,
  momentum,
  book
) {
  const h = Math.sign(history);
  const m = Math.sign(momentum);
  const b = Math.sign(book);

  let conflicts = 0;

  if (
    Math.abs(history) > 0.25 &&
    Math.abs(momentum) > 0.25 &&
    h !== m
  ) {
    conflicts++;
  }

  if (
    Math.abs(momentum) > 0.35 &&
    Math.abs(book) > 0.6 &&
    m !== b
  ) {
    conflicts++;
  }

  if (
    Math.abs(history) > 0.35 &&
    Math.abs(book) > 0.7 &&
    h !== b
  ) {
    conflicts++;
  }

  return conflicts;
}

function evaluate(intel) {
  const vol =
    estimateVolatility(intel);

  const momentum =
    momentumScore(
      intel?.live?.momentum,
      vol.baselinePct
    );

  const history =
    historyDirectionalScore(
      intel?.history,
      vol.baselinePct
    );

  const book =
    bookScore(
      intel?.live?.orderBook
    );

  const funding =
    fundingScore(
      intel?.live?.context?.funding
    );

  const spread =
    n(
      intel?.live?.price?.spreadBps
    ) ?? 999;

  const quality =
    qualityScore(intel);

  const agreement =
    agreementScore(intel);

  const conflicts =
    structureConflict(
      history,
      momentum.score,
      book
    );

  let composite =
    history * 0.40 +
    momentum.score * 0.35 +
    book * 0.15 +
    funding * 0.10;

  if (conflicts === 1) {
    composite *= 0.8;
  }

  if (conflicts >= 2) {
    composite *= 0.55;
  }

  if (spread > 5) {
    composite *= 0.7;
  }

  if (spread > 10) {
    composite *= 0.5;
  }

  const moveStrength =
    clamp(
      Math.abs(composite) / 1.25,
      0,
      1
    );

  let confidence =
    quality *
    (0.60 + agreement * 0.25) *
    (0.70 + moveStrength * 0.30) *
    100;

  if (conflicts === 1) {
    confidence *= 0.9;
  }

  if (conflicts >= 2) {
    confidence *= 0.7;
  }

  confidence =
    clamp(
      confidence,
      0,
      100
    );

  const dynamicThreshold =
    clamp(
      0.68 +
        (1 - quality) * 0.25 +
        conflicts * 0.10,
      0.68,
      1.15
    );

  let bias = "NEUTRAL";

  if (
    composite >=
      dynamicThreshold &&
    confidence >= 60
  ) {
    bias = "LONG";
  } else if (
    composite <=
      -dynamicThreshold &&
    confidence >= 60
  ) {
    bias = "SHORT";
  }

  const reasons = [];

  if (quality < 0.7) {
    reasons.push(
      "data_quality_low"
    );
  }

  if (agreement < 0.5) {
    reasons.push(
      "timeframes_conflict"
    );
  }

  if (conflicts >= 1) {
    reasons.push(
      "signal_structure_conflict"
    );
  }

  if (spread > 5) {
    reasons.push(
      "spread_wide"
    );
  }

  if (
    intel?.quality
      ?.full60mReady !== true
  ) {
    reasons.push(
      "60m_history_not_ready"
    );
  }

  if (
    bias === "NEUTRAL" &&
    Math.abs(composite) <
      dynamicThreshold
  ) {
    reasons.push(
      "edge_too_small"
    );
  }

  if (
    confidence < 60
  ) {
    reasons.push(
      "confidence_too_low"
    );
  }

  const opportunity =
    Math.abs(composite) *
    (confidence / 100) *
    quality;

  return {
    coin: intel.coin,
    bias,

    compositeScore:
      composite,

    confidence,
    opportunity,

    threshold:
      dynamicThreshold,

    volatility: vol,

    components: {
      history,
      momentum:
        momentum.score,
      book,
      funding,
      agreement,
      quality,
      spreadBps:
        spread,
      conflicts,
    },

    reasons,
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
    const results =
      await Promise.allSettled(
        COINS.map(
          getIntel
        )
      );

    const evaluated = [];
    const errors = [];

    results.forEach(
      (result, i) => {
        if (
          result.status ===
          "fulfilled"
        ) {
          evaluated.push(
            evaluate(
              result.value
            )
          );
        } else {
          errors.push({
            coin: COINS[i],
            error: String(
              result.reason
            ),
          });
        }
      }
    );

    evaluated.sort(
      (a, b) =>
        b.opportunity -
        a.opportunity
    );

    const actionable =
      evaluated.filter(
        (x) =>
          x.bias === "LONG" ||
          x.bias === "SHORT"
      );

    return res
      .status(200)
      .json({
        ok: true,
        generatedAt:
          Date.now(),

        best:
          evaluated.length
            ? evaluated[0]
            : null,

        bestActionable:
          actionable.length
            ? actionable[0]
            : null,

        tradeAllowed:
          actionable.length > 0,

        ranking:
          evaluated.map(
            (x, index) => ({
              rank:
                index + 1,
              ...x,
            })
          ),

        errors,
      });
  } catch (e) {
    return res
      .status(500)
      .json({
        ok: false,
        error: String(e),
      });
  }
}

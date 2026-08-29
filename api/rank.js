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

function momentumScore(momentum) {
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

    const scaled = clamp(r / 0.3, -1.5, 1.5);

    score += scaled * weights[k];
    weight += weights[k];
  }

  return {
    score: weight ? score / weight : 0,
    returns,
  };
}

function bookScore(book) {
  const top5 = n(book?.top5?.imbalance) ?? 0;
  const top20 = n(book?.top20?.imbalance) ?? 0;

  return clamp(
    top5 * 1.5 + top20,
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

  const age = n(
    intel?.quality?.historyAgeMs
  );

  if (intel?.quality?.liveFresh !== true) {
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

  if (age != null && age > 7 * 60 * 1000) {
    q -= 0.2;
  }

  return clamp(q, 0, 1);
}

function agreementScore(intel) {
  const signs = [];

  const add = (v) => {
    const x = n(v);

    if (x == null || Math.abs(x) < 0.03) {
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

  if (signs.length < 2) return 0.5;

  const sum = Math.abs(
    signs.reduce((a, b) => a + b, 0)
  );

  return sum / signs.length;
}

function evaluate(intel) {
  const history =
    n(intel?.analysis?.score) ?? 0;

  const momentum = momentumScore(
    intel?.live?.momentum
  );

  const book = bookScore(
    intel?.live?.orderBook
  );

  const funding = fundingScore(
    intel?.live?.context?.funding
  );

  const spread =
    n(intel?.live?.price?.spreadBps) ?? 999;

  const quality = qualityScore(intel);
  const agreement = agreementScore(intel);

  let composite =
    history * 0.45 +
    momentum.score * 0.30 +
    book * 0.15 +
    funding * 0.10;

  if (spread > 5) {
    composite *= 0.7;
  }

  if (spread > 10) {
    composite *= 0.5;
  }

  const confidence =
    clamp(
      quality *
        (0.65 + agreement * 0.35) *
        100,
      0,
      100
    );

  let bias = "NEUTRAL";

  if (
    composite >= 0.8 &&
    confidence >= 55
  ) {
    bias = "LONG";
  } else if (
    composite <= -0.8 &&
    confidence >= 55
  ) {
    bias = "SHORT";
  }

  const reasons = [];

  if (quality < 0.7) {
    reasons.push("data_quality_low");
  }

  if (agreement < 0.5) {
    reasons.push("timeframes_conflict");
  }

  if (spread > 5) {
    reasons.push("spread_wide");
  }

  if (
    intel?.quality?.full60mReady !== true
  ) {
    reasons.push("60m_history_not_ready");
  }

  if (
    bias === "NEUTRAL" &&
    Math.abs(composite) < 0.8
  ) {
    reasons.push("edge_too_small");
  }

  const opportunity =
    Math.abs(composite) *
    (confidence / 100);

  return {
    coin: intel.coin,
    bias,

    compositeScore: composite,
    confidence,
    opportunity,

    components: {
      history,
      momentum: momentum.score,
      book,
      funding,
      agreement,
      quality,
      spreadBps: spread,
    },

    reasons,
  };
}

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  try {
    const results =
      await Promise.allSettled(
        COINS.map(getIntel)
      );

    const evaluated = [];
    const errors = [];

    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        evaluated.push(
          evaluate(result.value)
        );
      } else {
        errors.push({
          coin: COINS[i],
          error: String(result.reason),
        });
      }
    });

    evaluated.sort(
      (a, b) =>
        b.opportunity - a.opportunity
    );

    return res.status(200).json({
      ok: true,
      generatedAt: Date.now(),

      best:
        evaluated.length
          ? evaluated[0]
          : null,

      ranking: evaluated.map(
        (x, index) => ({
          rank: index + 1,
          ...x,
        })
      ),

      errors,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e),
    });
  }
}

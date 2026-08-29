// Vercel auto-deploy enabled
const BASE = "https://hyperliquid-live-relay.vercel.app";

function normalizeCoin(v) {
  return String(v || "").trim();
}

function scoreWindow(w) {
  if (!w?.ready) {
    return {
      ready: false,
      score: 0,
      bias: "WAIT",
      reasons: ["insufficient_history"],
    };
  }

  const price = Number(w.pricePct);
  const oi = Number(w.oiPct);
  const funding = Number(w.fundingDelta);

  let score = 0;
  const reasons = [];

  if (Number.isFinite(price)) {
    if (price > 0.15) {
      score += 1;
      reasons.push("price_up");
    } else if (price < -0.15) {
      score -= 1;
      reasons.push("price_down");
    }
  }

  if (Number.isFinite(oi)) {
    if (oi > 0.25) {
      reasons.push("oi_up");

      if (price > 0) {
        score += 2;
        reasons.push("new_long_build");
      } else if (price < 0) {
        score -= 2;
        reasons.push("new_short_build");
      }
    } else if (oi < -0.25) {
      reasons.push("oi_down");

      if (price > 0) {
        score += 1;
        reasons.push("short_covering");
      } else if (price < 0) {
        score -= 1;
        reasons.push("long_unwind");
      }
    }
  }

  if (Number.isFinite(funding)) {
    if (funding > 0.00002) {
      score -= 0.5;
      reasons.push("funding_more_positive");
    } else if (funding < -0.00002) {
      score += 0.5;
      reasons.push("funding_more_negative");
    }
  }

  let bias = "NEUTRAL";

  if (score >= 2) bias = "LONG";
  else if (score <= -2) bias = "SHORT";

  return {
    ready: true,
    score,
    bias,
    reasons,
  };
}

function overall(history, live) {
  const weights = {
    m5: 1,
    m15: 2,
    m60: 3,
  };

  let total = 0;
  let weight = 0;
  const windows = {};

  for (const name of ["m5", "m15", "m60"]) {
    const scored = scoreWindow(
      history?.windows?.[name]
    );

    windows[name] = scored;

    if (scored.ready) {
      total += scored.score * weights[name];
      weight += weights[name];
    }
  }

  const normalized =
    weight > 0 ? total / weight : 0;

  const imbalance =
    Number(
      live?.orderBook?.top5?.imbalance
    );

  let microAdjustment = 0;

  if (Number.isFinite(imbalance)) {
    if (imbalance >= 0.2) {
      microAdjustment = 0.5;
    } else if (imbalance <= -0.2) {
      microAdjustment = -0.5;
    }
  }

  const finalScore =
    normalized + microAdjustment;

  let bias = "WAIT";

  if (weight > 0) {
    if (finalScore >= 1.5) {
      bias = "LONG";
    } else if (finalScore <= -1.5) {
      bias = "SHORT";
    } else {
      bias = "NEUTRAL";
    }
  }

  return {
    bias,
    score: finalScore,
    historyScore: normalized,
    microAdjustment,
    windows,
  };
}

async function getJSON(path) {
  const r = await fetch(`${BASE}${path}`, {
    cache: "no-store",
  });

  const text = await r.text();

  let data = null;

  try {
    data = JSON.parse(text);
  } catch {}

  if (!r.ok) {
    throw new Error(
      `${path} ${r.status}: ${text.slice(0, 200)}`
    );
  }

  return data;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const receivedAt = Date.now();

  try {
    const coin = normalizeCoin(req.query.coin);

    if (!coin) {
      return res.status(400).json({
        ok: false,
        error: "coin is required",
      });
    }

    const encoded = encodeURIComponent(coin);

    const [live, history] =
      await Promise.all([
        getJSON(`/api/signal?coin=${encoded}`),
        getJSON(`/api/history?coin=${encoded}`),
      ]);

    const analysis = overall(
      history,
      live
    );

    const latestAgeMs =
      history?.latest?.t
        ? Math.max(
            0,
            receivedAt -
              Number(history.latest.t)
          )
        : null;

    return res.status(200).json({
      ok: true,
      coin,

      live: {
        valid:
          live?.ok === true &&
          live?.live === true,

        market: live?.market ?? null,
        price: live?.price ?? null,
        context: live?.context ?? null,
        orderBook:
          live?.orderBook ?? null,
        momentum:
          live?.momentum ?? null,
        timing: live?.timing ?? null,
      },

      history: {
        ready:
          history?.ready === true,

        latest:
          history?.latest ?? null,

        latestAgeMs,

        windows:
          history?.windows ?? null,
      },

      analysis,

      quality: {
        liveFresh:
          live?.live === true,

        historyAvailable:
          history?.ready === true,

        historyAgeMs:
          latestAgeMs,

        full60mReady:
          history?.windows?.m60
            ?.ready === true,
      },

      receivedAt,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e),
      receivedAt,
    });
  }
}

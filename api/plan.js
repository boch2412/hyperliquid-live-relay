const BASE =
  "https://hyperliquid-live-relay.vercel.app";

const MAX_TOTAL_MARGIN = 5000;
const MAX_LEVERAGE = 10;

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function clamp(v, min, max) {
  return Math.max(
    min,
    Math.min(max, v)
  );
}

async function getJSON(path) {
  const r = await fetch(
    `${BASE}${path}`,
    {
      cache: "no-store",
    }
  );

  const text =
    await r.text();

  if (!r.ok) {
    throw new Error(
      `${path} ${r.status}: ` +
      text.slice(0, 200)
    );
  }

  return JSON.parse(text);
}

async function getIntel(coin) {
  return getJSON(
    `/api/intel?coin=` +
    encodeURIComponent(coin)
  );
}

function leverageFor(x) {
  const confidence =
    n(x?.confidence) ?? 0;

  const observedVol =
    n(
      x?.volatility
        ?.observedPct
    ) ?? 0.3;

  let lev = 3;

  if (confidence >= 80) {
    lev = 7;
  } else if (
    confidence >= 72
  ) {
    lev = 6;
  } else if (
    confidence >= 65
  ) {
    lev = 5;
  } else if (
    confidence >= 60
  ) {
    lev = 4;
  }

  if (observedVol >= 0.5) {
    lev -= 2;
  } else if (
    observedVol >= 0.3
  ) {
    lev -= 1;
  }

  return clamp(
    lev,
    2,
    MAX_LEVERAGE
  );
}

function allocateMargin(
  actionable
) {
  if (!actionable.length) {
    return [];
  }

  if (actionable.length === 1) {
    return [
      {
        coin:
          actionable[0].coin,

        margin:
          MAX_TOTAL_MARGIN,
      },
    ];
  }

  const top =
    actionable.slice(0, 3);

  const rawWeights =
    top.map((x) => {
      const opp =
        n(x.opportunity) ?? 0;

      const conf =
        n(x.confidence) ?? 0;

      return Math.max(
        0.01,
        opp *
          (conf / 100)
      );
    });

  const total =
    rawWeights.reduce(
      (a, b) => a + b,
      0
    );

  let allocations =
    top.map(
      (x, i) => ({
        coin: x.coin,

        margin:
          MAX_TOTAL_MARGIN *
          (rawWeights[i] /
            total),
      })
    );

  /*
    最上位が明確に強い場合は
    集中配分を許可する。
  */
  if (
    top.length >= 2 &&
    rawWeights[0] >=
      rawWeights[1] * 1.6
  ) {
    allocations[0].margin =
      MAX_TOTAL_MARGIN *
      0.70;

    const rest =
      MAX_TOTAL_MARGIN *
      0.30;

    const restWeight =
      rawWeights
        .slice(1)
        .reduce(
          (a, b) => a + b,
          0
        );

    for (
      let i = 1;
      i <
      allocations.length;
      i++
    ) {
      allocations[i].margin =
        rest *
        (
          rawWeights[i] /
          restWeight
        );
    }
  }

  return allocations.map(
    (x) => ({
      ...x,

      margin:
        Math.round(
          x.margin
        ),
    })
  );
}

function makeLevels(
  ranked,
  intel,
  margin
) {
  const bias =
    ranked.bias;

  const mid =
    n(
      intel?.live
        ?.price?.mid
    );

  const bid =
    n(
      intel?.live
        ?.price?.bid
    );

  const ask =
    n(
      intel?.live
        ?.price?.ask
    );

  const spreadBps =
    n(
      intel?.live
        ?.price?.spreadBps
    ) ?? 0;

  if (
    mid == null ||
    bid == null ||
    ask == null
  ) {
    throw new Error(
      `${ranked.coin}: price unavailable`
    );
  }

  const volBase =
    clamp(
      n(
        ranked
          ?.volatility
          ?.baselinePct
      ) ?? 0.3,
      0.08,
      1.5
    );

  const confidence =
    n(
      ranked.confidence
    ) ?? 0;

  /*
    エントリーは追いかけず、
    現値から小さく引き付ける。
  */
  const pullbackPct =
    clamp(
      volBase * 0.20,
      0.015,
      0.20
    );

  /*
    SLは銘柄固有ボラ基準。
    最低0.15%は確保。
  */
  const stopPct =
    clamp(
      volBase * 1.35,
      0.15,
      2.0
    );

  /*
    TPはSLに対して
    約1.2R / 2.0R。
  */
  const tp1Pct =
    stopPct * 1.20;

  const tp2Pct =
    stopPct * 2.00;

  let entryIdeal;
  let entryLimit;
  let stop;
  let tp1;
  let tp2;

  if (bias === "LONG") {
    entryIdeal =
      mid *
      (
        1 -
        pullbackPct / 100
      );

    entryLimit =
      Math.min(
        ask,
        mid *
          (
            1 +
            Math.max(
              spreadBps / 10000,
              0.00003
            )
          )
      );

    stop =
      entryIdeal *
      (
        1 -
        stopPct / 100
      );

    tp1 =
      entryIdeal *
      (
        1 +
        tp1Pct / 100
      );

    tp2 =
      entryIdeal *
      (
        1 +
        tp2Pct / 100
      );
  } else {
    entryIdeal =
      mid *
      (
        1 +
        pullbackPct / 100
      );

    entryLimit =
      Math.max(
        bid,
        mid *
          (
            1 -
            Math.max(
              spreadBps / 10000,
              0.00003
            )
          )
      );

    stop =
      entryIdeal *
      (
        1 +
        stopPct / 100
      );

    tp1 =
      entryIdeal *
      (
        1 -
        tp1Pct / 100
      );

    tp2 =
      entryIdeal *
      (
        1 -
        tp2Pct / 100
      );
  }

  const leverage =
    leverageFor(ranked);

  const positionNotional =
    margin *
    leverage;

  const riskAtStop =
    positionNotional *
    (stopPct / 100);

  const rr1 =
    tp1Pct /
    stopPct;

  const rr2 =
    tp2Pct /
    stopPct;

  /*
    確信度が高くない時ほど
    TP1比率を増やす。
  */
  let tp1ClosePct = 50;

  if (confidence < 68) {
    tp1ClosePct = 65;
  } else if (
    confidence >= 78
  ) {
    tp1ClosePct = 40;
  }

  return {
    coin:
      ranked.coin,

    side:
      bias,

    confidence,
    compositeScore:
      ranked.compositeScore,

    margin,

    leverage,

    positionNotional:
      Math.round(
        positionNotional
      ),

    market: {
      bid,
      ask,
      mid,
      spreadBps,
    },

    entry: {
      ideal:
        entryIdeal,

      aggressiveLimit:
        entryLimit,

      pullbackPct,
    },

    risk: {
      stop,
      stopPct,

      riskAtStopUsd:
        riskAtStop,

      marginLossPct:
        stopPct *
        leverage,
    },

    targets: {
      tp1,
      tp1Pct,
      tp1ClosePct,

      tp2,
      tp2Pct,

      tp2ClosePct:
        100 -
        tp1ClosePct,

      rr1,
      rr2,
    },

    volatility:
      ranked.volatility,

    executionQuality:
      ranked.executionQuality,

    reasons:
      ranked.reasons ?? [],
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
    const rank =
      await getJSON(
        "/api/rank"
      );

    const actionable =
      Array.isArray(
        rank?.ranking
      )
        ? rank.ranking.filter(
            (x) =>
              x.bias ===
                "LONG" ||
              x.bias ===
                "SHORT"
          )
        : [];

    if (
      !rank?.tradeAllowed ||
      !actionable.length
    ) {
      return res
        .status(200)
        .json({
          ok: true,

          tradeAllowed:
            false,

          reason:
            "no_actionable_signal",

          generatedAt:
            Date.now(),

          rank,
        });
    }

    const allocations =
      allocateMargin(
        actionable
      );

    const plans = [];

    for (
      const allocation
      of allocations
    ) {
      const ranked =
        actionable.find(
          (x) =>
            x.coin ===
            allocation.coin
        );

      const intel =
        await getIntel(
          allocation.coin
        );

      plans.push(
        makeLevels(
          ranked,
          intel,
          allocation.margin
        )
      );
    }

    const totalMargin =
      plans.reduce(
        (sum, x) =>
          sum + x.margin,
        0
      );

    const totalNotional =
      plans.reduce(
        (sum, x) =>
          sum +
          x.positionNotional,
        0
      );

    const totalStopRisk =
      plans.reduce(
        (sum, x) =>
          sum +
          x.risk
            .riskAtStopUsd,
        0
      );

    return res
      .status(200)
      .json({
        ok: true,

        tradeAllowed:
          true,

        constraints: {
          maxTotalMargin:
            MAX_TOTAL_MARGIN,

          maxLeverage:
            MAX_LEVERAGE,
        },

        portfolio: {
          totalMargin,

          totalNotional,

          estimatedStopRiskUsd:
            totalStopRisk,

          estimatedStopRiskPctOfMargin:
            totalMargin
              ? (
                  totalStopRisk /
                  totalMargin
                ) * 100
              : null,
        },

        plans,

        generatedAt:
          Date.now(),
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

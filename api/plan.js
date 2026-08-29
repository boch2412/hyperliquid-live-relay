const BASE =
  "https://hyperliquid-live-relay.vercel.app";

const MAX_TOTAL_MARGIN = 5000;
const MAX_LEVERAGE = 10;

/*
  全ポジションが同時にSLになった場合の
  想定最大損失額。
  現在は証拠金上限の1%。
*/
const MAX_PORTFOLIO_STOP_RISK_USD =
  MAX_TOTAL_MARGIN * 0.01;

const MAX_POSITIONS = 3;

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

  /*
    ボラが大きい場合は
    レバレッジを落とす。
  */
  if (observedVol >= 0.6) {
    lev -= 2;
  } else if (
    observedVol >= 0.35
  ) {
    lev -= 1;
  }

  /*
    SL幅が広い場合も
    レバレッジを落とす。
  */
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

function structuralStop(
  ranked,
  intel
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

  const m5Range =
    rangePct(
      intel
        ?.live
        ?.momentum
        ?.m5
    );

  const m15Range =
    rangePct(
      intel
        ?.live
        ?.momentum
        ?.m15
    );

  const m60Range =
    rangePct(
      intel
        ?.live
        ?.momentum
        ?.m60
    );

  const spreadBps =
    n(
      intel
        ?.live
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

    /*
      SLがスプレッドの
      数倍程度しかない状態を防ぐ。
    */
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

  /*
    極端なイベント時の
    異常なSL幅を制限。
  */
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
  ranked,
  intel
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

  const m5Range =
    rangePct(
      intel
        ?.live
        ?.momentum
        ?.m5
    );

  const m15Range =
    rangePct(
      intel
        ?.live
        ?.momentum
        ?.m15
    );

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
      100 -
      tp1ClosePct,
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
          ) ?? 0;

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
  intel,
  riskBudgetUsd
) {
  const side =
    ranked.bias;

  const mid =
    n(
      intel
        ?.live
        ?.price
        ?.mid
    );

  const bid =
    n(
      intel
        ?.live
        ?.price
        ?.bid
    );

  const ask =
    n(
      intel
        ?.live
        ?.price
        ?.ask
    );

  if (
    mid == null ||
    bid == null ||
    ask == null
  ) {
    throw new Error(
      `${ranked.coin}: price unavailable`
    );
  }

  const structural =
    structuralStop(
      ranked,
      intel
    );

  const stopPct =
    structural.stopPct;

  const entryModel =
    entryParameters(
      ranked,
      intel
    );

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
        pullbackPct /
          100
      );

    entryAggressive =
      ask;
  } else {
    entryIdeal =
      mid *
      (
        1 +
        pullbackPct /
          100
      );

    entryAggressive =
      bid;
  }

  /*
    許容損失額から
    ポジション総額を逆算。
  */
  const desiredNotional =
    riskBudgetUsd /
    (stopPct / 100);

  const requiredMargin =
    desiredNotional /
    leverage;

  return {
    ranked,
    intel,

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
        raw.stopPct /
          100
      );

    tp1 =
      entry *
      (
        1 +
        raw.targets
          .tp1Pct /
          100
      );

    tp2 =
      entry *
      (
        1 +
        raw.targets
          .tp2Pct /
          100
      );
  } else {
    stop =
      entry *
      (
        1 +
        raw.stopPct /
          100
      );

    tp1 =
      entry *
      (
        1 -
        raw.targets
          .tp1Pct /
          100
      );

    tp2 =
      entry *
      (
        1 -
        raw.targets
          .tp2Pct /
          100
      );
  }

  const marginLossPct =
    raw.stopPct *
    raw.leverage;

  /*
    aggressiveLimitから
    idealEntryまでの距離が
    大き過ぎる場合は
    追いかけないための目安。
  */
  const chaseDistancePct =
    Math.abs(
      (
        raw.entryAggressive -
        raw.entryIdeal
      ) /
      raw.entryIdeal
    ) *
    100;

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
        raw.intel
          ?.live
          ?.price
          ?.bid,

      ask:
        raw.intel
          ?.live
          ?.price
          ?.ask,

      mid:
        raw.intel
          ?.live
          ?.price
          ?.mid,

      spreadBps:
        raw.intel
          ?.live
          ?.price
          ?.spreadBps,
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
        raw.targets
          .tp1Pct,

      tp1ClosePct:
        raw.targets
          .tp1ClosePct,

      tp2,

      tp2Pct:
        raw.targets
          .tp2Pct,

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
        ? rank.ranking
            .filter(
              (x) =>
                x.bias ===
                  "LONG" ||
                x.bias ===
                  "SHORT"
            )
            .slice(
              0,
              MAX_POSITIONS
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

    const weights =
      riskWeights(
        actionable
      );

    const rawPlans = [];

    for (
      let i = 0;
      i <
      actionable.length;
      i++
    ) {
      const ranked =
        actionable[i];

      const intel =
        await getIntel(
          ranked.coin
        );

      /*
        銘柄ごとの許容損失額。
      */
      const riskBudgetUsd =
        MAX_PORTFOLIO_STOP_RISK_USD *
        weights[i];

      rawPlans.push(
        makeRawPlan(
          ranked,
          intel,
          riskBudgetUsd
        )
      );
    }

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

    const totalMargin =
      plans.reduce(
        (sum, x) =>
          sum +
          x.margin,
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
            .allocatedRiskUsd,
        0
      );

    return res
      .status(200)
      .json({
  ok: true,

  tradeAllowed:
    true,

  rankSnapshot:
    rank,

  constraints: {
          
          maxTotalMargi
            MAX_TOTAL_MARGIN,

          maxLeverage:
            MAX_LEVERAGE,

          maxPortfolioStopRiskUsd:
            MAX_PORTFOLIO_STOP_RISK_USD,

          maxPositions:
            MAX_POSITIONS,
        },

        sizing: {
          riskFirst:
            true,

          marginScale:
            sizing.scale,

          requestedMarginBeforeScaling:
            sizing
              .totalRequiredMargin,
        },

        portfolio: {
          totalMargin,

          unusedMargin:
            Math.max(
              0,
              MAX_TOTAL_MARGIN -
              totalMargin
            ),

          totalNotional,

          estimatedStopRiskUsd:
            totalStopRisk,

          estimatedStopRiskPctOfMaxMargin:
            (
              totalStopRisk /
              MAX_TOTAL_MARGIN
            ) *
            100,
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

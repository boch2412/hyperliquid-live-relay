const BASE =
  "https://hyperliquid-live-relay.vercel.app";

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

function round(v, digits = 2) {
  const x = Number(v);

  if (!Number.isFinite(x)) {
    return null;
  }

  const p =
    10 ** digits;

  return (
    Math.round(
      x * p
    ) / p
  );
}

function simplifyPlan(plan) {
  return {
    coin:
      plan.coin,

    side:
      plan.side,

    confidencePct:
      round(
        plan.confidence,
        1
      ),

    compositeScore:
      round(
        plan.compositeScore,
        3
      ),

    marginUsd:
      round(
        plan.margin,
        0
      ),

    leverage:
      plan.leverage,

    positionNotionalUsd:
      round(
        plan.positionNotional,
        0
      ),

    market: {
      bid:
        plan.market?.bid,

      ask:
        plan.market?.ask,

      mid:
        plan.market?.mid,

      spreadBps:
        round(
          plan.market
            ?.spreadBps,
          2
        ),
    },

    entry: {
      ideal:
        plan.entry?.ideal,

      aggressiveLimit:
        plan.entry
          ?.aggressiveLimit,

      pullbackPct:
        round(
          plan.entry
            ?.pullbackPct,
          3
        ),

      chaseAllowed:
        plan.entry
          ?.chaseAllowed ===
        true,
    },

    stopLoss: {
      price:
        plan.risk?.stop,

      distancePct:
        round(
          plan.risk
            ?.stopPct,
          3
        ),

      riskUsd:
        round(
          plan.risk
            ?.allocatedRiskUsd,
          2
        ),

      marginLossPct:
        round(
          plan.risk
            ?.marginLossPct,
          2
        ),
    },

    takeProfit: {
      tp1: {
        price:
          plan.targets?.tp1,

        movePct:
          round(
            plan.targets
              ?.tp1Pct,
            3
          ),

        closePct:
          plan.targets
            ?.tp1ClosePct,

        rr:
          round(
            plan.targets
              ?.rr1,
            2
          ),
      },

      tp2: {
        price:
          plan.targets?.tp2,

        movePct:
          round(
            plan.targets
              ?.tp2Pct,
            3
          ),

        closePct:
          plan.targets
            ?.tp2ClosePct,

        rr:
          round(
            plan.targets
              ?.rr2,
            2
          ),
      },
    },
  };
}

function decisionText(
  tradeAllowed,
  plans
) {
  if (
    !tradeAllowed ||
    !plans.length
  ) {
    return "NO TRADE";
  }

  if (
    plans.length === 1
  ) {
    return (
      `${plans[0].side} ` +
      `${plans[0].coin}`
    );
  }

  return (
    `${plans.length} TRADES`
  );
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
    const [
      rank,
      plan,
      persistence,
    ] =
      await Promise.all([
        getJSON(
          "/api/rank"
        ),

        getJSON(
          "/api/plan"
        ),

        getJSON(
          "/api/persistence"
        ),
      ]);

    const tradeAllowed =
      rank?.tradeAllowed ===
        true &&
      plan?.tradeAllowed ===
        true;

    const rawPlans =
      Array.isArray(
        plan?.plans
      )
        ? plan.plans
        : [];

    const plans =
      rawPlans.map(
        simplifyPlan
      );

    const best =
      rank
        ?.bestActionable ??
      null;

    const persistent =
      Array.isArray(
        persistence
          ?.persistentSignals
      )
        ? persistence
            .persistentSignals
        : [];

    const now =
      Date.now();

    return res
      .status(200)
      .json({
        ok: true,

        generatedAt:
          now,

        decision:
          decisionText(
            tradeAllowed,
            plans
          ),

        tradeAllowed,

        summary: {
          actionableCount:
            plans.length,

          bestCoin:
            best?.coin ??
            null,

          bestBias:
            best?.bias ??
            null,

          bestConfidencePct:
            round(
              best
                ?.confidence,
              1
            ),

          bestScore:
            round(
              best
                ?.compositeScore,
              3
            ),

          persistenceReady:
            persistence
              ?.persistenceReady ===
            true,

          persistentSignals:
            persistent,

          totalMarginUsd:
            round(
              plan
                ?.portfolio
                ?.totalMargin,
              0
            ),

          unusedMarginUsd:
            round(
              plan
                ?.portfolio
                ?.unusedMargin,
              0
            ),

          totalNotionalUsd:
            round(
              plan
                ?.portfolio
                ?.totalNotional,
              0
            ),

          maxStopRiskUsd:
            round(
              plan
                ?.portfolio
                ?.estimatedStopRiskUsd,
              2
            ),
        },

        plans,

        noTradeReasons:
          tradeAllowed
            ? []
            : [
                "rank_not_confirmed",
                "persistence_not_confirmed",
                "plan_not_actionable",
              ],

        system: {
          rankOk:
            rank?.ok === true,

          planOk:
            plan?.ok === true,

          persistenceOk:
            persistence
              ?.ok === true,
        },
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

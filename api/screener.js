const BASE =
  "https://hyperliquid-live-relay.vercel.app";

const DEFAULT_DEEP_LIMIT = 18;
const MAX_DEEP_LIMIT = 24;
const DEEP_CONCURRENCY = 6;

function n(v) {
  const x = Number(v);
  return Number.isFinite(x)
    ? x
    : null;
}

function clamp(v, min, max) {
  return Math.max(
    min,
    Math.min(max, v)
  );
}

function abs(v) {
  const x = n(v);

  return x == null
    ? null
    : Math.abs(x);
}

async function fetchJson(url) {
  const r =
    await fetch(
      url,
      {
        cache:
          "no-store",
      }
    );

  const text =
    await r.text();

  if (!r.ok) {
    throw new Error(
      `${r.status}: ${text.slice(
        0,
        180
      )}`
    );
  }

  return JSON.parse(text);
}

async function mapLimit(
  items,
  limit,
  fn
) {
  const out =
    new Array(
      items.length
    );

  let cursor = 0;

  async function worker() {
    while (true) {
      const i =
        cursor++;

      if (
        i >=
        items.length
      ) {
        return;
      }

      out[i] =
        await fn(
          items[i],
          i
        );
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            limit,
            items.length
          ),
      },
      worker
    )
  );

  return out;
}

function stage1Score(row) {
  const liquidity =
    n(
      row
        ?.liquidityScore
    ) ?? 0;

  const volume =
    Math.max(
      0,
      n(
        row
          ?.dayNtlVlm
      ) ?? 0
    );

  const oiNotional =
    Math.max(
      0,
      n(
        row
          ?.oiNotional
      ) ?? 0
    );

  const funding =
    abs(
      row?.funding
    ) ?? 0;

  const volumeScore =
    clamp(
      Math.log10(
        1 + volume
      ) / 9,
      0,
      1
    );

  const oiScore =
    clamp(
      Math.log10(
        1 +
          oiNotional
      ) / 10,
      0,
      1
    );

  const liquidityNorm =
    clamp(
      liquidity / 10,
      0,
      1
    );

  const turnover =
    oiNotional > 0
      ? volume /
        oiNotional
      : 0;

  const activityScore =
    clamp(
      Math.log10(
        1 +
          turnover * 10
      ) / 1.5,
      0,
      1
    );

  const fundingInterest =
    clamp(
      funding /
        0.00015,
      0,
      1
    );

  return (
    liquidityNorm *
      0.42 +
    volumeScore *
      0.22 +
    oiScore *
      0.16 +
    activityScore *
      0.15 +
    fundingInterest *
      0.05
  );
}

function estimateBaseline(
  intel
) {
  const vals = [
    abs(
      intel
        ?.live
        ?.momentum
        ?.m5
        ?.returnPct
    ),

    abs(
      intel
        ?.live
        ?.momentum
        ?.m15
        ?.returnPct
    ),

    abs(
      intel
        ?.live
        ?.momentum
        ?.m60
        ?.returnPct
    ),

    abs(
      intel
        ?.history
        ?.windows
        ?.m5
        ?.pricePct
    ),

    abs(
      intel
        ?.history
        ?.windows
        ?.m15
        ?.pricePct
    ),

    abs(
      intel
        ?.history
        ?.windows
        ?.m60
        ?.pricePct
    ),
  ].filter(
    (x) =>
      x != null
  );

  if (!vals.length) {
    return 0.3;
  }

  vals.sort(
    (a, b) =>
      a - b
  );

  const m =
    Math.floor(
      vals.length / 2
    );

  const median =
    vals.length % 2
      ? vals[m]
      : (
          vals[m - 1] +
          vals[m]
        ) / 2;

  return clamp(
    median * 1.5,
    0.08,
    1.5
  );
}

function directionalMomentum(
  intel,
  baseline
) {
  const weights = {
    m5: 1,
    m15: 2,
    m60: 3,
  };

  let total = 0;
  let weight = 0;

  for (
    const k of [
      "m5",
      "m15",
      "m60",
    ]
  ) {
    const r =
      n(
        intel
          ?.live
          ?.momentum
          ?.[k]
          ?.returnPct
      );

    if (r == null) {
      continue;
    }

    total +=
      clamp(
        r / baseline,
        -2,
        2
      ) *
      weights[k];

    weight +=
      weights[k];
  }

  return weight
    ? total / weight
    : 0;
}

function directionalHistory(
  intel,
  baseline
) {
  const weights = {
    m5: 1,
    m15: 2,
    m60: 3,
  };

  let total = 0;
  let weight = 0;

  for (
    const k of [
      "m5",
      "m15",
      "m60",
    ]
  ) {
    const w =
      intel
        ?.history
        ?.windows
        ?.[k];

    if (!w?.ready) {
      continue;
    }

    const price =
      n(w?.pricePct);

    const oi =
      n(w?.oiPct);

    if (price == null) {
      continue;
    }

    let s =
      clamp(
        price /
          baseline,
        -1.75,
        1.75
      );

    if (
      oi != null &&
      Math.abs(oi) >=
        0.05
    ) {
      if (
        price > 0 &&
        oi > 0
      ) {
        s += 0.45;
      }

      if (
        price < 0 &&
        oi > 0
      ) {
        s -= 0.45;
      }

      if (
        price > 0 &&
        oi < 0
      ) {
        s += 0.15;
      }

      if (
        price < 0 &&
        oi < 0
      ) {
        s -= 0.15;
      }
    }

    total +=
      clamp(
        s,
        -2,
        2
      ) *
      weights[k];

    weight +=
      weights[k];
  }

  return weight
    ? total / weight
    : 0;
}

function bookScore(
  intel
) {
  const b5 =
    n(
      intel
        ?.live
        ?.orderBook
        ?.top5
        ?.imbalance
    ) ?? 0;

  const b20 =
    n(
      intel
        ?.live
        ?.orderBook
        ?.top20
        ?.imbalance
    ) ?? 0;

  return clamp(
    b5 * 1.2 +
      b20 * 0.8,
    -1,
    1
  );
}

function fundingScore(
  intel
) {
  const f =
    n(
      intel
        ?.live
        ?.context
        ?.funding
    );

  if (f == null) {
    return 0;
  }

  if (
    f >=
    0.00015
  ) {
    return -0.65;
  }

  if (
    f >=
    0.00008
  ) {
    return -0.3;
  }

  if (
    f <=
    -0.00015
  ) {
    return 0.65;
  }

  if (
    f <=
    -0.00008
  ) {
    return 0.3;
  }

  return 0;
}

function agreement(
  intel
) {
  const signs = [];

  const add = (v) => {
    const x = n(v);

    if (
      x == null ||
      Math.abs(x) <
        0.03
    ) {
      return;
    }

    signs.push(
      Math.sign(x)
    );
  };

  for (
    const k of [
      "m5",
      "m15",
      "m60",
    ]
  ) {
    add(
      intel
        ?.live
        ?.momentum
        ?.[k]
        ?.returnPct
    );

    add(
      intel
        ?.history
        ?.windows
        ?.[k]
        ?.pricePct
    );
  }

  if (
    signs.length < 2
  ) {
    return 0.5;
  }

  return (
    Math.abs(
      signs.reduce(
        (a, b) =>
          a + b,
        0
      )
    ) /
    signs.length
  );
}

function execution(
  intel
) {
  const spread =
    n(
      intel
        ?.live
        ?.price
        ?.spreadBps
    ) ?? 999;

  const mid =
    n(
      intel
        ?.live
        ?.price
        ?.mid
    );

  const oi =
    n(
      intel
        ?.live
        ?.context
        ?.openInterest
    );

  const vol24 =
    n(
      intel
        ?.live
        ?.context
        ?.dayNtlVlm
    );

  const bid20 =
    n(
      intel
        ?.live
        ?.orderBook
        ?.top20
        ?.bidSize
    ) ?? 0;

  const ask20 =
    n(
      intel
        ?.live
        ?.orderBook
        ?.top20
        ?.askSize
    ) ?? 0;

  const oiNotional =
    mid != null &&
    oi != null
      ? mid * oi
      : null;

  const bookNotional =
    mid != null
      ? mid *
        (
          bid20 +
          ask20
        )
      : null;

  let score = 1;
  const reasons = [];

  if (spread > 2) {
    score -= 0.1;

    reasons.push(
      "spread_elevated"
    );
  }

  if (spread > 4) {
    score -= 0.15;

    reasons.push(
      "spread_wide"
    );
  }

  if (spread > 8) {
    score -= 0.2;

    reasons.push(
      "spread_very_wide"
    );
  }

  if (
    vol24 == null ||
    vol24 <
      2_000_000
  ) {
    score -= 0.25;

    reasons.push(
      "volume_low"
    );
  } else if (
    vol24 <
    10_000_000
  ) {
    score -= 0.1;

    reasons.push(
      "volume_moderate"
    );
  }

  if (
    oiNotional == null ||
    oiNotional <
      2_000_000
  ) {
    score -= 0.2;

    reasons.push(
      "oi_low"
    );
  } else if (
    oiNotional <
    8_000_000
  ) {
    score -= 0.1;

    reasons.push(
      "oi_moderate"
    );
  }

  if (
    bookNotional == null ||
    bookNotional <
      75_000
  ) {
    score -= 0.2;

    reasons.push(
      "book_thin"
    );
  } else if (
    bookNotional <
    250_000
  ) {
    score -= 0.1;

    reasons.push(
      "book_moderate"
    );
  }

  return {
    score:
      clamp(
        score,
        0,
        1
      ),

    spreadBps:
      spread,

    vol24,

    oiNotional,

    bookNotional,

    reasons,
  };
}

function deepEvaluate(
  intel,
  stage1
) {
  const baseline =
    estimateBaseline(
      intel
    );

  const momentum =
    directionalMomentum(
      intel,
      baseline
    );

  const history =
    directionalHistory(
      intel,
      baseline
    );

  const book =
    bookScore(
      intel
    );

  const funding =
    fundingScore(
      intel
    );

  const agree =
    agreement(
      intel
    );

  const exec =
    execution(
      intel
    );

  const quality =
    clamp(
      (
        intel
          ?.quality
          ?.liveFresh ===
        true
          ? 0.35
          : 0
      ) +
        (
          intel
            ?.quality
            ?.historyAvailable ===
          true
            ? 0.25
            : 0
        ) +
        (
          intel
            ?.quality
            ?.full60mReady ===
          true
            ? 0.4
            : 0
        ),
      0,
      1
    );

  const directional =
    history * 0.36 +
    momentum * 0.36 +
    book * 0.18 +
    funding * 0.1;

  const direction =
    directional > 0.12
      ? "LONG"
      : directional < -0.12
        ? "SHORT"
        : "NEUTRAL";

  const signalStrength =
    clamp(
      Math.abs(
        directional
      ) / 1.35,
      0,
      1
    );

  const confidence =
    clamp(
      100 *
        quality *
        exec.score *
        (
          0.62 +
          agree * 0.38
        ) *
        (
          0.65 +
          signalStrength *
            0.35
        ),
      0,
      100
    );

  const volatility =
    clamp(
      baseline / 0.8,
      0,
      1
    );

  const deepScore =
    signalStrength *
      0.38 +
    (
      confidence / 100
    ) *
      0.26 +
    exec.score *
      0.18 +
    volatility *
      0.1 +
    stage1 *
      0.08;

  const actionable =
    direction !==
      "NEUTRAL" &&
    quality >= 0.75 &&
    exec.score >=
      0.7 &&
    confidence >= 55 &&
    deepScore >= 0.55;

  const reasons = [
    ...exec.reasons,
  ];

  if (
    intel
      ?.quality
      ?.full60mReady !==
    true
  ) {
    reasons.push(
      "60m_not_ready"
    );
  }

  if (agree < 0.5) {
    reasons.push(
      "timeframe_conflict"
    );
  }

  if (
    confidence < 55
  ) {
    reasons.push(
      "confidence_low"
    );
  }

  if (
    direction ===
    "NEUTRAL"
  ) {
    reasons.push(
      "direction_unclear"
    );
  }

  return {
    coin:
      intel?.coin,

    direction,

    actionable,

    deepScore,

    confidence,

    stage1Score:
      stage1,

    components: {
      history,

      momentum,

      book,

      funding,

      agreement:
        agree,

      quality,

      execution:
        exec.score,

      volatility,
    },

    market: {
      bid:
        intel
          ?.live
          ?.price
          ?.bid ??
        null,

      ask:
        intel
          ?.live
          ?.price
          ?.ask ??
        null,

      mid:
        intel
          ?.live
          ?.price
          ?.mid ??
        null,

      spreadBps:
        exec.spreadBps,

      funding:
        intel
          ?.live
          ?.context
          ?.funding ??
        null,

      vol24:
        exec.vol24,

      oiNotional:
        exec.oiNotional,

      bookNotional:
        exec.bookNotional,

      m5:
        intel
          ?.live
          ?.momentum
          ?.m5
          ?.returnPct ??
        null,

      m15:
        intel
          ?.live
          ?.momentum
          ?.m15
          ?.returnPct ??
        null,

      m60:
        intel
          ?.live
          ?.momentum
          ?.m60
          ?.returnPct ??
        null,
    },

    reasons:
      [
        ...new Set(
          reasons
        ),
      ],
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
    const url =
      new URL(
        req.url,
        BASE
      );

    const requested =
      n(
        url
          .searchParams
          .get("limit")
      );

    const deepLimit =
      clamp(
        requested == null
          ? DEFAULT_DEEP_LIMIT
          : Math.floor(
              requested
            ),
        5,
        MAX_DEEP_LIMIT
      );

    const universe =
      await fetchJson(
        `${BASE}/api/rank?mode=universe`
      );

    const stage1 =
      (
        universe
          ?.ranking ??
        []
      )
        .map(
          (row) => ({
            ...row,

            stage1Score:
              stage1Score(
                row
              ),
          })
        )
        .sort(
          (a, b) =>
            b.stage1Score -
            a.stage1Score
        );

    const shortlist =
      stage1.slice(
        0,
        deepLimit
      );

    const deepRaw =
      await mapLimit(
        shortlist,
        DEEP_CONCURRENCY,
        async (row) => {
          try {
            const intel =
              await fetchJson(
                `${BASE}/api/intel?coin=${encodeURIComponent(
                  row.coin
                )}`
              );

            return {
              ok: true,

              result:
                deepEvaluate(
                  intel,
                  row
                    .stage1Score
                ),
            };
          } catch (e) {
            return {
              ok: false,

              coin:
                row.coin,

              error:
                String(e),
            };
          }
        }
      );

    const deep =
      deepRaw
        .filter(
          (x) =>
            x?.ok &&
            x?.result
        )
        .map(
          (x) =>
            x.result
        )
        .sort(
          (a, b) =>
            b.deepScore -
            a.deepScore
        );

    const actionable =
      deep.filter(
        (x) =>
          x.actionable
      );

    const candidates =
      (
        actionable.length
          ? actionable
          : deep.filter(
              (x) =>
                x.direction !==
                "NEUTRAL"
            )
      ).slice(
        0,
        3
      );

    return res
      .status(200)
      .json({
        ok: true,

        generatedAt:
          Date.now(),

        universe: {
          total:
            universe
              ?.counts
              ?.total ??
            stage1.length,

          dexesChecked:
            universe
              ?.counts
              ?.dexesChecked ??
            null,

          dexesFailed:
            universe
              ?.counts
              ?.dexesFailed ??
            null,
        },

        methodology: {
          stage1Compared:
            stage1.length,

          stage2DeepChecked:
            shortlist.length,

          deepConcurrency:
            DEEP_CONCURRENCY,

          maxCandidates: 3,
        },

        candidates,

        top10:
          deep.slice(
            0,
            10
          ),

        stage1Top10:
          stage1
            .slice(
              0,
              10
            )
            .map(
              (x) => ({
                coin:
                  x.coin,

                stage1Score:
                  x.stage1Score,

                liquidityScore:
                  x.liquidityScore,

                dayNtlVlm:
                  x.dayNtlVlm,

                oiNotional:
                  x.oiNotional,

                funding:
                  x.funding,
              })
            ),

        errors:
          deepRaw
            .filter(
              (x) =>
                !x?.ok
            )
            .map(
              (x) => ({
                coin:
                  x.coin,

                error:
                  x.error,
              })
            ),
      });
  } catch (e) {
    return res
      .status(500)
      .json({
        ok: false,

        generatedAt:
          Date.now(),

        error:
          String(e),
      });
  }
}

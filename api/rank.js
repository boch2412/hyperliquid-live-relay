const BASE = "https://hyperliquid-live-relay.vercel.app";
const HL_INFO =
  "https://api.hyperliquid.xyz/info";

const UNIVERSE_DEX_CONCURRENCY = 4;
const DEFAULT_DEEP_LIMIT = 18;
const MAX_DEEP_LIMIT = 24;
const DEEP_CONCURRENCY = 6;
const COINS = [
  "BTC",
  "SUI",
  "xyz:MU",
  "xyz:SNDK",
  "xyz:SKHX",
];
async function postHlInfo(payload) {
  const r = await fetch(
    HL_INFO,
    {
      method: "POST",

      headers: {
        "content-type":
          "application/json",
      },

      body:
        JSON.stringify(
          payload
        ),

      cache:
        "no-store",
    }
  );

  const text =
    await r.text();

  if (!r.ok) {
    throw new Error(
      `HL ${r.status}: ${text.slice(
        0,
        200
      )}`
    );
  }

  return JSON.parse(text);
}

function baseName(s) {
  const x =
    String(s || "");

  return x.includes(":")
    ? x.split(":").pop()
    : x;
}

function parseMetaCtx(resp) {
  if (
    !Array.isArray(resp) ||
    resp.length < 2
  ) {
    return {
      universe: [],
      ctxs: [],
    };
  }

  return {
    universe:
      Array.isArray(
        resp?.[0]?.universe
      )
        ? resp[0].universe
        : [],

    ctxs:
      Array.isArray(
        resp?.[1]
      )
        ? resp[1]
        : [],
  };
}

function makeUniverseRows(
  parsed,
  dex
) {
  const rows = [];

  for (
    let i = 0;
    i < parsed.universe.length;
    i++
  ) {
    const meta =
      parsed.universe[i];

    const ctx =
      parsed.ctxs[i] ?? null;

    const rawName =
      meta?.name;

    if (!rawName) {
      continue;
    }

    const coin =
      dex
        ? (
            String(rawName)
              .includes(":")
              ? String(rawName)
              : `${dex}:${baseName(
                  rawName
                )}`
          )
        : String(rawName);

    const markPx =
      n(ctx?.markPx);

    const oi =
      n(
        ctx?.openInterest
      );

    const volume =
      n(
        ctx?.dayNtlVlm
      );

    const oiNotional =
      markPx != null &&
      oi != null
        ? markPx * oi
        : null;

    const isDelisted =
      meta?.isDelisted === true ||
      meta?.delisted === true;

    const liquidityScore =
      Math.log10(
        1 +
        Math.max(
          0,
          volume ?? 0
        )
      ) *
        0.7 +
      Math.log10(
        1 +
        Math.max(
          0,
          oiNotional ?? 0
        )
      ) *
        0.3;

    rows.push({
      coin,

      base:
        baseName(rawName),

      dex:
        dex || null,

      native:
        !dex,

      tradable:
        !isDelisted,

      markPx,

      funding:
        n(ctx?.funding),

      openInterest:
        oi,

      oiNotional,

      dayNtlVlm:
        volume,

      maxLeverage:
        n(
          meta?.maxLeverage
        ),

      liquidityScore,
    });
  }

  return rows;
}

async function fetchDexRows(
  dex
) {
  try {
    const raw =
      await postHlInfo({
        type:
          "metaAndAssetCtxs",

        dex,
      });

    return {
      ok: true,
      dex,

      rows:
        makeUniverseRows(
          parseMetaCtx(raw),
          dex
        ),
    };
  } catch (e) {
    return {
      ok: false,
      dex,
      rows: [],
      error:
        String(e),
    };
  }
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
          items[i]
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

async function getUniverseRanking() {
  const nativeRaw =
    await postHlInfo({
      type:
        "metaAndAssetCtxs",
    });

  const nativeRows =
    makeUniverseRows(
      parseMetaCtx(
        nativeRaw
      ),
      ""
    );

  let dexRaw = [];

  try {
    dexRaw =
      await postHlInfo({
        type:
          "perpDexs",
      });
  } catch {}

  const discoveredDexes =
    Array.isArray(dexRaw)
      ? dexRaw
          .map(
            (x) =>
              typeof x ===
              "string"
                ? x
                : (
                    x?.name ||
                    x?.dex ||
                    x?.symbol ||
                    x?.id ||
                    null
                  )
          )
          .filter(Boolean)
          .map(String)
      : [];

  const dexes = [
    ...new Set([
      "xyz",
      ...discoveredDexes,
    ]),
  ].filter(Boolean);

  const dexResults =
    await mapLimit(
      dexes,
      UNIVERSE_DEX_CONCURRENCY,
      fetchDexRows
    );

  const allRows = [
    ...nativeRows,

    ...dexResults.flatMap(
      (x) =>
        x?.rows ?? []
    ),
  ];

  const deduped =
    new Map();

  for (
    const row of allRows
  ) {
    if (!row?.coin) {
      continue;
    }

    const old =
      deduped.get(
        row.coin
      );

    if (
      !old ||
      (
        row.dayNtlVlm ?? 0
      ) >
        (
          old.dayNtlVlm ?? 0
        )
    ) {
      deduped.set(
        row.coin,
        row
      );
    }
  }

  const ranking = [
    ...deduped.values(),
  ]
    .filter(
      (x) =>
        x.tradable
    )
    .sort(
      (a, b) =>
        (
          b.liquidityScore ??
          0
        ) -
        (
          a.liquidityScore ??
          0
        )
    );

  return {
    ok: true,

    generatedAt:
      Date.now(),

    counts: {
      total:
        ranking.length,

      native:
        nativeRows.length,

      dexesChecked:
        dexes.length,

      dexesFailed:
        dexResults.filter(
          (x) =>
            !x?.ok
        ).length,
    },

    dexes,

    failedDexes:
      dexResults
        .filter(
          (x) =>
            !x?.ok
        )
        .map(
          (x) => ({
            dex:
              x.dex,

            error:
              x.error,
          })
        ),

    ranking,
  };
}
function screenerStage1Score(row) {
  const liquidity =
    Number(
      row?.liquidityScore
    ) || 0;

  const volume =
    Math.max(
      0,
      Number(
        row?.dayNtlVlm
      ) || 0
    );

  const oiNotional =
    Math.max(
      0,
      Number(
        row?.oiNotional
      ) || 0
    );

  const funding =
    Math.abs(
      Number(
        row?.funding
      ) || 0
    );

  const volumeScore =
    Math.min(
      1,
      Math.log10(
        1 + volume
      ) / 9
    );

  const oiScore =
    Math.min(
      1,
      Math.log10(
        1 + oiNotional
      ) / 10
    );

  const liquidityScore =
    Math.min(
      1,
      liquidity / 10
    );

  const turnover =
    oiNotional > 0
      ? volume /
        oiNotional
      : 0;

  const activityScore =
    Math.min(
      1,
      Math.log10(
        1 +
        turnover * 10
      ) / 1.5
    );

  const fundingScore =
    Math.min(
      1,
      funding /
        0.00015
    );

  return (
    liquidityScore *
      0.42 +
    volumeScore *
      0.22 +
    oiScore *
      0.16 +
    activityScore *
      0.15 +
    fundingScore *
      0.05
  );
}

function screenerFinalScore(
  evaluated,
  stage1Score
) {
  const opportunity =
    Number(
      evaluated
        ?.opportunity
    ) || 0;

  const confidence =
    (
      Number(
        evaluated
          ?.confidence
      ) || 0
    ) / 100;

  const execution =
    Number(
      evaluated
        ?.executionQuality
        ?.score
    ) || 0;

  const magnitude =
    Math.min(
      1,
      Math.abs(
        Number(
          evaluated
            ?.compositeScore
        ) || 0
      ) / 1.25
    );

  return (
    opportunity *
      0.38 +
    confidence *
      0.24 +
    execution *
      0.16 +
    magnitude *
      0.14 +
    stage1Score *
      0.08
  );
}

async function runUniverseScreener(
  requestedLimit
) {
  const limit =
    Math.max(
      5,
      Math.min(
        MAX_DEEP_LIMIT,
        Number.isFinite(
          Number(
            requestedLimit
          )
        )
          ? Math.floor(
              Number(
                requestedLimit
              )
            )
          : DEFAULT_DEEP_LIMIT
      )
    );

  const universe =
    await getUniverseRanking();

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
            screenerStage1Score(
              row
            ),
        })
      )
      .sort(
        (a, b) =>
          b.stage1Score -
          a.stage1Score
      );

  const bestByAsset =
  new Map();

for (const row of stage1) {
  const rawCoin =
    String(
      row?.coin ?? ""
    );

  const asset =
    rawCoin.includes(":")
      ? rawCoin.split(":").pop()
      : rawCoin;

  const key =
    asset.toUpperCase();

  const current =
    bestByAsset.get(key);

  if (
    !current ||
    row.stage1Score >
      current.stage1Score
  ) {
    bestByAsset.set(
      key,
      row
    );
  }
}

const dedupedStage1 =
  Array.from(
    bestByAsset.values()
  ).sort(
    (a, b) =>
      b.stage1Score -
      a.stage1Score
  );

const shortlist =
  dedupedStage1.slice(
    0,
    limit
  );

  const deepRaw =
    await mapLimit(
      shortlist,
      DEEP_CONCURRENCY,
      async (row) => {
        try {
          const intel =
            await getIntel(
              row.coin
            );

          const evaluated =
            evaluate(
              intel
            );

          return {
            ok: true,

            result: {
              ...evaluated,

              stage1Score:
                row
                  .stage1Score,

              screenerScore:
                screenerFinalScore(
                  evaluated,
                  row
                    .stage1Score
                ),

              universeData: {
                dex:
                  row.dex,

                native:
                  row.native,

                dayNtlVlm:
                  row
                    .dayNtlVlm,

                oiNotional:
                  row
                    .oiNotional,

                funding:
                  row
                    .funding,

                maxLeverage:
                  row
                    .maxLeverage,
              },
            },
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
          b.screenerScore -
          a.screenerScore
      );

  const actionable =
    deep.filter(
      (x) =>
        (
          x.bias ===
            "LONG" ||
          x.bias ===
            "SHORT"
        ) &&
        x.confidence >=
          60 &&
        (
          x
            ?.executionQuality
            ?.score ??
          0
        ) >= 0.7
    );

  const candidates =
    (
      actionable.length
        ? actionable
        : deep.filter(
            (x) =>
              x.bias !==
              "NEUTRAL"
          )
    ).slice(
      0,
      3
    );

  return {
    ok: true,

    generatedAt:
      Date.now(),
    watchlist:
      shortlist.map(
        (x) => x.coin
      ),
    watchlistDetails:
  shortlist.map(
    (x, index) => ({
      coin:
        x.coin,

      rank:
        index + 1,

      stage1Score:
        x.stage1Score,

      dex:
        x.dex ?? null,

      dayNtlVlm:
        x.dayNtlVlm ?? null,

      oiNotional:
        x.oiNotional ?? null,
    })
  ),
    methodology: {
      universeCompared:
        stage1.length,

      uniqueAssets:
  dedupedStage1.length,
      
      deepChecked:
        shortlist.length,

      deepConcurrency:
        DEEP_CONCURRENCY,

      maxCandidates:
        3,
    },

    universe: {
      total:
        universe
          ?.counts
          ?.total ??
        stage1.length,

      native:
        universe
          ?.counts
          ?.native ??
        null,

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
              x
                .liquidityScore,

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
  };
}
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
async function getPersistence() {
  const r = await fetch(
    `${BASE}/api/persistence`,
    { cache: "no-store" }
  );

  const text = await r.text();

  if (!r.ok) {
    throw new Error(
      `persistence ${r.status}: ${text.slice(0, 150)}`
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

  return {
    observedPct: median,
    baselinePct: clamp(
      median * 1.5,
      0.08,
      1.5
    ),
    sourceCount: vals.length,
  };
}

function momentumScore(momentum, baseline) {
  const weights = {
    m5: 1,
    m15: 2,
    m60: 3,
  };

  let score = 0;
  let weight = 0;

  for (const k of ["m5", "m15", "m60"]) {
    const r = n(momentum?.[k]?.returnPct);

    if (r == null) continue;

    score +=
      clamp(
        r / baseline,
        -1.75,
        1.75
      ) * weights[k];

    weight += weights[k];
  }

  return weight
    ? score / weight
    : 0;
}

function historyScore(history, baseline) {
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
      price / baseline,
      -1.5,
      1.5
    );

    if (oi != null && Math.abs(oi) >= 0.05) {
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

function executionQuality(intel) {
  const mid =
    n(intel?.live?.price?.mid);

  const spreadBps =
    n(intel?.live?.price?.spreadBps) ?? 999;

  const oi =
    n(intel?.live?.context?.openInterest);

  const vol24 =
    n(intel?.live?.context?.dayNtlVlm);

  const top20Bid =
    n(intel?.live?.orderBook?.top20?.bidSize);

  const top20Ask =
    n(intel?.live?.orderBook?.top20?.askSize);

  const top20Total =
    (top20Bid ?? 0) +
    (top20Ask ?? 0);

  const oiNotional =
    mid != null && oi != null
      ? mid * oi
      : null;

  const bookNotional =
    mid != null
      ? mid * top20Total
      : null;

  let score = 1;
  const reasons = [];

  if (spreadBps > 3) {
    score -= 0.15;
    reasons.push("spread_elevated");
  }

  if (spreadBps > 6) {
    score -= 0.2;
    reasons.push("spread_wide");
  }

  if (vol24 != null) {
    if (vol24 < 5_000_000) {
      score -= 0.3;
      reasons.push("low_24h_volume");
    } else if (vol24 < 20_000_000) {
      score -= 0.15;
      reasons.push("moderate_24h_volume");
    }
  } else {
    score -= 0.15;
    reasons.push("volume_unknown");
  }

  if (oiNotional != null) {
    if (oiNotional < 3_000_000) {
      score -= 0.25;
      reasons.push("low_oi_notional");
    } else if (oiNotional < 10_000_000) {
      score -= 0.1;
      reasons.push("moderate_oi_notional");
    }
  } else {
    score -= 0.1;
    reasons.push("oi_unknown");
  }

  if (bookNotional != null) {
    if (bookNotional < 100_000) {
      score -= 0.25;
      reasons.push("thin_orderbook");
    } else if (bookNotional < 300_000) {
      score -= 0.1;
      reasons.push("moderate_orderbook");
    }
  } else {
    score -= 0.1;
    reasons.push("book_depth_unknown");
  }

  return {
    score: clamp(score, 0, 1),

    metrics: {
      spreadBps,
      vol24,
      oiNotional,
      bookNotional,
    },

    reasons,
  };
}

function dataQuality(intel) {
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
    q -= 0.25;
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

  return (
    Math.abs(
      signs.reduce(
        (a, b) => a + b,
        0
      )
    ) / signs.length
  );
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
    historyScore(
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

  const quality =
    dataQuality(intel);

  const execution =
    executionQuality(intel);

  const agreement =
    agreementScore(intel);

  const conflicts =
    structureConflict(
      history,
      momentum,
      book
    );

  let composite =
    history * 0.40 +
    momentum * 0.35 +
    book * 0.15 +
    funding * 0.10;

  if (conflicts === 1) {
    composite *= 0.8;
  }

  if (conflicts >= 2) {
    composite *= 0.55;
  }

  composite *=
    0.75 +
    execution.score * 0.25;

  const moveStrength =
    clamp(
      Math.abs(composite) / 1.25,
      0,
      1
    );

  let confidence =
    quality *
    execution.score *
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

  const threshold =
    clamp(
      0.68 +
        (1 - quality) * 0.30 +
        (1 - execution.score) * 0.25 +
        conflicts * 0.10,
      0.68,
      1.25
    );

  const full60mReady =
    intel?.quality?.full60mReady === true;

  let bias = "NEUTRAL";

  if (
    full60mReady &&
    composite >= threshold &&
    confidence >= 60
  ) {
    bias = "LONG";
  } else if (
    full60mReady &&
    composite <= -threshold &&
    confidence >= 60
  ) {
    bias = "SHORT";
  }

  const reasons = [];

  if (!full60mReady) {
    reasons.push("60m_history_not_ready");
  }

  if (quality < 0.7) {
    reasons.push("data_quality_low");
  }

  if (execution.score < 0.7) {
    reasons.push("execution_quality_low");
  }

  reasons.push(
    ...execution.reasons
  );

  if (agreement < 0.5) {
    reasons.push("timeframes_conflict");
  }

  if (conflicts >= 1) {
    reasons.push(
      "signal_structure_conflict"
    );
  }

  if (
    bias === "NEUTRAL" &&
    Math.abs(composite) < threshold
  ) {
    reasons.push("edge_too_small");
  }

  if (confidence < 60) {
    reasons.push("confidence_too_low");
  }

  const opportunity =
    Math.abs(composite) *
    (confidence / 100) *
    quality *
    execution.score;

  return {
    coin: intel.coin,
    bias,

    compositeScore:
      composite,

    confidence,
    opportunity,
    threshold,

    volatility: vol,

    executionQuality: execution,
marketSnapshot: {
  price: {
    bid:
      intel?.live?.price?.bid ?? null,

    ask:
      intel?.live?.price?.ask ?? null,

    mid:
      intel?.live?.price?.mid ?? null,

    spreadBps:
      intel?.live?.price?.spreadBps ?? null,
  },

  momentum: {
    m5:
      intel?.live?.momentum?.m5 ?? null,

    m15:
      intel?.live?.momentum?.m15 ?? null,

    m60:
      intel?.live?.momentum?.m60 ?? null,
  },
},
    components: {
      history,
      momentum,
      book,
      funding,
      agreement,
      quality,
      execution:
        execution.score,
      conflicts,
    },

    reasons:
      [...new Set(reasons)],
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
  const url = new URL(
    req.url,
    BASE
  );

  const mode =
    url.searchParams.get("mode");

  if (mode === "universe") {
    try {
      const universe =
        await getUniverseRanking();

      return res
        .status(200)
        .json(universe);
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
    if (mode === "screener") {
    try {
      const limit =
        url.searchParams.get(
          "limit"
        );

      const screener =
        await runUniverseScreener(
          limit
        );

      return res
        .status(200)
        .json(
          screener
        );
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

    const persistence =
  await getPersistence();

const persistentMap =
  new Map(
    (
      persistence
        ?.persistentSignals ?? []
    ).map(
      (x) => [
        x.coin,
        x.bias,
      ]
    )
  );

const actionable =
  evaluated.filter(
    (x) =>
      (
        x.bias === "LONG" ||
        x.bias === "SHORT"
      ) &&
      persistentMap.get(
        x.coin
      ) === x.bias
  );

    return res
      .status(200)
      .json({
        ok: true,
        generatedAt:
          Date.now(),

        best:
          evaluated[0] ?? null,

        bestActionable:
          actionable[0] ?? null,

        tradeAllowed:
          actionable.length > 0,persistenceReady:
  persistence
    ?.persistenceReady === true,

persistence,

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

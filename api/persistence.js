const COINS = [
  "BTC",
  "SUI",
  "xyz:MU",
  "xyz:SNDK",
  "xyz:SKHX",
];

const LOOKBACK_MS =
  30 * 60 * 1000;

const MAX_RECORDS = 6;

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function envFirst(names) {
  for (const name of names) {
    if (process.env[name]) {
      return process.env[name];
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

  return {
    url,
    token,
  };
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
const WATCHRANK_WINDOW_MS =
  6 * 60 * 60 * 1000;

const WATCHRANK_EXPECTED_SAMPLES =
  72;

async function loadWatchRank(
  coin
) {
  const now =
    Date.now();

  const raw =
    await redis([
      "ZRANGEBYSCORE",

      `hl:watchrank:${coin}`,

      String(
        now -
          WATCHRANK_WINDOW_MS
      ),

      String(now),
    ]);

  const rows =
    Array.isArray(
      raw?.result
    )
      ? raw.result
          .map((x) => {
            try {
              return JSON.parse(x);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
      : [];

  return rows.sort(
    (a, b) =>
      Number(a?.t) -
      Number(b?.t)
  );
}

function evaluateWatchRank(
  coin,
  rows,
  expectedSamples
) {
  if (!rows.length) {
    return {
      coin,
      score: 0.5,
      samples: 0,
      appearanceRate: null,
      consecutive: 0,
      rankTrend: 0,
      scoreTrend: 0,
      firstRank: null,
      latestRank: null,
      firstScore: null,
      latestScore: null,
      historyReady: false,
    };
  }

  const first =
    rows[0];

  const latest =
    rows[
      rows.length - 1
    ];

  let consecutive = 1;

  for (
    let i =
      rows.length - 1;
    i > 0;
    i--
  ) {
    const gap =
      Number(
        rows[i]?.t
      ) -
      Number(
        rows[
          i - 1
        ]?.t
      );

    if (
      gap <=
      7 * 60 * 1000
    ) {
      consecutive++;
    } else {
      break;
    }
  }

  const effectiveExpectedSamples =
  Math.max(
    3,
    Math.min(
      WATCHRANK_EXPECTED_SAMPLES,
      Number(
        expectedSamples
      ) || 3
    )
  );

const appearanceRate =
  Math.min(
    1,
    rows.length /
      effectiveExpectedSamples
  );

  const firstRank =
    Number(
      first?.rank
    );

  const latestRank =
    Number(
      latest?.rank
    );

  const rankTrend =
    Number.isFinite(
      firstRank
    ) &&
    Number.isFinite(
      latestRank
    )
      ? firstRank -
        latestRank
      : 0;

  const firstScore =
    Number(
      first?.stage1Score
    );

  const latestScore =
    Number(
      latest?.stage1Score
    );

  const scoreTrend =
    Number.isFinite(
      firstScore
    ) &&
    Number.isFinite(
      latestScore
    )
      ? latestScore -
        firstScore
      : 0;

  const appearanceComponent =
    appearanceRate;

  const consecutiveComponent =
    Math.min(
      1,
      consecutive / 12
    );

  const rankComponent =
    Math.max(
      0,
      Math.min(
        1,
        0.5 +
          rankTrend / 20
      )
    );

  const scoreComponent =
    Math.max(
      0,
      Math.min(
        1,
        0.5 +
          scoreTrend * 5
      )
    );

  const rawScore =
    appearanceComponent *
      0.35 +
    consecutiveComponent *
      0.30 +
    rankComponent *
      0.20 +
    scoreComponent *
      0.15;

  const historyReady =
    rows.length >= 3;

  return {
    coin,

    score:
      historyReady
        ? rawScore
        : 0.5,

    rawScore,

    samples:
      rows.length,

    appearanceRate,

    consecutive,

    rankTrend,

    scoreTrend,

    firstRank:
      first?.rank ??
      null,

    latestRank:
      latest?.rank ??
      null,

    firstScore:
      first?.stage1Score ??
      null,

    latestScore:
      latest?.stage1Score ??
      null,

    historyReady,
  };
}

async function getWatchRankResults() {
  const rankResponse =
    await fetch(
      "https://hyperliquid-live-relay.vercel.app/api/rank?mode=screener&limit=18",
      {
        cache:
          "no-store",
      }
    );

  const text =
    await rankResponse.text();

  if (!rankResponse.ok) {
    throw new Error(
      `rank ${rankResponse.status}: ${text.slice(
        0,
        200
      )}`
    );
  }

  const data =
    JSON.parse(text);

  const watchlist =
    Array.isArray(
      data?.watchlist
    )
      ? data.watchlist
      : [];

  const loaded =
  [];

for (
  const coin of watchlist
) {
  const rows =
    await loadWatchRank(
      coin
    );

  loaded.push({
    coin,
    rows,
  });
}

const observedMaxSamples =
  Math.max(
    3,
    ...loaded.map(
      (x) =>
        x.rows.length
    )
  );

const effectiveExpectedSamples =
  Math.min(
    WATCHRANK_EXPECTED_SAMPLES,
    observedMaxSamples
  );

const results =
  loaded.map(
    ({ coin, rows }) =>
      evaluateWatchRank(
        coin,
        rows,
        effectiveExpectedSamples
      )
  );

return results.sort(
    (a, b) =>
      b.score -
      a.score
  );
}
function parseRecord(v) {
  if (!v) {
    return null;
  }

  try {
    return typeof v === "string"
      ? JSON.parse(v)
      : v;
  } catch {
    return null;
  }
}

async function loadHistory(
  coin
) {
  const now =
    Date.now();

  const key =
    `hl:rank:${coin}`;

  const raw =
    await redis([
      "ZRANGEBYSCORE",
      key,
      String(
        now -
        LOOKBACK_MS
      ),
      "+inf",
    ]);

  const values =
    Array.isArray(
      raw?.result
    )
      ? raw.result
      : [];

  return values
    .map(parseRecord)
    .filter(Boolean)
    .sort(
      (a, b) =>
        Number(a.t) -
        Number(b.t)
    )
    .slice(
      -MAX_RECORDS
    );
}

function direction(row) {
  if (
    row?.bias === "LONG"
  ) {
    return 1;
  }

  if (
    row?.bias === "SHORT"
  ) {
    return -1;
  }

  return 0;
}

function scoreDirection(row) {
  const score =
    n(
      row?.compositeScore
    );

  if (score == null) {
    return 0;
  }

  if (score > 0) {
    return 1;
  }

  if (score < 0) {
    return -1;
  }

  return 0;
}

function evaluateDirection(
  rows,
  wanted
) {
  const recent =
    rows.slice(-3);

  const wantedBias =
    wanted > 0
      ? "LONG"
      : "SHORT";

  const sameBias =
    recent.filter(
      (x) =>
        x?.bias ===
        wantedBias
    );

  /*
    条件A:
    直近3回中2回以上が
    実際に同方向シグナル。
  */
  const twoOfThree =
    recent.length >= 3 &&
    sameBias.length >= 2;

  const last =
    rows[
      rows.length - 1
    ];

  const prev =
    rows[
      rows.length - 2
    ];

  let consecutive =
    false;

  let improving =
    false;

  if (last && prev) {
    consecutive =
      direction(last) === wanted &&
      direction(prev) === wanted;

    const lastScore =
      n(
        last.compositeScore
      );

    const prevScore =
      n(
        prev.compositeScore
      );

    if (
      lastScore != null &&
      prevScore != null
    ) {
      improving =
        wanted > 0
          ? lastScore >
            prevScore
          : lastScore <
            prevScore;
    }
  }

  /*
    条件B:
    2回連続同方向かつ
    スコアがさらに改善。
  */
  const consecutiveImproving =
    consecutive &&
    improving;

  /*
    NEUTRALでも、
    同方向への圧力が
    維持されているか確認。
  */
  const directionalRows =
    recent.filter(
      (x) =>
        scoreDirection(x) ===
        wanted
    );

  const pressureConsistency =
    recent.length >= 3
      ? directionalRows.length /
        recent.length
      : 0;

  const scores =
    recent
      .map(
        (x) =>
          n(
            x.compositeScore
          )
      )
      .filter(
        (x) =>
          x != null
      );

  const averageScore =
    scores.length
      ? scores.reduce(
          (a, b) =>
            a + b,
          0
        ) /
        scores.length
      : null;

  const averageMagnitude =
    scores.length
      ? scores.reduce(
          (a, b) =>
            a +
            Math.abs(b),
          0
        ) /
        scores.length
      : null;

  /*
    最新シグナルが
    NEUTRALへ崩れた場合は、
    古いLONG/SHORTを
    そのまま採用しない。
  */
  const latestStillValid =
    last &&
    (
      direction(last) ===
        wanted ||
      (
        direction(last) === 0 &&
        scoreDirection(last) ===
          wanted &&
        Math.abs(
          n(
            last.compositeScore
          ) ?? 0
        ) >= 0.55
      )
    );

  const passed =
    Boolean(
      latestStillValid &&
      (
        twoOfThree ||
        consecutiveImproving
      )
    );

  let reason =
    "not_persistent";

  if (passed) {
    if (
      consecutiveImproving
    ) {
      reason =
        "consecutive_and_improving";
    } else {
      reason =
        "two_of_three";
    }
  } else if (
    !latestStillValid
  ) {
    reason =
      "latest_signal_weakened";
  } else if (
    rows.length < 2
  ) {
    reason =
      "insufficient_history";
  }

  return {
    direction:
      wantedBias,

    passed,

    reason,

    sampleCount:
      rows.length,

    recentCount:
      recent.length,

    sameBiasCount:
      sameBias.length,

    twoOfThree,

    consecutive,

    improving,

    consecutiveImproving,

    pressureConsistency,

    averageScore,

    averageMagnitude,

    latest:
      last ?? null,

    previous:
      prev ?? null,
  };
}

function evaluateCoin(
  coin,
  rows
) {
  const long =
    evaluateDirection(
      rows,
      1
    );

  const short =
    evaluateDirection(
      rows,
      -1
    );

  let persistentBias =
    "NEUTRAL";

  let passed =
    false;

  let reason =
    "no_persistent_signal";

  if (
    long.passed &&
    !short.passed
  ) {
    persistentBias =
      "LONG";

    passed = true;
    reason =
      long.reason;
  } else if (
    short.passed &&
    !long.passed
  ) {
    persistentBias =
      "SHORT";

    passed = true;
    reason =
      short.reason;
  } else if (
    long.passed &&
    short.passed
  ) {
    /*
      念のため両方向が通った場合は
      最新スコア方向を優先。
    */
    const latest =
      rows[
        rows.length - 1
      ];

    const d =
      scoreDirection(
        latest
      );

    if (d > 0) {
      persistentBias =
        "LONG";
      reason =
        "both_passed_latest_long";
    } else if (d < 0) {
      persistentBias =
        "SHORT";
      reason =
        "both_passed_latest_short";
    }

    passed =
      persistentBias !==
      "NEUTRAL";
  }

  return {
    coin,

    passed,

    persistentBias,

    reason,

    sampleCount:
      rows.length,

    long,

    short,

    history:
      rows,
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
    const mode =
  String(
    req.query.mode ||
      ""
  ).trim();

if (
  mode ===
  "watchrank"
) {
  const ranking =
    await getWatchRankResults();

  const requestedCoin =
    String(
      req.query.coin ||
        ""
    ).trim();

  const filtered =
    requestedCoin
      ? ranking.filter(
          (x) =>
            x.coin ===
            requestedCoin
        )
      : ranking;

  return res
    .status(200)
    .json({
      ok: true,

      generatedAt:
        Date.now(),

      mode:
        "watchrank",

      windowHours: 6,

      expectedSamples:
        WATCHRANK_EXPECTED_SAMPLES,

      historyReady:
        filtered.some(
          (x) =>
            x.historyReady
        ),

      ranking:
        filtered,
    });
}
    const requested =
      String(
        req.query.coin ||
        ""
      ).trim();

    const coins =
      requested
        ? [requested]
        : COINS;

    const results =
      [];

    for (
      const coin of coins
    ) {
      const rows =
        await loadHistory(
          coin
        );

      results.push(
        evaluateCoin(
          coin,
          rows
        )
      );
    }

    const persistent =
      results.filter(
        (x) =>
          x.passed
      );

    return res
      .status(200)
      .json({
        ok: true,

        generatedAt:
          Date.now(),

        persistenceReady:
          results.some(
            (x) =>
              x.sampleCount >=
              2
          ),

        anyPersistentSignal:
          persistent.length >
          0,

        persistentSignals:
          persistent.map(
            (x) => ({
              coin:
                x.coin,

              bias:
                x.persistentBias,

              reason:
                x.reason,
            })
          ),

        results,
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

const BASE =
  "https://hyperliquid-live-relay.vercel.app";

const WINDOW_MS =
  6 * 60 * 60 * 1000;

const EXPECTED_SAMPLES = 72;

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
    Object.entries(
      process.env
    ).find(
      ([key, value]) =>
        /(?:REDIS|KV|STORAGE).*URL/i.test(
          key
        ) &&
        !/QSTASH/i.test(key) &&
        typeof value ===
          "string" &&
        value.includes(
          "upstash"
        )
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
    Object.entries(
      process.env
    ).find(
      ([key]) =>
        /(?:REDIS|KV|STORAGE).*TOKEN/i.test(
          key
        ) &&
        !/QSTASH/i.test(key) &&
        !/SIGNING/i.test(key)
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

  const response =
    await fetch(url, {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${token}`,

        "Content-Type":
          "application/json",
      },

      body:
        JSON.stringify(
          cmd
        ),

      cache:
        "no-store",
    });

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Redis ${response.status}: ${text.slice(
        0,
        200
      )}`
    );
  }

  try {
    return JSON.parse(
      text
    );
  } catch {
    return text;
  }
}

function neutralStats(
  coin
) {
  return {
    coin,

    score: 0.5,

    samples: 0,

    appearanceRate:
      null,

    consecutive: 0,

    rankTrend: 0,

    scoreTrend: 0,

    firstRank: null,

    latestRank: null,

    firstScore: null,

    latestScore: null,

    historyReady:
      false,
  };
}

async function getStats(
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
          WINDOW_MS
      ),

      String(now),
    ]);

  const rows =
    Array.isArray(
      raw?.result
    )
      ? raw.result
          .map(
            (value) => {
              try {
                return JSON.parse(
                  value
                );
              } catch {
                return null;
              }
            }
          )
          .filter(Boolean)
      : [];

  if (!rows.length) {
    return neutralStats(
      coin
    );
  }

  const sorted =
    rows.sort(
      (a, b) =>
        Number(
          a?.t
        ) -
        Number(
          b?.t
        )
    );

  const first =
    sorted[0];

  const latest =
    sorted[
      sorted.length - 1
    ];

  let consecutive = 1;

  for (
    let i =
      sorted.length - 1;
    i > 0;
    i--
  ) {
    const gap =
      Number(
        sorted[i]?.t
      ) -
      Number(
        sorted[
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

  const appearanceRate =
    Math.min(
      1,
      sorted.length /
        EXPECTED_SAMPLES
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
    sorted.length >= 3;

  const score =
    historyReady
      ? rawScore
      : 0.5;

  return {
    coin,

    score,

    rawScore,

    samples:
      sorted.length,

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

async function getWatchlist() {
  const response =
    await fetch(
      `${BASE}/api/rank?mode=screener&limit=18`,
      {
        cache:
          "no-store",
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `rank ${response.status}: ${text.slice(
        0,
        200
      )}`
    );
  }

  const data =
    JSON.parse(text);

  return Array.isArray(
    data?.watchlist
  )
    ? data.watchlist
    : [];
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

    const coin =
      url.searchParams.get(
        "coin"
      );

    if (coin) {
      const stats =
        await getStats(
          coin
        );

      return res
        .status(200)
        .json({
          ok: true,

          generatedAt:
            Date.now(),

          ...stats,
        });
    }

    const watchlist =
      await getWatchlist();

    const results =
      await Promise.all(
        watchlist.map(
          getStats
        )
      );

    const ranking =
      results.sort(
        (a, b) =>
          b.score -
          a.score
      );

    return res
      .status(200)
      .json({
        ok: true,

        generatedAt:
          Date.now(),

        windowHours: 6,

        expectedSamples:
          EXPECTED_SAMPLES,

        historyReady:
          ranking.some(
            (x) =>
              x.historyReady
          ),

        ranking,
      });
  } catch (error) {
    return res
      .status(500)
      .json({
        ok: false,

        error:
          String(error),

        generatedAt:
          Date.now(),
      });
  }
}

const BASE = "https://hyperliquid-live-relay.vercel.app";
const BASE_COINS = [
  "BTC",
  "SUI",
  "xyz:MU",
  "xyz:SNDK",
  "xyz:SKHX",
];

const SNAPSHOT_QUOTE_CONCURRENCY = 2;

async function mapLimit(
  items,
  limit,
  fn
) {
  const out =
    new Array(items.length);

  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;

      if (index >= items.length) {
        return;
      }

      out[index] =
        await fn(
          items[index]
        );
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(
          limit,
          items.length
        ),
      },
      worker
    )
  );

  return out;
}

async function getDynamicCoins() {
  try {
    const r = await fetch(
      `${BASE}/api/rank?mode=screener&limit=18`,
      { cache: "no-store" }
    );

    const text = await r.text();

    if (!r.ok) {
      throw new Error(
        `screener ${r.status}: ${text.slice(0, 200)}`
      );
    }

    const data = JSON.parse(text);

    const details =
  Array.isArray(
    data?.watchlistDetails
  )
    ? data.watchlistDetails
    : [];
    
    const dynamic =
  Array.isArray(data?.watchlist)
    ? data.watchlist
    : [];
const now =
  Date.now();

for (const item of details) {
  const coin =
    String(
      item?.coin ?? ""
    );

  if (!coin) continue;

  const record = {
    t: now,

    coin,

    rank:
      Number(
        item?.rank
      ) || null,

    stage1Score:
      Number(
        item?.stage1Score
      ) || null,

    dex:
      item?.dex ?? null,

    dayNtlVlm:
      Number(
        item?.dayNtlVlm
      ) || null,

    oiNotional:
      Number(
        item?.oiNotional
      ) || null,
  };

  const key =
    `hl:watchrank:${coin}`;

  await redis([
    "ZADD",
    key,
    String(now),
    JSON.stringify(record),
  ]);

  await redis([
    "ZREMRANGEBYSCORE",
    key,
    "0",
    String(
      now -
        6 * 60 * 60 * 1000
    ),
  ]);
}
const byAsset =
  new Map();

for (const coin of BASE_COINS) {
  const raw =
    String(coin);

  const asset =
    raw.includes(":")
      ? raw.split(":").pop()
      : raw;

  byAsset.set(
    asset.toUpperCase(),
    coin
  );
}

for (const coin of dynamic) {
  const raw =
    String(coin);

  const asset =
    raw.includes(":")
      ? raw.split(":").pop()
      : raw;

  byAsset.set(
    asset.toUpperCase(),
    coin
  );
}

const current =
  Array.from(
    byAsset.values()
  );

try {
  const now =
    Date.now();

  const recentKey =
    "hl:watchlist:recent";

  if (current.length) {
    const zadd = [
      "ZADD",
      recentKey,
    ];

    for (const coin of current) {
      zadd.push(
        String(now),
        coin
      );
    }

    await redis(zadd);
  }

  await redis([
    "ZREMRANGEBYSCORE",
    recentKey,
    "0",
    String(
      now -
        6 * 60 * 60 * 1000
    ),
  ]);

  const recentRaw =
    await redis([
      "ZREVRANGE",
      recentKey,
      "0",
      "35",
    ]);

  const recent =
    Array.isArray(
      recentRaw?.result
    )
      ? recentRaw.result
      : [];

  const rollingByAsset =
    new Map();

  for (const coin of current) {
    const raw =
      String(coin);

    const asset =
      raw.includes(":")
        ? raw.split(":").pop()
        : raw;

    const key =
      asset.toUpperCase();

    rollingByAsset.set(
      key,
      coin
    );
  }

  for (const coin of recent) {
    const raw =
      String(coin);

    const asset =
      raw.includes(":")
        ? raw.split(":").pop()
        : raw;

    const key =
      asset.toUpperCase();

    if (
      !rollingByAsset.has(
        key
      )
    ) {
      rollingByAsset.set(
        key,
        coin
      );
    }
  }

  return Array.from(
    rollingByAsset.values()
  ).slice(
    0,
    36
  );
} catch {
  return current;
}
  } catch (e) {
    return [...BASE_COINS];
  }
}
async function getWatchRankStats(
  coin
) {
  const now =
    Date.now();

  const key =
    `hl:watchrank:${coin}`;

  const raw =
    await redis([
      "ZRANGEBYSCORE",
      key,
      String(
        now -
          6 * 60 * 60 * 1000
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

  if (!rows.length) {
    return {
      samples: 0,
      appearanceRate: 0,
      consecutive: 0,
      rankTrend: 0,
      scoreTrend: 0,
    };
  }

  const sorted =
    rows.sort(
      (a, b) =>
        a.t - b.t
    );

  const first =
    sorted[0];

  const last =
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
      sorted[i].t -
      sorted[i - 1].t;

    if (
      gap <=
      7 * 60 * 1000
    ) {
      consecutive++;
    } else {
      break;
    }
  }

  const expectedSamples =
    72;

  const appearanceRate =
    Math.min(
      1,
      sorted.length /
        expectedSamples
    );

  const rankTrend =
    Number(first?.rank) &&
    Number(last?.rank)
      ? Number(first.rank) -
        Number(last.rank)
      : 0;

  const scoreTrend =
    Number(last?.stage1Score) -
    Number(first?.stage1Score);

  return {
    samples:
      sorted.length,

    appearanceRate,

    consecutive,

    rankTrend,

    scoreTrend,

    firstRank:
      first?.rank ?? null,

    latestRank:
      last?.rank ?? null,

    firstScore:
      first?.stage1Score ?? null,

    latestScore:
      last?.stage1Score ?? null,
  };
}
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

function envFirst(names) {
  for (const n of names) {
    if (process.env[n]) return process.env[n];
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

  return { url, token };
}

function qstashToken() {
  return (
    envFirst([
      "QSTASH_TOKEN",
      "STORAGE_QSTASH_TOKEN",
      "UPSTASH_QSTASH_TOKEN",
    ]) ||
    Object.entries(process.env).find(
      ([k]) => /QSTASH.*TOKEN/i.test(k) && !/SIGNING/i.test(k)
    )?.[1] ||
    null
  );
}

async function sha256(s) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function redis(cmd) {
  const { url, token } = redisConfig();

  if (!url || !token) {
    throw new Error("Redis environment variables not found");
  }

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });

  const text = await r.text();

  if (!r.ok) {
    throw new Error(`Redis ${r.status}: ${text.slice(0, 200)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
async function getWatchPersistence(
  coin
) {
  try {
    const now =
      Date.now();

    const raw =
      await redis([
        "ZRANGEBYSCORE",
        `hl:watchrank:${coin}`,
        String(
          now -
            6 * 60 * 60 * 1000
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

    if (!rows.length) {
      return {
        score: 0.5,
        samples: 0,
        appearanceRate: null,
        consecutive: 0,
        rankTrend: 0,
        scoreTrend: 0,
        historyReady: false,
      };
    }

    const sorted =
      rows.sort(
        (a, b) =>
          Number(a?.t) -
          Number(b?.t)
      );

    const first =
      sorted[0];

    const last =
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
          sorted[i - 1]?.t
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
        sorted.length / 72
      );

    const firstRank =
      Number(first?.rank);

    const latestRank =
      Number(last?.rank);

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
        last?.stage1Score
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

    const score =
      appearanceComponent *
        0.35 +
      consecutiveComponent *
        0.30 +
      rankComponent *
        0.20 +
      scoreComponent *
        0.15;

    return {
      score,
      samples:
        sorted.length,

      appearanceRate,
      consecutive,
      rankTrend,
      scoreTrend,

      firstRank:
        first?.rank ?? null,

      latestRank:
        last?.rank ?? null,

      historyReady:
        sorted.length >= 3,
    };
  } catch {
    return {
      score: 0.5,
      samples: 0,
      appearanceRate: null,
      consecutive: 0,
      rankTrend: 0,
      scoreTrend: 0,
      historyReady: false,
    };
  }
}
async function quote(coin) {
  const r = await fetch(
    `${BASE}/api/quote?coin=${encodeURIComponent(coin)}`,
    { cache: "no-store" }
  );

  if (!r.ok) {
    throw new Error(`quote ${coin}: ${r.status}`);
  }

  return r.json();
}

async function saveSnapshot() {
  const now = Date.now();

  const lock = await redis([
    "SET",
    "hl:snapshot:lock",
    String(now),
    "NX",
    "EX",
    "240",
  ]);

  if (lock?.result !== "OK") {
    return {
      ok: true,
      skipped: true,
      reason: "snapshot already taken recently",
    };
  }
const dynamicCoins =
  await getDynamicCoins();
  const quotes = await mapLimit(
    dynamicCoins,
    SNAPSHOT_QUOTE_CONCURRENCY,
    async (coin) => {
      try {
        return { coin, q: await quote(coin) };
      } catch (e) {
        return { coin, error: String(e) };
      }
    }
  );

  const saved = [];
  const errors = [];

  for (const item of quotes) {
    if (item.error) {
      errors.push({ coin: item.coin, error: item.error });
      continue;
    }

    const q = item.q;

    if (!q?.ok || !q?.live || q?.price?.mid == null) {
      errors.push({
        coin: item.coin,
        error: "quote not live",
      });
      continue;
    }

    const record = {
      t: now,
      coin: item.coin,
      bid: q.price.bid,
      ask: q.price.ask,
      mid: q.price.mid,
      mark: q.price.mark,
      oracle: q.price.oracle,
      funding: q.context?.funding ?? null,
      oi: q.context?.openInterest ?? null,
      vol24: q.context?.dayNtlVlm ?? null,
      freshnessMs: q.timing?.freshnessMs ?? null,
    };

    const key = `hl:snap:${item.coin}`;

    await redis([
      "ZADD",
      key,
      String(now),
      JSON.stringify(record),
    ]);

    await redis([
      "ZREMRANGEBYSCORE",
      key,
      "0",
      String(now - KEEP_MS),
    ]);

    saved.push(record);
  }

  return {
  ok: true,
  t: now,

  watchlist:
    dynamicCoins,

  watchlistCount:
    dynamicCoins.length,

  saved,

  savedCount:
    saved.length,

  errors,
};
}

async function setupSchedule() {
  const token = qstashToken();

  if (!token) {
    throw new Error("QStash token environment variable not found");
  }

  const key = await sha256(token);
  const destination = `${BASE}/api/snapshot`;
  const endpoint =
    "https://qstash.upstash.io/v2/schedules/" +
    encodeURIComponent(destination);

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
      "Upstash-Cron": "*/5 * * * *",
      "Upstash-Schedule-Id": "hyperliquid-snapshot-5m",
      "Upstash-Method": "GET",
      "Upstash-Retries": "1",
      "Upstash-Forward-X-Snapshot-Key": key,
    },
    body: "",
    cache: "no-store",
  });

  const text = await r.text();

  if (!r.ok) {
    throw new Error(`QStash ${r.status}: ${text.slice(0, 300)}`);
  }

  let schedule;
  try {
    schedule = JSON.parse(text);
  } catch {
    schedule = text;
  }

return { ok: true, schedule };
}

async function saveDecisionLog() {
  const r = await fetch(
    `${BASE}/api/decision-log`,
    { cache: "no-store" }
  );

  const text = await r.text();

  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      error: text.slice(0, 200),
    };
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      ok: true,
      raw: text,
    };
  }
}
  

async function saveRankPersistence() {
  const r = await fetch(
    `${BASE}/api/persist`,
    { cache: "no-store" }
  );

  const text = await r.text();

  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      error: text.slice(0, 200),
    };
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      ok: true,
      raw: text,
    };
  }
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    if (String(req.query.setup || "") === "1") {
      const redisTest = await redis(["PING"]);
      const schedule = await setupSchedule();
      const firstSnapshot = await saveSnapshot();

      return res.status(200).json({
        ok: true,
        redisTest,
        schedule,
        firstSnapshot,
      });
    }

    const token = qstashToken();

    if (!token) {
      return res.status(500).json({
        ok: false,
        error: "QStash token not configured",
      });
    }

    const expected = await sha256(token);
    const supplied = String(req.headers["x-snapshot-key"] || "");

    if (supplied !== expected) {
      return res.status(401).json({
        ok: false,
        error: "unauthorized",
      });
    }

    const result = await saveSnapshot();
const persistence = await saveRankPersistence();
const decisionLog = await saveDecisionLog();

return res.status(200).json({
  ...result,
  persistence,
  decisionLog,
});
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e),
    });
  }
}

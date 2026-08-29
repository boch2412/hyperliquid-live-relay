const BASE =
  "https://hyperliquid-live-relay.vercel.app";

const KEEP_MS =
  24 * 60 * 60 * 1000;

function envFirst(names) {
  for (const n of names) {
    if (process.env[n]) {
      return process.env[n];
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

  return { url, token };
}

async function redis(cmd) {
  const { url, token } =
    redisConfig();

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

async function getRank() {
  const r = await fetch(
    `${BASE}/api/rank`,
    {
      cache: "no-store",
    }
  );

  const text =
    await r.text();

  if (!r.ok) {
    throw new Error(
      `/api/rank ${r.status}: ` +
      text.slice(0, 200)
    );
  }

  return JSON.parse(text);
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
    const now =
      Date.now();

    const rank =
      await getRank();

    const rows =
      Array.isArray(
        rank?.ranking
      )
        ? rank.ranking
        : [];

    const saved = [];

    for (const row of rows) {
      const record = {
        t: now,

        coin:
          row.coin,

        bias:
          row.bias,

        compositeScore:
          row.compositeScore,

        confidence:
          row.confidence,

        opportunity:
          row.opportunity,

        threshold:
          row.threshold,

        execution:
          row
            ?.executionQuality
            ?.score ?? null,

        reasons:
          row.reasons ?? [],
      };

      const key =
        `hl:rank:${row.coin}`;

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
          now - KEEP_MS
        ),
      ]);

      saved.push(
        record
      );
    }

    return res
      .status(200)
      .json({
        ok: true,

        t: now,

        count:
          saved.length,

        saved,
      });
  } catch (e) {
    return res
      .status(500)
      .json({
        ok: false,

        error:
          String(e),
      });
  }
}

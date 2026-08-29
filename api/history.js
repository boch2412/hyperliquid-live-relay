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

async function redis(cmd) {
  const { url, token } = redisConfig();

  if (!url || !token) {
    throw new Error(
      "Redis environment variables not found"
    );
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
    throw new Error(
      `Redis ${r.status}: ${text.slice(0, 200)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseRecord(v) {
  if (!v) return null;

  try {
    return typeof v === "string"
      ? JSON.parse(v)
      : v;
  } catch {
    return null;
  }
}

function pct(now, before) {
  const a = Number(now);
  const b = Number(before);

  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    b === 0
  ) {
    return null;
  }

  return ((a - b) / b) * 100;
}

function delta(now, before) {
  const a = Number(now);
  const b = Number(before);

  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b)
  ) {
    return null;
  }

  return a - b;
}

function classify(pricePct, oiPct) {
  if (
    !Number.isFinite(pricePct) ||
    !Number.isFinite(oiPct)
  ) {
    return "insufficient_data";
  }

  const priceMove = 0.05;
  const oiMove = 0.05;

  const pUp = pricePct >= priceMove;
  const pDown = pricePct <= -priceMove;
  const oiUp = oiPct >= oiMove;
  const oiDown = oiPct <= -oiMove;

  if (pUp && oiUp) {
    return "new_long_build";
  }

  if (pDown && oiUp) {
    return "new_short_build";
  }

  if (pUp && oiDown) {
    return "short_covering";
  }

  if (pDown && oiDown) {
    return "long_unwind";
  }

  return "mixed_or_flat";
}

function findAtOrBefore(records, target) {
  let best = null;

  for (const r of records) {
    if (!r || !Number.isFinite(Number(r.t))) {
      continue;
    }

    if (
      Number(r.t) <= target &&
      (!best || Number(r.t) > Number(best.t))
    ) {
      best = r;
    }
  }

  return best;
}

function makeWindow(
  latest,
  records,
  minutes
) {
  const target =
    Number(latest.t) -
    minutes * 60 * 1000;

  const before =
    findAtOrBefore(records, target);

  if (!before) {
    return {
      ready: false,
      from: null,
      to: Number(latest.t),
      ageMinutes: null,
      pricePct: null,
      oiPct: null,
      fundingDelta: null,
      classification:
        "insufficient_data",
    };
  }

  const pricePct = pct(
    latest.mid,
    before.mid
  );

  const oiPct = pct(
    latest.oi,
    before.oi
  );

  const fundingDelta = delta(
    latest.funding,
    before.funding
  );

  return {
    ready: true,
    from: Number(before.t),
    to: Number(latest.t),

    ageMinutes:
      (Number(latest.t) -
        Number(before.t)) /
      60000,

    pricePct,
    oiPct,
    fundingDelta,

    classification:
      classify(pricePct, oiPct),
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
    const coin =
      String(req.query.coin || "").trim();

    if (!coin) {
      return res.status(400).json({
        ok: false,
        error: "coin is required",
      });
    }

    const key = `hl:snap:${coin}`;

    /*
      7日保存しているRedisデータから
      最大90分ぶん取得。

      60分比較に十分な余裕を持たせる。
    */
    const now = Date.now();
    const from =
      now - 90 * 60 * 1000;

    const raw = await redis([
      "ZRANGEBYSCORE",
      key,
      String(from),
      "+inf",
    ]);

    const values =
      Array.isArray(raw?.result)
        ? raw.result
        : [];

    const records = values
      .map(parseRecord)
      .filter(Boolean)
      .sort(
        (a, b) =>
          Number(a.t) - Number(b.t)
      );

    if (records.length === 0) {
      return res.status(200).json({
        ok: true,
        coin,
        ready: false,
        count: 0,
        latest: null,
        windows: {
          m5: {
            ready: false,
            classification:
              "insufficient_data",
          },
          m15: {
            ready: false,
            classification:
              "insufficient_data",
          },
          m60: {
            ready: false,
            classification:
              "insufficient_data",
          },
        },
      });
    }

    const latest =
      records[records.length - 1];

    const windows = {
      m5: makeWindow(
        latest,
        records,
        5
      ),

      m15: makeWindow(
        latest,
        records,
        15
      ),

      m60: makeWindow(
        latest,
        records,
        60
      ),
    };

    return res.status(200).json({
      ok: true,
      coin,
      ready: true,
      count: records.length,
      latest,
      windows,
      generatedAt: now,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e),
    });
  }
}

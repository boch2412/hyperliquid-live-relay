const BASE = "https://hyperliquid-live-relay.vercel.app";
const COINS = ["BTC", "SUI", "xyz:MU", "xyz:SNDK", "xyz:SKHX"];
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

  const quotes = await Promise.all(
    COINS.map(async (coin) => {
      try {
        return { coin, q: await quote(coin) };
      } catch (e) {
        return { coin, error: String(e) };
      }
    })
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
    saved,
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
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e),
    });
  }
}

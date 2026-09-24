import test from "node:test";
import assert from "node:assert/strict";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const ROOT = resolve(
  dirname(
    fileURLToPath(import.meta.url)
  ),
  ".."
);

async function verifyRuntimeCompatibilityPin() {
  const pkg = JSON.parse(
    await readFile(
      resolve(ROOT, "package.json"),
      "utf8"
    )
  );

  assert.equal(
    pkg.engines.node,
    "22.x",
    "Vercel must stay on the supported Node 22 runtime until the Node 24 DEP0169 source is resolved"
  );
}

function response(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "content-type": "application/json",
      },
    }
  );
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function freshImport(relativePath, tag) {
  const url = pathToFileURL(
    `${ROOT}/${relativePath}`
  );
  url.searchParams.set("test", tag);
  return import(url.href);
}

function watchRows(coin, count) {
  const now = Date.now();
  return Array.from(
    { length: count },
    (_, index) =>
      JSON.stringify({
        t:
          now -
          (count - index - 1) *
            5 * 60 * 1000,
        coin,
        rank: index + 1,
        stage1Score:
          0.5 + index * 0.01,
      })
  );
}

async function verifyPersistenceBatch() {
  process.env.STORAGE_REDIS_REST_URL =
    "https://redis.test";
  process.env.STORAGE_REDIS_REST_TOKEN =
    "test-token";

  const histories = new Map([
    ["hl:watchrank:SUI", watchRows("SUI", 4)],
    ["hl:watchrank:xyz:MU", watchRows("xyz:MU", 2)],
  ]);

  let redisCalls = 0;
  let rankCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);

    if (value.includes("/api/rank")) {
      rankCalls += 1;
      throw new Error(
        "watchrank must never call rank"
      );
    }

    assert.equal(value, "https://redis.test");
    redisCalls += 1;

    const command =
      JSON.parse(options.body);
    assert.equal(
      command[0],
      "ZRANGEBYSCORE"
    );

    return response({
      result:
        histories.get(command[1]) ?? [],
    });
  };

  const { default: handler } =
    await freshImport(
      "api/persistence.js",
      "batch"
    );

  const res = makeRes();
  await handler(
    {
      query: {
        mode: "watchrank",
        coins: "SUI,xyz:MU",
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.windowHours, 6);
  assert.equal(res.body.expectedSamples, 72);
  assert.equal(res.body.ranking.length, 2);
  assert.equal(redisCalls, 2);
  assert.equal(rankCalls, 0);

  const byCoin = new Map(
    res.body.ranking.map(
      (row) => [row.coin, row]
    )
  );
  assert.equal(
    byCoin.get("SUI").appearanceRate,
    1
  );
  assert.equal(
    byCoin.get("xyz:MU").appearanceRate,
    0.5
  );
}

async function verifyPersistenceRedisTimeout() {
  process.env.STORAGE_REDIS_REST_URL =
    "https://redis.test";
  process.env.STORAGE_REDIS_REST_TOKEN =
    "test-token";
  process.env.PERSISTENCE_REDIS_TIMEOUT_MS =
    "25";

  globalThis.fetch = async (
    _url,
    options = {}
  ) =>
    new Promise((_, reject) => {
      options.signal.addEventListener(
        "abort",
        () =>
          reject(
            new DOMException(
              "aborted",
              "AbortError"
            )
          ),
        { once: true }
      );
    });

  const { default: handler } =
    await freshImport(
      "api/persistence.js",
      "redis-timeout"
    );
  const res = makeRes();
  const startedAt = performance.now();

  await handler(
    {
      query: {
        mode: "watchrank",
        coins: "SUI",
      },
    },
    res
  );

  assert.equal(res.statusCode, 500);
  assert.match(
    res.body.error,
    /Redis timeout after 25ms/
  );
  assert.ok(
    performance.now() - startedAt < 500,
    "persistence should not wait indefinitely for Redis"
  );
}

async function verifySnapshotCoverageAndConcurrency() {
  const token = "qstash-test-token";
  process.env.UPSTASH_QSTASH_TOKEN = token;
  process.env.STORAGE_REDIS_REST_URL =
    "https://redis.test";
  process.env.STORAGE_REDIS_REST_TOKEN =
    "test-token";

  const current = Array.from(
    { length: 18 },
    (_, index) => `C${index}`
  );
  const recent = Array.from(
    { length: 36 },
    (_, index) => `OLD${index}`
  );

  let quoteActive = 0;
  let quoteMaxActive = 0;
  const quoteCoins = [];

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);

    if (value === "https://redis.test") {
      const command =
        JSON.parse(options.body);

      if (command[0] === "SET") {
        return response({ result: "OK" });
      }

      if (command[0] === "ZREVRANGE") {
        return response({ result: recent });
      }

      return response({ result: "OK" });
    }

    if (
      value.includes(
        "/api/rank?mode=screener"
      )
    ) {
      return response({
        ok: true,
        watchlist: current,
        watchlistDetails:
          current.map(
            (coin, index) => ({
              coin,
              rank: index + 1,
              stage1Score:
                1 - index * 0.01,
              dex: null,
              dayNtlVlm: 1_000_000,
              oiNotional: 1_000_000,
            })
          ),
      });
    }

    if (value.includes("/api/quote?coin=")) {
      const coin = new URL(value)
        .searchParams.get("coin");
      quoteCoins.push(coin);
      quoteActive += 1;
      quoteMaxActive = Math.max(
        quoteMaxActive,
        quoteActive
      );

      await new Promise(
        (resolve) =>
          setTimeout(resolve, 5)
      );
      quoteActive -= 1;

      return response({
        ok: true,
        live: true,
        price: {
          bid: 99,
          ask: 101,
          mid: 100,
          mark: 100,
          oracle: 100,
        },
        context: {
          funding: 0,
          openInterest: 1000,
          dayNtlVlm: 1_000_000,
        },
        timing: {
          freshnessMs: 0,
        },
      });
    }

    if (
      value.endsWith("/api/persist") ||
      value.endsWith("/api/decision-log")
    ) {
      return response({ ok: true });
    }

    throw new Error(`unexpected fetch ${value}`);
  };

  const { default: handler } =
    await freshImport(
      "api/snapshot.js",
      "coverage"
    );

  const supplied = createHash("sha256")
    .update(token)
    .digest("hex");
  const res = makeRes();

  await handler(
    {
      query: {},
      headers: {
        "x-snapshot-key": supplied,
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.watchlist.length, 36);
  assert.equal(res.body.savedCount, 36);
  assert.equal(quoteCoins.length, 36);
  assert.equal(quoteMaxActive, 2);

  for (const coin of current) {
    assert.ok(
      res.body.watchlist.includes(coin),
      `missing current finalist ${coin}`
    );
  }

  for (const coin of [
    "BTC",
    "SUI",
    "xyz:MU",
    "xyz:SNDK",
    "xyz:SKHX",
  ]) {
    assert.ok(
      res.body.watchlist.includes(coin),
      `missing base coin ${coin}`
    );
  }
}

async function verifySnapshotLockSkipsDownstreamWork() {
  const token = "qstash-lock-skip-token";
  process.env.UPSTASH_QSTASH_TOKEN = token;
  process.env.STORAGE_REDIS_REST_URL =
    "https://redis.test";
  process.env.STORAGE_REDIS_REST_TOKEN =
    "test-token";

  let downstreamCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);

    if (value === "https://redis.test") {
      const command = JSON.parse(options.body);
      assert.equal(command[0], "SET");
      return response({ result: null });
    }

    if (
      value.endsWith("/api/persist") ||
      value.endsWith("/api/decision-log")
    ) {
      downstreamCalls += 1;
      return response({ ok: true });
    }

    throw new Error(`unexpected fetch ${value}`);
  };

  const { default: handler } =
    await freshImport(
      "api/snapshot.js",
      "lock-skip"
    );

  const supplied = createHash("sha256")
    .update(token)
    .digest("hex");
  const res = makeRes();

  await handler(
    {
      query: {},
      headers: {
        "x-snapshot-key": supplied,
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.skipped, true);
  assert.equal(res.body.persistence.skipped, true);
  assert.equal(res.body.decisionLog.skipped, true);
  assert.equal(downstreamCalls, 0);
}

async function verifySnapshotRankTimeout() {
  const token =
    "qstash-rank-timeout-token";
  process.env.UPSTASH_QSTASH_TOKEN = token;
  process.env.STORAGE_REDIS_REST_URL =
    "https://redis.test";
  process.env.STORAGE_REDIS_REST_TOKEN =
    "test-token";
  process.env.SNAPSHOT_RANK_TIMEOUT_MS =
    "25";

  let rankAborted = false;

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);

    if (value === "https://redis.test") {
      return response({ result: "OK" });
    }

    if (
      value.includes(
        "/api/rank?mode=screener"
      )
    ) {
      return new Promise((_, reject) => {
        const abort = () => {
          rankAborted = true;
          reject(
            options.signal.reason ??
              new DOMException(
                "Aborted",
                "AbortError"
              )
          );
        };

        if (options.signal.aborted) {
          abort();
        } else {
          options.signal.addEventListener(
            "abort",
            abort,
            { once: true }
          );
        }
      });
    }

    if (value.includes("/api/quote?coin=")) {
      return response({
        ok: true,
        live: true,
        price: {
          bid: 99,
          ask: 101,
          mid: 100,
          mark: 100,
          oracle: 100,
        },
        context: {
          funding: 0,
          openInterest: 1000,
          dayNtlVlm: 1_000_000,
        },
        timing: {
          freshnessMs: 0,
        },
      });
    }

    if (
      value.endsWith("/api/persist") ||
      value.endsWith("/api/decision-log")
    ) {
      return response({ ok: true });
    }

    throw new Error(`unexpected fetch ${value}`);
  };

  const { default: handler } =
    await freshImport(
      "api/snapshot.js",
      "rank-timeout"
    );
  const supplied = createHash("sha256")
    .update(token)
    .digest("hex");
  const res = makeRes();
  const startedAt = performance.now();

  await handler(
    {
      query: {},
      headers: {
        "x-snapshot-key": supplied,
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(rankAborted, true);
  assert.deepEqual(
    res.body.watchlist,
    [
      "BTC",
      "SUI",
      "xyz:MU",
      "xyz:SNDK",
      "xyz:SKHX",
    ]
  );
  assert.equal(res.body.savedCount, 5);
  assert.ok(
    performance.now() - startedAt < 500,
    "snapshot should fall back instead of waiting indefinitely for rank"
  );
}

async function verifySnapshotQuoteTimeout() {
  const token = "qstash-timeout-token";
  process.env.UPSTASH_QSTASH_TOKEN = token;
  process.env.STORAGE_REDIS_REST_URL =
    "https://redis.test";
  process.env.STORAGE_REDIS_REST_TOKEN =
    "test-token";
  process.env.SNAPSHOT_QUOTE_TIMEOUT_MS =
    "25";

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);

    if (value === "https://redis.test") {
      const command =
        JSON.parse(options.body);

      if (command[0] === "SET") {
        return response({ result: "OK" });
      }

      if (command[0] === "ZREVRANGE") {
        return response({ result: [] });
      }

      return response({ result: "OK" });
    }

    if (
      value.includes(
        "/api/rank?mode=screener"
      )
    ) {
      return response({
        ok: true,
        watchlist: ["SUI"],
        watchlistDetails: [],
      });
    }

    if (value.includes("/api/quote?coin=")) {
      const coin = new URL(value)
        .searchParams.get("coin");

      if (coin === "BTC") {
        return new Promise(
          (resolve, reject) => {
            const abort = () =>
              reject(
                options.signal.reason ??
                  new DOMException(
                    "Aborted",
                    "AbortError"
                  )
              );

            if (options.signal.aborted) {
              abort();
            } else {
              options.signal.addEventListener(
                "abort",
                abort,
                { once: true }
              );
            }
          }
        );
      }

      return response({
        ok: true,
        live: true,
        price: {
          bid: 99,
          ask: 101,
          mid: 100,
          mark: 100,
          oracle: 100,
        },
        context: {
          funding: 0,
          openInterest: 1000,
          dayNtlVlm: 1_000_000,
        },
        timing: {
          freshnessMs: 0,
        },
      });
    }

    if (
      value.endsWith("/api/persist") ||
      value.endsWith("/api/decision-log")
    ) {
      return response({ ok: true });
    }

    throw new Error(`unexpected fetch ${value}`);
  };

  const { default: handler } =
    await freshImport(
      "api/snapshot.js",
      "quote-timeout"
    );

  const supplied = createHash("sha256")
    .update(token)
    .digest("hex");
  const res = makeRes();

  await handler(
    {
      query: {},
      headers: {
        "x-snapshot-key": supplied,
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.watchlist.length, 5);
  assert.equal(res.body.savedCount, 4);
  assert.equal(res.body.errors.length, 1);
  assert.equal(res.body.errors[0].coin, "BTC");
  assert.match(
    res.body.errors[0].error,
    /timeout after 25ms/
  );
}

async function verifySnapshotRedisTimeout() {
  const token =
    "qstash-redis-timeout-token";
  process.env.UPSTASH_QSTASH_TOKEN = token;
  process.env.STORAGE_REDIS_REST_URL =
    "https://redis.test";
  process.env.STORAGE_REDIS_REST_TOKEN =
    "test-token";
  process.env.SNAPSHOT_REDIS_TIMEOUT_MS =
    "25";

  globalThis.fetch = async (url, options = {}) => {
    assert.equal(
      String(url),
      "https://redis.test"
    );

    return new Promise((resolve, reject) => {
      const abort = () =>
        reject(
          options.signal.reason ??
            new DOMException(
              "Aborted",
              "AbortError"
            )
        );

      if (options.signal.aborted) {
        abort();
      } else {
        options.signal.addEventListener(
          "abort",
          abort,
          { once: true }
        );
      }
    });
  };

  const { default: handler } =
    await freshImport(
      "api/snapshot.js",
      "redis-timeout"
    );

  const supplied = createHash("sha256")
    .update(token)
    .digest("hex");
  const res = makeRes();
  const startedAt = performance.now();

  await handler(
    {
      query: {},
      headers: {
        "x-snapshot-key": supplied,
      },
    },
    res
  );

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.match(
    res.body.error,
    /Redis timeout after 25ms/
  );
  assert.ok(
    performance.now() - startedAt < 500,
    "snapshot Redis timeout should fail quickly"
  );
}

async function verifySnapshotRedisQuotaSkipsRetry() {
  const token =
    "qstash-redis-quota-token";
  process.env.UPSTASH_QSTASH_TOKEN = token;
  process.env.STORAGE_REDIS_REST_URL =
    "https://redis.test";
  process.env.STORAGE_REDIS_REST_TOKEN =
    "test-token";

  let redisCalls = 0;

  globalThis.fetch = async (url) => {
    assert.equal(
      String(url),
      "https://redis.test"
    );
    redisCalls += 1;

    return new Response(
      JSON.stringify({
        error:
          "ERR max requests limit exceeded. Limit: 500000, Usage: 500000.",
      }),
      {
        status: 400,
        headers: {
          "content-type":
            "application/json",
        },
      }
    );
  };

  const { default: handler } =
    await freshImport(
      "api/snapshot.js",
      "redis-quota"
    );

  const supplied = createHash("sha256")
    .update(token)
    .digest("hex");
  const res = makeRes();

  await handler(
    {
      query: {},
      headers: {
        "x-snapshot-key": supplied,
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.skipped, true);
  assert.equal(res.body.retryable, false);
  assert.equal(
    res.body.reason,
    "redis_quota_exhausted"
  );
  assert.match(
    res.body.error,
    /max requests limit exceeded/
  );
  assert.equal(redisCalls, 1);
}

async function verifyPersistRedisTimeout() {
  process.env.STORAGE_REDIS_REST_URL =
    "https://redis.test";
  process.env.STORAGE_REDIS_REST_TOKEN =
    "test-token";
  process.env.PERSIST_REDIS_TIMEOUT_MS =
    "25";

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);

    if (
      value.endsWith("/api/rank")
    ) {
      return response({
        ok: true,
        ranking: [
          {
            coin: "SUI",
            bias: "LONG",
            compositeScore: 0.8,
            confidence: 80,
            opportunity: 0.7,
            threshold: 0.68,
          },
        ],
      });
    }

    assert.equal(
      value,
      "https://redis.test"
    );

    return new Promise((resolve, reject) => {
      const abort = () =>
        reject(
          options.signal.reason ??
            new DOMException(
              "Aborted",
              "AbortError"
            )
        );

      if (options.signal.aborted) {
        abort();
      } else {
        options.signal.addEventListener(
          "abort",
          abort,
          { once: true }
        );
      }
    });
  };

  const { default: handler } =
    await freshImport(
      "api/persist.js",
      "redis-timeout"
    );
  const res = makeRes();
  const startedAt = performance.now();

  await handler(
    {
      query: {},
      headers: {},
    },
    res
  );

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.match(
    res.body.error,
    /Redis timeout after 25ms/
  );
  assert.ok(
    performance.now() - startedAt < 500,
    "persist should not wait indefinitely for Redis"
  );
}

async function verifySignalRateLimitRecovery() {
  process.env.SIGNAL_RETRY_BASE_MS = "1";

  let bookAttempts = 0;
  let alwaysRateLimited = false;
  let retryJitterCalls = 0;
  const starts = [];

  Math.random = () => {
    retryJitterCalls += 1;
    return 0.5;
  };

  globalThis.fetch = async (url, options = {}) => {
    assert.equal(
      String(url),
      "https://api.hyperliquid.xyz/info"
    );
    starts.push(performance.now());

    const payload = JSON.parse(options.body);

    if (payload.type === "metaAndAssetCtxs") {
      return response([
        {
          universe: [
            {
              name: "SUI",
            },
          ],
        },
        [
          {
            markPx: "1",
            oraclePx: "1",
            funding: "0",
            openInterest: "1",
            dayNtlVlm: "1",
            premium: "0",
          },
        ],
      ]);
    }

    if (payload.type === "l2Book") {
      bookAttempts += 1;

      if (
        alwaysRateLimited ||
        bookAttempts <= 2
      ) {
        return response(null, 429);
      }

      return response({
        levels: [
          [
            {
              px: "0.99",
              sz: "10",
            },
          ],
          [
            {
              px: "1.01",
              sz: "10",
            },
          ],
        ],
        time: Date.now(),
      });
    }

    if (payload.type === "candleSnapshot") {
      return response([
        {
          t: Date.now(),
          o: "1",
          c: "1",
          h: "1",
          l: "1",
          v: "1",
        },
      ]);
    }

    throw new Error(
      `unexpected payload ${JSON.stringify(payload)}`
    );
  };

  const { default: handler } =
    await freshImport(
      "api/signal.js",
      "rate-limit-recovery"
    );

  const recovered = makeRes();
  await handler(
    {
      url: "/api/signal?coin=SUI",
    },
    recovered
  );

  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.body.ok, true);
  assert.equal(recovered.body.live, true);
  assert.equal(bookAttempts, 3);

  const gaps = starts
    .slice(1)
    .map(
      (start, index) =>
        start - starts[index]
    );
  assert.ok(
    Math.min(...gaps) >= 199.5,
    `minimum signal API start gap was ${Math.min(...gaps)}ms`
  );

  alwaysRateLimited = true;
  bookAttempts = 0;

  const exhausted = makeRes();
  const signalLogs = [];
  const previousConsoleError =
    console.error;

  console.error = (message) => {
    signalLogs.push(String(message));
  };

  try {
    await handler(
      {
        url: "/api/signal?coin=SUI",
      },
      exhausted
    );
  } finally {
    console.error = previousConsoleError;
  }

  assert.equal(exhausted.statusCode, 500);
  assert.equal(exhausted.body.ok, false);
  assert.equal(bookAttempts, 5);
  assert.equal(retryJitterCalls, 6);
  assert.match(
    exhausted.body.error,
    /HL 429/
  );

  assert.equal(signalLogs.length, 1);
  const signalLog =
    JSON.parse(signalLogs[0]);
  assert.deepEqual(
    {
      level: signalLog.level,
      event: signalLog.event,
      route: signalLog.route,
      coin: signalLog.coin,
    },
    {
      level: "error",
      event: "signal_failed",
      route: "/api/signal",
      coin: "SUI",
    }
  );
  assert.match(signalLog.error, /HL 429/);
  assert.ok(signalLog.durationMs >= 0);
}

async function verifySignalSingleCandleSnapshot() {
  process.env.SIGNAL_RETRY_BASE_MS = "1";

  let candleCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    assert.equal(
      String(url),
      "https://api.hyperliquid.xyz/info"
    );

    const payload = JSON.parse(options.body);

    if (payload.type === "metaAndAssetCtxs") {
      return response([
        {
          universe: [{ name: "SUI" }],
        },
        [
          {
            markPx: "1",
            oraclePx: "1",
            funding: "0",
            openInterest: "1",
            dayNtlVlm: "1",
            premium: "0",
          },
        ],
      ]);
    }

    if (payload.type === "l2Book") {
      return response({
        levels: [
          [{ px: "0.99", sz: "10" }],
          [{ px: "1.01", sz: "10" }],
        ],
        time: Date.now(),
      });
    }

    if (payload.type === "candleSnapshot") {
      candleCalls += 1;
      const endTime = payload.req.endTime;

      assert.equal(payload.req.interval, "1m");
      assert.equal(
        endTime - payload.req.startTime,
        62 * 60_000
      );

      return response([
        {
          t: endTime - 50 * 60_000,
          o: "1",
          c: "2",
          h: "2",
          l: "1",
          v: "1",
        },
        {
          t: endTime - 10 * 60_000,
          o: "2",
          c: "3",
          h: "3",
          l: "2",
          v: "2",
        },
        {
          t: endTime - 2 * 60_000,
          o: "3",
          c: "4",
          h: "4",
          l: "3",
          v: "3",
        },
      ]);
    }

    throw new Error(
      `unexpected payload ${JSON.stringify(payload)}`
    );
  };

  const { default: handler } =
    await freshImport(
      "api/signal.js",
      "single-candle-snapshot"
    );

  const res = makeRes();
  await handler(
    {
      url: "/api/signal?coin=SUI",
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(candleCalls, 1);
  assert.equal(res.body.momentum.m5.count, 1);
  assert.equal(res.body.momentum.m15.count, 2);
  assert.equal(res.body.momentum.m60.count, 3);
  assert.equal(res.body.momentum.m5.open, 3);
  assert.equal(res.body.momentum.m15.open, 2);
  assert.equal(res.body.momentum.m60.open, 1);
  assert.equal(res.body.momentum.m60.close, 4);
  assert.equal(res.body.momentum.m60.volume, 6);
}

async function verifySignalMarketMetadataCache() {
  const calls = {
    nativeMeta: 0,
    perpDexs: 0,
    dexMeta: 0,
    l2Book: 0,
    candleSnapshot: 0,
  };

  globalThis.fetch = async (url, options = {}) => {
    assert.equal(
      String(url),
      "https://api.hyperliquid.xyz/info"
    );

    const payload = JSON.parse(options.body);

    if (payload.type === "metaAndAssetCtxs") {
      if (!payload.dex) {
        calls.nativeMeta += 1;
        return response([
          { universe: [] },
          [],
        ]);
      }

      calls.dexMeta += 1;
      assert.equal(payload.dex, "xyz");

      return response([
        {
          universe: [
            { name: "xyz:MU" },
            { name: "xyz:DRAM" },
          ],
        },
        [
          {
            markPx: "100",
            oraclePx: "100",
            funding: "0",
            openInterest: "1",
            dayNtlVlm: "1",
            premium: "0",
          },
          {
            markPx: "200",
            oraclePx: "200",
            funding: "0",
            openInterest: "1",
            dayNtlVlm: "1",
            premium: "0",
          },
        ],
      ]);
    }

    if (payload.type === "perpDexs") {
      calls.perpDexs += 1;
      return response(["xyz"]);
    }

    if (payload.type === "l2Book") {
      calls.l2Book += 1;
      return response({
        levels: [
          [{ px: "99", sz: "10" }],
          [{ px: "101", sz: "10" }],
        ],
        time: Date.now(),
      });
    }

    if (payload.type === "candleSnapshot") {
      calls.candleSnapshot += 1;
      return response([
        {
          t: payload.req.endTime,
          o: "100",
          c: "100",
          h: "100",
          l: "100",
          v: "1",
        },
      ]);
    }

    throw new Error(
      `unexpected payload ${JSON.stringify(payload)}`
    );
  };

  const { default: handler } =
    await freshImport(
      "api/signal.js",
      "market-metadata-cache"
    );

  const mu = makeRes();
  const dram = makeRes();

  await Promise.all([
    handler(
      { url: "/api/signal?coin=xyz:MU" },
      mu
    ),
    handler(
      { url: "/api/signal?coin=xyz:DRAM" },
      dram
    ),
  ]);

  assert.equal(mu.statusCode, 200);
  assert.equal(dram.statusCode, 200);
  assert.equal(mu.body.live, true);
  assert.equal(dram.body.live, true);
  assert.equal(calls.nativeMeta, 1);
  assert.equal(calls.perpDexs, 1);
  assert.equal(calls.dexMeta, 1);
  assert.equal(calls.l2Book, 2);
  assert.equal(calls.candleSnapshot, 2);

  const repeated = makeRes();

  await handler(
    { url: "/api/signal?coin=xyz:MU" },
    repeated
  );

  assert.equal(repeated.statusCode, 200);
  assert.equal(calls.nativeMeta, 1);
  assert.equal(calls.perpDexs, 1);
  assert.equal(calls.dexMeta, 1);
  assert.equal(calls.l2Book, 3);
  assert.equal(calls.candleSnapshot, 3);
}

async function verifySignalUpstreamTimeout() {
  process.env.SIGNAL_API_TIMEOUT_MS = "25";

  globalThis.fetch = async (url, options = {}) => {
    assert.equal(
      String(url),
      "https://api.hyperliquid.xyz/info"
    );

    return new Promise((resolve, reject) => {
      const abort = () =>
        reject(
          options.signal.reason ??
            new DOMException(
              "Aborted",
              "AbortError"
            )
        );

      if (options.signal.aborted) {
        abort();
      } else {
        options.signal.addEventListener(
          "abort",
          abort,
          { once: true }
        );
      }
    });
  };

  const { default: handler } =
    await freshImport(
      "api/signal.js",
      "upstream-timeout"
    );

  const signalLogs = [];
  const previousConsoleError =
    console.error;
  const startedAt = performance.now();
  const res = makeRes();

  console.error = (message) => {
    signalLogs.push(String(message));
  };

  try {
    await handler(
      { url: "/api/signal?coin=SUI" },
      res
    );
  } finally {
    console.error = previousConsoleError;
  }

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.match(
    res.body.error,
    /HL timeout after 25ms/
  );
  assert.ok(
    performance.now() - startedAt < 500,
    "signal timeout should fail promptly"
  );
  assert.equal(signalLogs.length, 1);
  assert.match(
    JSON.parse(signalLogs[0]).error,
    /HL timeout after 25ms/
  );
}

async function verifyIntelFailureLogging() {
  globalThis.fetch = async () =>
    response(
      {
        ok: false,
        error: "upstream unavailable",
      },
      503
    );

  const { default: handler } =
    await freshImport(
      "api/intel.js",
      "failure-logging"
    );

  const intelLogs = [];
  const previousConsoleError =
    console.error;
  const res = makeRes();

  console.error = (message) => {
    intelLogs.push(String(message));
  };

  try {
    await handler(
      {
        query: {
          coin: "SUI",
        },
      },
      res
    );
  } finally {
    console.error = previousConsoleError;
  }

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.equal(intelLogs.length, 1);

  const intelLog =
    JSON.parse(intelLogs[0]);
  assert.deepEqual(
    {
      level: intelLog.level,
      event: intelLog.event,
      route: intelLog.route,
      coin: intelLog.coin,
    },
    {
      level: "error",
      event: "intel_failed",
      route: "/api/intel",
      coin: "SUI",
    }
  );
  assert.match(intelLog.error, /503/);
  assert.ok(intelLog.durationMs >= 0);
}

async function verifyIntelRedisQuotaFallback() {
  let signalCalls = 0;
  let historyCalls = 0;

  globalThis.fetch = async (url) => {
    const value = String(url);

    if (value.includes("/api/signal?coin=SUI")) {
      signalCalls += 1;
      return response({
        ok: true,
        live: true,
        market: { coin: "SUI" },
        price: {
          bid: 0.99,
          ask: 1.01,
          mid: 1,
        },
        context: {},
        orderBook: {
          top5: { imbalance: 0.1 },
        },
        momentum: {},
        timing: { freshnessMs: 0 },
      });
    }

    if (value.includes("/api/history?coin=SUI")) {
      historyCalls += 1;
      return response(
        {
          ok: false,
          error:
            "ERR max requests limit exceeded. Limit: 500000, Usage: 500000",
        },
        500
      );
    }

    throw new Error(`unexpected fetch ${value}`);
  };

  const { default: handler } =
    await freshImport(
      "api/intel.js",
      "redis-quota-fallback"
    );

  const warnings = [];
  const previousConsoleWarn = console.warn;
  const res = makeRes();
  const repeatedRes = makeRes();

  console.warn = (message) => {
    warnings.push(String(message));
  };

  try {
    await handler(
      {
        query: {
          coin: "SUI",
        },
      },
      res
    );

    await handler(
      {
        query: {
          coin: "SUI",
        },
      },
      repeatedRes
    );
  } finally {
    console.warn = previousConsoleWarn;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.live.valid, true);
  assert.equal(res.body.history.ready, false);
  assert.equal(res.body.analysis.bias, "WAIT");
  assert.equal(res.body.quality.historyAvailable, false);
  assert.equal(res.body.quality.full60mReady, false);
  assert.equal(res.body.quality.historyDegraded, true);
  assert.match(
    res.body.quality.historyError,
    /max requests limit exceeded/
  );
  assert.equal(repeatedRes.statusCode, 200);
  assert.equal(
    repeatedRes.body.analysis.bias,
    "WAIT"
  );
  assert.equal(
    repeatedRes.body.quality.historyDegraded,
    true
  );
  assert.equal(signalCalls, 2);
  assert.equal(historyCalls, 1);
  assert.equal(warnings.length, 2);

  const warning = JSON.parse(warnings[0]);
  assert.deepEqual(
    {
      level: warning.level,
      event: warning.event,
      route: warning.route,
      coin: warning.coin,
    },
    {
      level: "warning",
      event: "intel_history_degraded",
      route: "/api/intel",
      coin: "SUI",
    }
  );
  assert.equal(
    JSON.parse(warnings[1])
      .quotaCircuitOpen,
    true
  );
}

async function verifyIntelInternalTimeout() {
  process.env.INTEL_API_TIMEOUT_MS = "25";

  globalThis.fetch = async (
    _url,
    options = {}
  ) =>
    new Promise((_, reject) => {
      options.signal.addEventListener(
        "abort",
        () =>
          reject(
            new DOMException(
              "aborted",
              "AbortError"
            )
          ),
        { once: true }
      );
    });

  const { default: handler } =
    await freshImport(
      "api/intel.js",
      "internal-timeout"
    );
  const res = makeRes();
  const startedAt = performance.now();
  const previousConsoleError =
    console.error;

  console.error = () => {};

  try {
    await handler(
      {
        query: {
          coin: "SUI",
        },
      },
      res
    );
  } finally {
    console.error = previousConsoleError;
  }

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.match(
    res.body.error,
    /timeout after 25ms/
  );
  assert.ok(
    performance.now() - startedAt < 500,
    "intel should not wait indefinitely for stalled internal APIs"
  );
}

async function verifyHistoryRedisTimeout() {
  process.env.STORAGE_REDIS_REST_URL =
    "https://redis.test";
  process.env.STORAGE_REDIS_REST_TOKEN =
    "test-token";
  process.env.HISTORY_REDIS_TIMEOUT_MS = "25";

  globalThis.fetch = async (
    _url,
    options = {}
  ) =>
    new Promise((_, reject) => {
      options.signal.addEventListener(
        "abort",
        () =>
          reject(
            new DOMException(
              "aborted",
              "AbortError"
            )
          ),
        { once: true }
      );
    });

  const { default: handler } =
    await freshImport(
      "api/history.js",
      "redis-timeout"
    );
  const res = makeRes();
  const startedAt = performance.now();

  await handler(
    {
      url: "/api/history?coin=SUI",
    },
    res
  );

  assert.equal(res.statusCode, 500);
  assert.match(
    res.body.error,
    /Redis timeout after 25ms/
  );
  assert.ok(
    performance.now() - startedAt < 500,
    "history should not wait indefinitely for Redis"
  );
}

async function verifyHistoryDexMarketKey() {
  process.env.STORAGE_REDIS_REST_URL =
    "https://redis.test";
  process.env.STORAGE_REDIS_REST_TOKEN =
    "test-token";

  let requestedKey = null;

  globalThis.fetch = async (
    url,
    options = {}
  ) => {
    assert.equal(
      String(url),
      "https://redis.test"
    );

    const command = JSON.parse(options.body);
    assert.equal(command[0], "ZRANGEBYSCORE");
    requestedKey = command[1];

    return response({ result: [] });
  };

  const { default: handler } =
    await freshImport(
      "api/history.js",
      "dex-market-key"
    );
  const res = makeRes();

  await handler(
    {
      url: "/api/history?coin=XYZ%3Amu",
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.coin, "xyz:MU");
  assert.equal(requestedKey, "hl:snap:xyz:MU");
}

async function verifyDecisionLogRedisTimeout() {
  process.env.STORAGE_REDIS_REST_URL =
    "https://redis.test";
  process.env.STORAGE_REDIS_REST_TOKEN =
    "test-token";
  process.env.DECISION_LOG_REDIS_TIMEOUT_MS =
    "25";

  globalThis.fetch = async (
    _url,
    options = {}
  ) =>
    new Promise((_, reject) => {
      options.signal.addEventListener(
        "abort",
        () =>
          reject(
            new DOMException(
              "aborted",
              "AbortError"
            )
          ),
        { once: true }
      );
    });

  const { default: handler } =
    await freshImport(
      "api/decision-log.js",
      "redis-timeout"
    );
  const res = makeRes();
  const startedAt = performance.now();

  await handler(
    {
      url: "/api/decision-log",
    },
    res
  );

  assert.equal(res.statusCode, 500);
  assert.match(
    res.body.error,
    /Redis timeout after 25ms/
  );
  assert.ok(
    performance.now() - startedAt < 500,
    "decision log should not wait indefinitely for Redis"
  );
}

function decisionLogRows() {
  const now = Date.now();

  return [0.62, 0.71, 0.84].map(
    (compositeScore, index) =>
      JSON.stringify({
        t:
          now -
          (2 - index) *
            5 * 60 * 1000,
        coin: "BTC",
        bias: "LONG",
        compositeScore,
        confidence: 80,
        opportunity: 0.75,
        executionQuality: {
          score: 0.9,
        },
        volatility: {
          baselinePct: 0.3,
          observedPct: 0.25,
        },
        marketSnapshot: {
          price: {
            bid: 99.9,
            ask: 100.1,
            mid: 100,
            spreadBps: 20,
          },
          momentum: {
            m5: null,
            m15: null,
            m60: null,
          },
        },
        reasons: [],
      })
  );
}

async function verifyFuturesRiskGate() {
  process.env.STORAGE_REDIS_REST_URL =
    "https://redis.test";
  process.env.STORAGE_REDIS_REST_TOKEN =
    "test-token";

  let savedRecord = null;

  globalThis.fetch = async (
    url,
    options = {}
  ) => {
    assert.equal(
      String(url),
      "https://redis.test"
    );

    const command =
      JSON.parse(options.body);

    if (
      command[0] ===
      "ZRANGEBYSCORE"
    ) {
      return response({
        result:
          command[1] ===
          "hl:rank:BTC"
            ? decisionLogRows()
            : [],
      });
    }

    if (command[0] === "ZADD") {
      savedRecord = JSON.parse(
        command[3]
      );
      return response({ result: 1 });
    }

    assert.equal(
      command[0],
      "ZREMRANGEBYSCORE"
    );
    return response({ result: 0 });
  };

  const { default: handler } =
    await freshImport(
      "api/decision-log.js",
      "futures-risk-gate"
    );

  const blockedRes = makeRes();
  await handler(
    {
      url: "/api/decision-log",
    },
    blockedRes
  );

  assert.equal(
    blockedRes.statusCode,
    200
  );
  assert.equal(
    blockedRes.body.saved.tradeAllowed,
    false
  );
  assert.equal(
    blockedRes.body.saved.reason,
    "futures_risk_gate_blocked"
  );
  assert.equal(
    blockedRes.body.saved.plans.length,
    1,
    "signal plan should remain available for backward compatibility"
  );

  const blocked =
    blockedRes.body.saved
      .orderCandidates[0];
  assert.equal(blocked.status, "BLOCK");
  assert.equal(
    blocked.positionBucket,
    "futures:BTC"
  );
  assert.deepEqual(
    Object.keys(blocked).filter(
      (key) =>
        [
          "entry",
          "stop",
          "stopDistancePct",
          "notionalUsd",
          "marginUsd",
          "leverage",
          "maxLossUsd",
          "timeStop",
          "positionBucket",
        ].includes(key)
    ).sort(),
    [
      "entry",
      "leverage",
      "marginUsd",
      "maxLossUsd",
      "notionalUsd",
      "positionBucket",
      "stop",
      "stopDistancePct",
      "timeStop",
    ]
  );
  for (const key of [
    "entry",
    "stop",
    "stopDistancePct",
    "notionalUsd",
    "marginUsd",
    "leverage",
    "maxLossUsd",
  ]) {
    assert.equal(
      Number.isFinite(blocked[key]),
      true,
      `${key} must be a finite number`
    );
  }
  assert.equal(
    typeof blocked.timeStop,
    "string"
  );
  assert.ok(
    blocked.blockReasons.includes(
      "account_balance_unknown"
    )
  );
  assert.ok(
    blocked.blockReasons.includes(
      "current_price_unconfirmed"
    )
  );
  assert.ok(
    blocked.blockReasons.includes(
      "daily_loss_unknown"
    )
  );
  assert.ok(
    blocked.blockReasons.includes(
      "open_futures_positions_unknown"
    )
  );
  assert.ok(
    blocked.blockReasons.includes(
      "recent_futures_exits_unknown"
    )
  );
  assert.equal(
    savedRecord.tradeAllowed,
    false
  );

  const safeRes = makeRes();
  await handler(
    {
      url: "/api/decision-log",
      body: {
        riskContext: {
          accountBalanceUsd: 50000,
          dailyLossUsd: 0,
          currentPrices: {
            BTC: {
              price: 100,
              asOf: Date.now(),
            },
          },
          openFuturesPositions: [],
          recentFuturesExits: [],
        },
      },
    },
    safeRes
  );

  assert.equal(
    safeRes.body.saved.tradeAllowed,
    true
  );
  assert.equal(
    safeRes.body.saved
      .orderCandidates[0].status,
    "ELIGIBLE"
  );

  const losingAddRes = makeRes();
  await handler(
    {
      url: "/api/decision-log",
      body: {
        riskContext: {
          accountBalanceUsd: 50000,
          dailyLossUsd: 0,
          currentPrices: {
            BTC: {
              price: 100,
              asOf: Date.now(),
            },
          },
          openFuturesPositions: [
            {
              coin: "BTC",
              side: "LONG",
              marginUsd: 4800,
              unrealizedPnlUsd: -10,
              positionBucket:
                "futures:BTC",
            },
          ],
          recentFuturesExits: [],
        },
      },
    },
    losingAddRes
  );

  const losingAdd =
    losingAddRes.body.saved
      .orderCandidates[0];
  assert.equal(losingAdd.status, "BLOCK");
  assert.ok(
    losingAdd.blockReasons.includes(
      "adding_to_losing_position"
    )
  );
  assert.ok(
    losingAdd.blockReasons.includes(
      "coin_margin_limit_exceeded"
    )
  );

  const reversalRes = makeRes();
  await handler(
    {
      url: "/api/decision-log",
      body: {
        riskContext: {
          accountBalanceUsd: 1000,
          dailyLossUsd: 40,
          currentPrices: {
            BTC: {
              price: 100,
              asOf: Date.now(),
            },
          },
          openFuturesPositions: [],
          recentFuturesExits: [
            {
              coin: "BTC",
              side: "SHORT",
              exitedAt:
                Date.now() -
                30 * 60 * 1000,
              sameFourHourCandle: true,
              nextFourHourCloseConfirmed:
                false,
              newRationaleConfirmed:
                false,
              positionBucket:
                "futures:BTC",
            },
          ],
        },
      },
    },
    reversalRes
  );

  const reversal =
    reversalRes.body.saved
      .orderCandidates[0];
  assert.equal(reversal.status, "BLOCK");

  for (const reason of [
    "max_loss_exceeds_account_2pct",
    "daily_loss_limit_reached",
    "same_4h_candle_reversal",
    "reversal_flat_hour_incomplete",
    "reversal_4h_close_unconfirmed",
    "reversal_rationale_unconfirmed",
  ]) {
    assert.ok(
      reversal.blockReasons.includes(
        reason
      ),
      `missing risk gate reason ${reason}`
    );
  }
}

async function verifyQuoteUpstreamTimeout() {
  process.env.QUOTE_API_TIMEOUT_MS = "25";

  globalThis.fetch = async (
    _url,
    options = {}
  ) =>
    new Promise((_, reject) => {
      options.signal.addEventListener(
        "abort",
        () =>
          reject(
            new DOMException(
              "aborted",
              "AbortError"
            )
          ),
        { once: true }
      );
    });

  const { default: handler } =
    await freshImport(
      "api/quote.js",
      "upstream-timeout"
    );
  const res = makeRes();
  const startedAt = performance.now();

  await handler(
    {
      url: "/api/quote?coin=SUI",
    },
    res
  );

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.live, false);
  assert.match(
    res.body.error,
    /quote API timeout after 25ms/
  );
  assert.ok(
    performance.now() - startedAt < 500,
    "quote should not wait indefinitely for a stalled upstream"
  );
}

async function verifyQuoteRateLimitRecovery() {
  process.env.QUOTE_RETRY_BASE_MS = "1";

  let nativeMetaAttempts = 0;
  let fetchCalls = 0;

  globalThis.fetch = async (
    url,
    options = {}
  ) => {
    assert.equal(
      String(url),
      "https://api.hyperliquid.xyz/info"
    );

    fetchCalls += 1;
    const payload = JSON.parse(options.body);

    if (payload.type === "metaAndAssetCtxs") {
      nativeMetaAttempts += 1;

      if (nativeMetaAttempts <= 4) {
        return new Response(
          JSON.stringify({ error: "rate limited" }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "0",
            },
          }
        );
      }

      return response([
        { universe: [{ name: "SUI" }] },
        [
          {
            markPx: "1",
            oraclePx: "1",
            funding: "0",
            openInterest: "1",
            dayNtlVlm: "1",
            premium: "0",
          },
        ],
      ]);
    }

    if (payload.type === "allMids") {
      return response({ SUI: "1" });
    }

    if (payload.type === "l2Book") {
      return response({
        levels: [
          [{ px: "0.99", sz: "10" }],
          [{ px: "1.01", sz: "10" }],
        ],
        time: Date.now(),
      });
    }

    throw new Error(
      `unexpected payload ${JSON.stringify(payload)}`
    );
  };

  const { default: handler } =
    await freshImport(
      "api/quote.js",
      "rate-limit-recovery"
    );
  const res = makeRes();

  await handler(
    {
      url: "/api/quote?coin=SUI",
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.live, true);
  assert.equal(nativeMetaAttempts, 5);
  assert.equal(fetchCalls, 7);
}

function makeIntel(coin) {
  const window = {
    ready: true,
    pricePct: 1,
    oiPct: 0.1,
    fundingDelta: 0,
  };

  return {
    coin,
    live: {
      price: {
        bid: 99.99,
        ask: 100.01,
        mid: 100,
        spreadBps: 2,
      },
      context: {
        funding: 0,
        openInterest: 100_000,
        dayNtlVlm: 100_000_000,
      },
      orderBook: {
        top5: {
          imbalance: 0.2,
        },
        top20: {
          imbalance: 0.1,
          bidSize: 10_000,
          askSize: 10_000,
        },
      },
      momentum: {
        m5: { returnPct: 1 },
        m15: { returnPct: 1 },
        m60: { returnPct: 1 },
      },
    },
    history: {
      windows: {
        m5: window,
        m15: window,
        m60: window,
      },
    },
    quality: {
      liveFresh: true,
      historyAvailable: true,
      full60mReady: true,
      historyAgeMs: 0,
    },
  };
}

async function verifyRankPersistenceSingleBatch() {
  const coins = Array.from(
    { length: 18 },
    (_, index) => `C${index}`
  );
  const universe = coins.map(
    (name) => ({
      name,
      maxLeverage: 10,
    })
  );
  const ctxs = coins.map(
    (_, index) => ({
      markPx: String(100 + index),
      openInterest: "100000",
      dayNtlVlm:
        String(
          100_000_000 +
          index * 1_000_000
        ),
      funding: "0",
    })
  );

  let persistenceCalls = 0;
  let intelCalls = 0;
  let upstreamActive = 0;
  let upstreamMaxActive = 0;
  const starts = [];
  const dexesSeen = new Set();
  const providedScores = new Map();

  globalThis.fetch = async (url, options = {}) => {
    starts.push(performance.now());
    upstreamActive += 1;
    upstreamMaxActive = Math.max(
      upstreamMaxActive,
      upstreamActive
    );
    await new Promise(
      (resolve) =>
        setTimeout(resolve, 350)
    );
    const value = String(url);

    try {
      if (
        value ===
        "https://api.hyperliquid.xyz/info"
      ) {
        const payload =
          JSON.parse(options.body);

        if (
          payload.type ===
          "metaAndAssetCtxs"
        ) {
          if (payload.dex) {
            dexesSeen.add(payload.dex);
          }

          return response(
            payload.dex
              ? [
                  { universe: [] },
                  [],
                ]
              : [
                  { universe },
                  ctxs,
                ]
          );
        }

        if (payload.type === "perpDexs") {
          return response([
            "abc",
            "def",
          ]);
        }
      }

      if (
        value.includes(
          "/api/persistence?mode=watchrank&coins="
        )
      ) {
        persistenceCalls += 1;
        const requested =
          new URL(value)
            .searchParams.get("coins")
            .split(",");
        assert.equal(requested.length, 18);

        return response({
          ok: true,
          ranking:
            requested.map(
              (coin, index) => {
                const score =
                  0.5 + index * 0.01;
                providedScores.set(
                  coin,
                  score
                );
                return { coin, score };
              }
            ),
        });
      }

      if (value.includes("/api/intel?coin=")) {
        intelCalls += 1;
        const coin = new URL(value)
          .searchParams.get("coin");
        return response(makeIntel(coin));
      }

      throw new Error(`unexpected fetch ${value}`);
    } finally {
      upstreamActive -= 1;
    }
  };

  const { default: handler } =
    await freshImport(
      "api/rank.js",
      "single-batch"
    );
  const res = makeRes();

  await handler(
    {
      url:
        "/api/rank?mode=screener&limit=18",
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(
    res.body.methodology.deepChecked,
    18
  );
  assert.equal(res.body.watchlist.length, 18);
  assert.ok(res.body.candidates.length <= 3);
  assert.equal(persistenceCalls, 1);
  assert.equal(intelCalls, 18);
  assert.equal(upstreamMaxActive, 2);
  assert.deepEqual(
    [...dexesSeen].sort(),
    ["abc", "def", "xyz"]
  );
  assert.equal(
    res.body.universe.dexesChecked,
    3
  );

  for (const row of res.body.top10) {
    assert.equal(
      row.persistenceScore,
      providedScores.get(row.coin)
    );
  }

  const gaps = starts
    .slice(1)
    .map(
      (start, index) =>
        start - starts[index]
    );
  assert.ok(
    Math.min(...gaps) >= 199.5,
    `minimum API start gap was ${Math.min(...gaps)}ms`
  );
}

async function verifyRankUpstreamTimeout() {
  process.env.RANK_API_TIMEOUT_MS = "25";

  globalThis.fetch = async (
    _url,
    options = {}
  ) =>
    new Promise((_, reject) => {
      options.signal.addEventListener(
        "abort",
        () =>
          reject(
            new DOMException(
              "aborted",
              "AbortError"
            )
          ),
        { once: true }
      );
    });

  const { default: handler } =
    await freshImport(
      "api/rank.js",
      "upstream-timeout"
    );
  const res = makeRes();
  const startedAt = performance.now();

  await handler(
    {
      url: "/api/rank?mode=universe",
    },
    res
  );

  assert.equal(res.statusCode, 500);
  assert.match(
    res.body.error,
    /rank API timeout after 25ms/
  );
  assert.ok(
    performance.now() - startedAt < 500,
    "rank should not wait indefinitely for a stalled upstream"
  );
}

test(
  "daytrade efficiency invariants",
  async () => {
    const previousFetch =
      globalThis.fetch;
    const previousRandom =
      Math.random;

    try {
      await verifyRuntimeCompatibilityPin();
      await verifyPersistenceBatch();
      await verifyPersistenceRedisTimeout();
      await verifySnapshotCoverageAndConcurrency();
      await verifySnapshotLockSkipsDownstreamWork();
      await verifySnapshotRankTimeout();
      await verifySnapshotQuoteTimeout();
      await verifySnapshotRedisTimeout();
      await verifySnapshotRedisQuotaSkipsRetry();
      await verifyPersistRedisTimeout();
      await verifySignalRateLimitRecovery();
      await verifySignalSingleCandleSnapshot();
      await verifySignalMarketMetadataCache();
      await verifySignalUpstreamTimeout();
      await verifyIntelFailureLogging();
      await verifyIntelRedisQuotaFallback();
      await verifyIntelInternalTimeout();
      await verifyHistoryRedisTimeout();
      await verifyHistoryDexMarketKey();
      await verifyDecisionLogRedisTimeout();
      await verifyFuturesRiskGate();
      await verifyQuoteUpstreamTimeout();
      await verifyQuoteRateLimitRecovery();
      await verifyRankPersistenceSingleBatch();
      await verifyRankUpstreamTimeout();
    } finally {
      globalThis.fetch = previousFetch;
      Math.random = previousRandom;
      delete process.env.UPSTASH_QSTASH_TOKEN;
      delete process.env.STORAGE_REDIS_REST_URL;
      delete process.env.STORAGE_REDIS_REST_TOKEN;
      delete process.env.SNAPSHOT_RANK_TIMEOUT_MS;
      delete process.env.SNAPSHOT_QUOTE_TIMEOUT_MS;
      delete process.env.SNAPSHOT_REDIS_TIMEOUT_MS;
      delete process.env.PERSIST_REDIS_TIMEOUT_MS;
      delete process.env.SIGNAL_RETRY_BASE_MS;
      delete process.env.SIGNAL_API_TIMEOUT_MS;
      delete process.env.RANK_API_TIMEOUT_MS;
      delete process.env.INTEL_API_TIMEOUT_MS;
      delete process.env.HISTORY_REDIS_TIMEOUT_MS;
      delete process.env.DECISION_LOG_REDIS_TIMEOUT_MS;
      delete process.env.QUOTE_API_TIMEOUT_MS;
      delete process.env.QUOTE_RETRY_BASE_MS;
      delete process.env.PERSISTENCE_REDIS_TIMEOUT_MS;
    }
  }
);

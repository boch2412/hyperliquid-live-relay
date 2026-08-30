import test from "node:test";
import assert from "node:assert/strict";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

const ROOT = resolve(
  dirname(
    fileURLToPath(import.meta.url)
  ),
  ".."
);

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

test(
  "daytrade efficiency invariants",
  async () => {
    const previousFetch =
      globalThis.fetch;

    try {
      await verifyPersistenceBatch();
      await verifySnapshotCoverageAndConcurrency();
      await verifyRankPersistenceSingleBatch();
    } finally {
      globalThis.fetch = previousFetch;
      delete process.env.UPSTASH_QSTASH_TOKEN;
      delete process.env.STORAGE_REDIS_REST_URL;
      delete process.env.STORAGE_REDIS_REST_TOKEN;
    }
  }
);

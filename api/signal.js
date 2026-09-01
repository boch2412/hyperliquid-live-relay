const HL_INFO = "https://api.hyperliquid.xyz/info";
const FRESH_MS = 10_000;

const API_CONCURRENCY = 2;
const API_START_INTERVAL_MS = 200;
const MAX_429_RETRIES = 4;
const RETRY_BASE_MS = Math.max(
  1,
  Number(
    process.env.SIGNAL_RETRY_BASE_MS
  ) || 500
);

let apiActive = 0;
let apiNextStartAt = 0;
let apiDrainTimer = null;

const apiQueue = [];

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

function apiClockMs() {
  if (
    typeof performance !==
      "undefined" &&
    typeof performance.now ===
      "function"
  ) {
    return performance.now();
  }

  return Date.now();
}

function drainApiQueue() {
  while (
    apiActive < API_CONCURRENCY &&
    apiQueue.length
  ) {
    const waitMs = Math.max(
      0,
      apiNextStartAt -
        apiClockMs()
    );

    if (waitMs > 0) {
      if (apiDrainTimer == null) {
        apiDrainTimer = setTimeout(
          () => {
            apiDrainTimer = null;
            drainApiQueue();
          },
          waitMs
        );
      }

      return;
    }

    const job = apiQueue.shift();

    apiActive += 1;
    let taskPromise;

    try {
      taskPromise =
        Promise.resolve(
          job.task()
        );
    } catch (error) {
      taskPromise =
        Promise.reject(error);
    }

    apiNextStartAt =
      apiClockMs() +
      API_START_INTERVAL_MS;

    taskPromise
      .then(
        job.resolve,
        job.reject
      )
      .finally(() => {
        apiActive -= 1;
        drainApiQueue();
      });
  }
}

function scheduleApiRequest(task) {
  return new Promise(
    (resolve, reject) => {
      apiQueue.push({
        task,
        resolve,
        reject,
      });

      drainApiQueue();
    }
  );
}

function parseRetryAfterMs(value) {
  if (!value) {
    return 0;
  }

  const seconds = Number(value);

  if (
    Number.isFinite(seconds) &&
    seconds >= 0
  ) {
    return seconds * 1000;
  }

  const retryAt = Date.parse(value);

  if (!Number.isFinite(retryAt)) {
    return 0;
  }

  return Math.max(
    0,
    retryAt - Date.now()
  );
}

async function fetchTextWithRateLimit(
  url,
  options
) {
  for (
    let retry = 0;
    retry <= MAX_429_RETRIES;
    retry += 1
  ) {
    const result =
      await scheduleApiRequest(
        async () => {
          const r = await fetch(
            url,
            options
          );

          const text =
            await r.text();

          return {
            ok: r.ok,
            status: r.status,
            text,
            retryAfter:
              r.headers.get(
                "retry-after"
              ),
          };
        }
      );

    if (
      result.status !== 429 ||
      retry >= MAX_429_RETRIES
    ) {
      return result;
    }

    const backoffMs =
      RETRY_BASE_MS *
      2 ** retry;

    const retryAfterMs =
      parseRetryAfterMs(
        result.retryAfter
      );

    await sleep(
      Math.max(
        backoffMs,
        retryAfterMs
      )
    );
  }

  throw new Error(
    "Unreachable API retry state"
  );
}

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function baseName(s) {
  if (!s) return "";
  const x = String(s);
  return x.includes(":") ? x.split(":").pop() : x;
}

function sameCoin(a, b) {
  return baseName(a).toUpperCase() === baseName(b).toUpperCase();
}

function pct(a, b) {
  if (a == null || b == null || b === 0) return null;
  return ((a - b) / b) * 100;
}

function bps(a, b) {
  if (a == null || b == null || b === 0) return null;
  return ((a - b) / b) * 10_000;
}

async function postInfo(payload) {
  const t0 = Date.now();

  const result =
    await fetchTextWithRateLimit(
      HL_INFO,
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      }
    );

  const text = result.text;
  let data = null;

  try {
    data = JSON.parse(text);
  } catch {}

  if (!result.ok) {
    throw new Error(`HL ${result.status}: ${text.slice(0, 200)}`);
  }

  return {
    data,
    latencyMs: Date.now() - t0,
  };
}

function parseMetaCtx(resp) {
  if (!Array.isArray(resp) || resp.length < 2) {
    return { universe: [], ctxs: [] };
  }

  return {
    universe: resp[0]?.universe || [],
    ctxs: Array.isArray(resp[1]) ? resp[1] : [],
  };
}

function dexNames(resp) {
  if (!Array.isArray(resp)) return [];

  return [
    ...new Set(
      resp
        .map((x) => {
          if (typeof x === "string") return x;

          return (
            x?.name ||
            x?.dex ||
            x?.symbol ||
            x?.id ||
            null
          );
        })
        .filter(Boolean)
        .map(String)
    ),
  ];
}

async function resolveMarket(coin) {
  const native = parseMetaCtx(
    (await postInfo({ type: "metaAndAssetCtxs" })).data
  );

  let i = native.universe.findIndex((u) =>
    sameCoin(u?.name, coin)
  );

  if (i >= 0) {
    return {
      dex: "",
      universeIndex: i,
      ctxs: native.ctxs,
      assetName: native.universe[i]?.name,
      bookCoin: baseName(native.universe[i]?.name),
    };
  }

  const dexResp = (
    await postInfo({ type: "perpDexs" })
  ).data;

  const ordered = [
    ...new Set(["xyz", ...dexNames(dexResp)]),
  ].filter(Boolean);

  for (const dex of ordered) {
    try {
      const parsed = parseMetaCtx(
        (
          await postInfo({
            type: "metaAndAssetCtxs",
            dex,
          })
        ).data
      );

      i = parsed.universe.findIndex((u) =>
        sameCoin(u?.name, coin)
      );

      if (i >= 0) {
        const rawName =
          parsed.universe[i]?.name || coin;

        return {
          dex,
          universeIndex: i,
          ctxs: parsed.ctxs,
          assetName: rawName,
          bookCoin: String(rawName).includes(":")
            ? String(rawName)
            : `${dex}:${baseName(rawName)}`,
        };
      }
    } catch {}
  }

  return {
    dex: "",
    universeIndex: -1,
    ctxs: [],
    assetName: coin,
    bookCoin: coin,
  };
}

function parseBook(book) {
  const levels = book?.levels;

  const bids = Array.isArray(levels?.[0])
    ? levels[0]
    : [];

  const asks = Array.isArray(levels?.[1])
    ? levels[1]
    : [];

  const bid = bids.length
    ? num(bids[0]?.px ?? bids[0]?.price)
    : null;

  const ask = asks.length
    ? num(asks[0]?.px ?? asks[0]?.price)
    : null;

  return {
    bids,
    asks,
    bid,
    ask,
    time: num(book?.time),
  };
}

function levelSize(level) {
  return (
    num(
      level?.sz ??
      level?.size ??
      level?.s
    ) ?? 0
  );
}

function depthStats(bids, asks, n = 5) {
  const bidTop = bids
    .slice(0, n)
    .reduce(
      (sum, x) => sum + levelSize(x),
      0
    );

  const askTop = asks
    .slice(0, n)
    .reduce(
      (sum, x) => sum + levelSize(x),
      0
    );

  const denom = bidTop + askTop;

  return {
    levels: n,
    bidSize: bidTop,
    askSize: askTop,

    imbalance:
      denom > 0
        ? (bidTop - askTop) / denom
        : null,
  };
}

function summarizeCandles(candles) {
  if (
    !Array.isArray(candles) ||
    !candles.length
  ) {
    return {
      open: null,
      close: null,
      high: null,
      low: null,
      volume: null,
      returnPct: null,
      count: 0,
    };
  }

  const first = candles[0];
  const last =
    candles[candles.length - 1];

  const open = num(first?.o);
  const close = num(last?.c);

  const highs = candles
    .map((c) => num(c?.h))
    .filter((x) => x != null);

  const lows = candles
    .map((c) => num(c?.l))
    .filter((x) => x != null);

  const volume = candles.reduce(
    (sum, c) =>
      sum + (num(c?.v) ?? 0),
    0
  );

  return {
    open,
    close,

    high: highs.length
      ? Math.max(...highs)
      : null,

    low: lows.length
      ? Math.min(...lows)
      : null,

    volume,

    returnPct:
      pct(close, open),

    count: candles.length,
  };
}

async function candleWindow(
  coin,
  minutes,
  now
) {
  const startTime =
    now -
    (minutes + 2) * 60_000;

  const req = {
    coin,
    interval: "1m",
    startTime,
    endTime: now,
  };

  const { data } = await postInfo({
    type: "candleSnapshot",
    req,
  });

  const candles =
    Array.isArray(data)
      ? data.filter(
          (c) =>
            num(c?.t) >=
            now -
              minutes *
                60_000
        )
      : [];

  return summarizeCandles(candles);
}

export default async function handler(
  req,
  res
) {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  const receivedAt = Date.now();

  try {
    const url = new URL(
  req.url,
  "https://hyperliquid-live-relay.vercel.app"
);

const coin = String(
  url.searchParams.get("coin") || ""
)
  .trim()
  .toUpperCase();

    if (!coin) {
      return res.status(400).json({
        ok: false,
        error: "coin is required",
      });
    }

    const market =
      await resolveMarket(coin);

    if (
      market.universeIndex < 0
    ) {
      return res.status(200).json({
        ok: true,
        live: false,

        market: {
          coin,
          universeIndex: -1,
        },
      });
    }

    const [
      { data: book },
      w5,
      w15,
      w60,
    ] = await Promise.all([
      postInfo({
        type: "l2Book",
        coin: market.bookCoin,
      }),

      candleWindow(
        market.bookCoin,
        5,
        receivedAt
      ),

      candleWindow(
        market.bookCoin,
        15,
        receivedAt
      ),

      candleWindow(
        market.bookCoin,
        60,
        receivedAt
      ),
    ]);

    const pb = parseBook(book);

    const mid =
      pb.bid != null &&
      pb.ask != null
        ? (pb.bid + pb.ask) / 2
        : null;

    const ctx =
      market.ctxs[
        market.universeIndex
      ] || null;

    const mark =
      num(ctx?.markPx);

    const oracle =
      num(ctx?.oraclePx);

    const bookTime = pb.time;

    const freshnessMs =
      bookTime != null
        ? Math.max(
            0,
            receivedAt -
              bookTime
          )
        : null;

    const saneBook =
      pb.bid != null &&
      pb.ask != null &&
      pb.bid <= pb.ask;

    const fresh =
      freshnessMs != null &&
      freshnessMs <= FRESH_MS;

    const live =
      saneBook && fresh;

    return res
      .status(200)
      .json({
        ok: true,
        live,

        market: {
          coin,

          base: baseName(
            market.assetName ||
              coin
          ),

          dex: market.dex,

          universeIndex:
            market.universeIndex,

          bookCoin:
            market.bookCoin,
        },

        price: {
          bid: pb.bid,
          ask: pb.ask,
          mid,
          mark,
          oracle,

          spreadBps:
            mid
              ? ((pb.ask -
                    pb.bid) /
                  mid) *
                10_000
              : null,

          markVsMidBps:
            bps(mark, mid),

          oracleVsMidBps:
            bps(
              oracle,
              mid
            ),
        },

        context: ctx
          ? {
              funding:
                num(
                  ctx.funding
                ),

              openInterest:
                num(
                  ctx.openInterest
                ),

              dayNtlVlm:
                num(
                  ctx.dayNtlVlm
                ),

              premium:
                num(
                  ctx.premium
                ),
            }
          : null,

        orderBook: {
          top5: depthStats(
            pb.bids,
            pb.asks,
            5
          ),

          top20: depthStats(
            pb.bids,
            pb.asks,
            20
          ),

          levels: {
            bids:
              pb.bids.length,

            asks:
              pb.asks.length,
          },
        },

        momentum: {
          m5: w5,
          m15: w15,
          m60: w60,
        },

        timing: {
          bookTime,
          receivedAt,
          freshnessMs,

          relayLatencyMs:
            Date.now() -
            receivedAt,
        },

        notes: {
          oiFundingHistoryPersisted:
            false,

          oiFundingHistoryReason:
            "Current endpoint does not persist historical snapshots yet; persistent storage is required for reliable OI/funding deltas.",
        },
      });
  } catch (e) {
    return res
      .status(500)
      .json({
        ok: false,
        live: false,
        error: String(e),
        receivedAt,
      });
  }
}

const HL_INFO =
  "https://api.hyperliquid.xyz/info";

const FETCH_TIMEOUT_MS = 12000;
const DEX_CONCURRENCY = 4;

function n(v) {
  const x = Number(v);
  return Number.isFinite(x)
    ? x
    : null;
}

function baseName(s) {
  if (!s) return "";

  const x = String(s);

  return x.includes(":")
    ? x.split(":").pop()
    : x;
}

function dexNames(resp) {
  if (!Array.isArray(resp)) {
    return [];
  }

  return [
    ...new Set(
      resp
        .map((x) => {
          if (
            typeof x === "string"
          ) {
            return x;
          }

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

async function postInfo(
  payload
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      FETCH_TIMEOUT_MS
    );

  try {
    const r =
      await fetch(
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

          signal:
            controller.signal,
        }
      );

    const text =
      await r.text();

    let data = null;

    try {
      data =
        JSON.parse(text);
    } catch {}

    if (!r.ok) {
      throw new Error(
        `HL ${r.status}: ${text.slice(
          0,
          200
        )}`
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

function parseMetaCtx(
  resp
) {
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
      Array.isArray(resp?.[1])
        ? resp[1]
        : [],
  };
}

function makeCoinName(
  dex,
  rawName
) {
  const name =
    String(
      rawName || ""
    );

  if (!dex) {
    return name;
  }

  if (
    name.includes(":")
  ) {
    return name;
  }

  return `${dex}:${baseName(
    name
  )}`;
}

function buildRows(
  parsed,
  dex
) {
  const rows = [];

  for (
    let i = 0;
    i <
    parsed.universe.length;
    i++
  ) {
    const meta =
      parsed.universe[i];

    const ctx =
      parsed.ctxs[i] ??
      null;

    const rawName =
      meta?.name;

    if (!rawName) {
      continue;
    }

    const coin =
      makeCoinName(
        dex,
        rawName
      );

    const markPx =
      n(ctx?.markPx);

    const oraclePx =
      n(ctx?.oraclePx);

    const openInterest =
      n(
        ctx?.openInterest
      );

    const dayNtlVlm =
      n(ctx?.dayNtlVlm);

    const oiNotional =
      markPx != null &&
      openInterest != null
        ? markPx *
          openInterest
        : null;

    const isDelisted =
      meta?.isDelisted ===
        true ||
      meta?.delisted ===
        true;

    rows.push({
      coin,

      base:
        baseName(rawName),

      rawName:
        String(rawName),

      dex:
        dex || null,

      native:
        !dex,

      universeIndex:
        i,

      tradable:
        !isDelisted,

      isDelisted,

      szDecimals:
        n(
          meta?.szDecimals
        ),

      maxLeverage:
        n(
          meta?.maxLeverage
        ),

      onlyIsolated:
        meta
          ?.onlyIsolated ===
        true,

      markPx,

      oraclePx,

      funding:
        n(ctx?.funding),

      premium:
        n(ctx?.premium),

      openInterest,

      oiNotional,

      dayNtlVlm,

      prevDayPx:
        n(ctx?.prevDayPx),

      impactPxs:
        Array.isArray(
          ctx?.impactPxs
        )
          ? ctx.impactPxs
          : null,
    });
  }

  return rows;
}

async function fetchDexRows(
  dex
) {
  try {
    const raw =
      await postInfo({
        type:
          "metaAndAssetCtxs",

        dex,
      });

    const parsed =
      parseMetaCtx(raw);

    return {
      ok: true,
      dex,
      rows:
        buildRows(
          parsed,
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
  const results =
    new Array(
      items.length
    );

  let cursor = 0;

  async function worker() {
    while (true) {
      const index =
        cursor++;

      if (
        index >=
        items.length
      ) {
        return;
      }

      results[index] =
        await fn(
          items[index],
          index
        );
    }
  }

  const workers =
    Array.from(
      {
        length:
          Math.min(
            limit,
            items.length
          ),
      },
      () => worker()
    );

  await Promise.all(
    workers
  );

  return results;
}

function dedupeRows(
  rows
) {
  const map =
    new Map();

  for (
    const row of rows
  ) {
    if (
      !row?.coin
    ) {
      continue;
    }

    const existing =
      map.get(row.coin);

    if (!existing) {
      map.set(
        row.coin,
        row
      );

      continue;
    }

    const oldVolume =
      n(
        existing
          ?.dayNtlVlm
      ) ?? 0;

    const newVolume =
      n(
        row
          ?.dayNtlVlm
      ) ?? 0;

    if (
      newVolume >
      oldVolume
    ) {
      map.set(
        row.coin,
        row
      );
    }
  }

  return [
    ...map.values(),
  ];
}

function liquidityScore(
  row
) {
  const volume =
    Math.max(
      0,
      n(
        row?.dayNtlVlm
      ) ?? 0
    );

  const oi =
    Math.max(
      0,
      n(
        row?.oiNotional
      ) ?? 0
    );

  /*
    出来高を主軸、
    OIを補助軸にする。

    対数化することで
    BTC等の巨大銘柄だけが
    極端に支配しないようにする。
  */
  const volumeScore =
    Math.log10(
      1 + volume
    );

  const oiScore =
    Math.log10(
      1 + oi
    );

  return (
    volumeScore *
      0.70 +
    oiScore *
      0.30
  );
}

export default async function handler(
  req,
  res
) {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  const startedAt =
    Date.now();

  try {
    /*
      1. Native perp
    */
    const nativeRaw =
      await postInfo({
        type:
          "metaAndAssetCtxs",
      });

    const nativeParsed =
      parseMetaCtx(
        nativeRaw
      );

    const nativeRows =
      buildRows(
        nativeParsed,
        ""
      );

    /*
      2. HIP-3 DEX一覧
    */
    let perpDexsRaw = [];

    try {
      perpDexsRaw =
        await postInfo({
          type:
            "perpDexs",
        });
    } catch {}

    const discoveredDexs =
      dexNames(
        perpDexsRaw
      );

    /*
      xyzは株式/RWA系で
      現在の監視にも使っているため
      API結果に無い場合でも
      一度確認する。
    */
    const dexes = [
      ...new Set([
        "xyz",
        ...discoveredDexs,
      ]),
    ].filter(Boolean);

    /*
      3. HIP-3を並列数制限付きで取得
    */
    const dexResults =
      await mapLimit(
        dexes,
        DEX_CONCURRENCY,
        fetchDexRows
      );

    const hip3Rows =
      dexResults.flatMap(
        (x) =>
          x?.rows ?? []
      );

    /*
      4. 重複排除
    */
    const allRows =
      dedupeRows([
        ...nativeRows,
        ...hip3Rows,
      ]);

    /*
      5. 上場中のみ
    */
    const tradable =
      allRows.filter(
        (x) =>
          x.tradable ===
          true
      );

    /*
      6. 流動性スコア付与
    */
    const ranked =
      tradable
        .map(
          (x) => ({
            ...x,

            liquidityScore:
              liquidityScore(
                x
              ),
          })
        )
        .sort(
          (a, b) =>
            (
              b
                .liquidityScore ??
              0
            ) -
            (
              a
                .liquidityScore ??
              0
            )
        );

    const failedDexes =
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
        );

    return res
      .status(200)
      .json({
        ok: true,

        generatedAt:
          Date.now(),

        durationMs:
          Date.now() -
          startedAt,

        counts: {
          total:
            allRows.length,

          tradable:
            ranked.length,

          native:
            nativeRows.length,

          hip3:
            hip3Rows.length,

          dexesChecked:
            dexes.length,

          dexesFailed:
            failedDexes.length,
        },

        dexes:
          dexes,

        failedDexes,

        /*
          まず全銘柄を返す。

          次段階では
          liquidityScore上位だけを
          deep analysisへ送る。
        */
        ranking:
          ranked,
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

        durationMs:
          Date.now() -
          startedAt,
      });
  }
}

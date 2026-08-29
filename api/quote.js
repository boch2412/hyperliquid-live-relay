const HL_INFO = "https://api.hyperliquid.xyz/info";
const FRESH_MS = 10_000;

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
function bps(a, b) {
  if (a == null || b == null || b === 0) return null;
  return ((a - b) / b) * 10_000;
}
async function postInfo(payload) {
  const t0 = Date.now();
  const r = await fetch(HL_INFO, {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`HL ${r.status}: ${text.slice(0,200)}`);
  return { data, latencyMs: Date.now() - t0 };
}
function parseMetaCtx(resp) {
  if (!Array.isArray(resp) || resp.length < 2) return { universe:[], ctxs:[] };
  return {
    universe: resp[0]?.universe || [],
    ctxs: Array.isArray(resp[1]) ? resp[1] : []
  };
}
function dexNames(resp) {
  if (!Array.isArray(resp)) return [];
  return [...new Set(resp.map(x => {
    if (typeof x === "string") return x;
    return x?.name || x?.dex || x?.symbol || x?.id || null;
  }).filter(Boolean).map(String))];
}
async function resolveMarket(coin) {
  // 1) Native perp first
  const native = parseMetaCtx((await postInfo({type:"metaAndAssetCtxs"})).data);
  let i = native.universe.findIndex(u => sameCoin(u?.name, coin));
  if (i >= 0) {
    return { dex:"", universeIndex:i, universe:native.universe, ctxs:native.ctxs,
             assetName:native.universe[i]?.name, bookCoin:baseName(native.universe[i]?.name) };
  }

  // 2) HIP-3: discover every perp DEX, then inspect each universe.
  const dexResp = (await postInfo({type:"perpDexs"})).data;
  const names = dexNames(dexResp);

  // Known active stock/RWA DEX first; then whatever the API returned.
  const ordered = [...new Set(["xyz", ...names])].filter(Boolean);

  for (const dex of ordered) {
    try {
      const parsed = parseMetaCtx((await postInfo({type:"metaAndAssetCtxs", dex})).data);
      i = parsed.universe.findIndex(u => sameCoin(u?.name, coin));
      if (i >= 0) {
        const rawName = parsed.universe[i]?.name || coin;
        const prefixed = String(rawName).includes(":") ? String(rawName) : `${dex}:${baseName(rawName)}`;
        return { dex, universeIndex:i, universe:parsed.universe, ctxs:parsed.ctxs,
                 assetName:rawName, bookCoin:prefixed };
      }
    } catch {}
  }
  return { dex:"", universeIndex:-1, universe:[], ctxs:[], assetName:coin, bookCoin:coin };
}
function parseBook(book) {
  const levels = book?.levels;
  const bids = Array.isArray(levels?.[0]) ? levels[0] : [];
  const asks = Array.isArray(levels?.[1]) ? levels[1] : [];
  const bid = bids.length ? num(bids[0]?.px ?? bids[0]?.price) : null;
  const ask = asks.length ? num(asks[0]?.px ?? asks[0]?.price) : null;
  return { bids, asks, bid, ask, time:num(book?.time) };
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const receivedAt = Date.now();
  try {
    const coin = String(req.query.coin || "").trim().toUpperCase();
    if (!coin) return res.status(400).json({ok:false,error:"coin is required"});

    const market = await resolveMarket(coin);
    if (market.universeIndex < 0) {
      return res.status(200).json({
        ok:true, live:false,
        market:{coin,base:coin,dex:"",universeIndex:-1},
        price:{bid:null,ask:null,mid:null,allMid:null,mark:null,oracle:null,spreadBps:null,markVsMidBps:null,oracleVsMidBps:null},
        context:null,
        timing:{bookTime:null,receivedAt,freshnessMs:null,relayLatencyMs:Date.now()-receivedAt},
        rawChecks:{universeMatched:false,bookLevels:{bids:0,asks:0}}
      });
    }

    const [{data: allMids}, {data: book}] = await Promise.all([
      postInfo(market.dex ? {type:"allMids", dex:market.dex} : {type:"allMids"}),
      postInfo({type:"l2Book", coin:market.bookCoin})
    ]);

    const pb = parseBook(book);
    const bid = pb.bid, ask = pb.ask;
    const mid = bid != null && ask != null ? (bid + ask)/2 : null;

    const ctx = market.ctxs[market.universeIndex] || null;
    const mark = num(ctx?.markPx);
    const oracle = num(ctx?.oraclePx);
    const allMid =
      num(allMids?.[market.bookCoin]) ??
      num(allMids?.[market.assetName]) ??
      num(allMids?.[baseName(market.assetName)]) ??
      null;

    const bookTime = pb.time;
    const freshnessMs = bookTime != null ? Math.max(0, receivedAt - bookTime) : null;
    const spreadBps = (bid != null && ask != null && mid) ? ((ask-bid)/mid)*10_000 : null;

    const saneBook = bid != null && ask != null && bid <= ask;
    const fresh = freshnessMs != null && freshnessMs <= FRESH_MS;
    const live = saneBook && fresh && market.universeIndex >= 0;

    return res.status(200).json({
      ok:true,
      live,
      market:{
        coin,
        base:baseName(market.assetName || coin),
        dex:market.dex,
        universeIndex:market.universeIndex,
        bookCoin:market.bookCoin
      },
      price:{
        bid, ask, mid, allMid, mark, oracle,
        spreadBps,
        markVsMidBps:bps(mark, mid),
        oracleVsMidBps:bps(oracle, mid)
      },
      context: ctx ? {
        funding:num(ctx.funding),
        openInterest:num(ctx.openInterest),
        dayNtlVlm:num(ctx.dayNtlVlm),
        prevDayPx:num(ctx.prevDayPx),
        premium:num(ctx.premium),
        impactPxs:Array.isArray(ctx.impactPxs) ? ctx.impactPxs : null
      } : null,
      timing:{
        bookTime,
        receivedAt,
        freshnessMs,
        relayLatencyMs:Date.now()-receivedAt
      },
      rawChecks:{
        universeMatched:market.universeIndex >= 0,
        bookLevels:{bids:pb.bids.length,asks:pb.asks.length}
      }
    });
  } catch (e) {
    return res.status(500).json({ok:false,live:false,error:String(e),receivedAt});
  }
}

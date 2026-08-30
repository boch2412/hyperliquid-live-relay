import { buildShadowSnapshot, classifyObservation } from '../lib/persistence-shadow.mjs';
import { evaluateShadowIntel, screenerBaseScore, n } from '../lib/rank-shadow-core.mjs';

const BASE = process.env.SHADOW_BASE_URL || 'https://hyperliquid-live-relay.vercel.app';
const DEEP_CONCURRENCY = 3;
const API_CONCURRENCY = 2;
const API_START_INTERVAL_MS = 200;
const MAX_429_RETRIES = 4;
const RETRY_BASE_MS = 500;
const MAX_FRESHNESS_MS = 10_000;

let apiActive = 0;
let apiNextStartAt = 0;
const queue = [];
let drainTimer = null;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function clockMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }

function drain() {
  while (apiActive < API_CONCURRENCY && queue.length) {
    const waitMs = Math.max(0, apiNextStartAt - clockMs());
    if (waitMs > 0) {
      if (drainTimer == null) drainTimer = setTimeout(() => { drainTimer = null; drain(); }, waitMs);
      return;
    }
    const job = queue.shift();
    apiActive += 1;
    apiNextStartAt = clockMs() + API_START_INTERVAL_MS;
    Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { apiActive -= 1; drain(); });
  }
}

function schedule(task) {
  return new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); drain(); });
}

async function fetchJson(url) {
  for (let retry = 0; retry <= MAX_429_RETRIES; retry += 1) {
    const result = await schedule(async () => {
      const r = await fetch(url, { cache: 'no-store' });
      const text = await r.text();
      return { ok: r.ok, status: r.status, text, retryAfter: Number(r.headers.get('retry-after')) || 0 };
    });
    if (result.status !== 429 || retry >= MAX_429_RETRIES) {
      if (!result.ok) throw new Error(`HTTP ${result.status}: ${result.text.slice(0, 180)}`);
      return JSON.parse(result.text);
    }
    await sleep(Math.max(RETRY_BASE_MS * 2 ** retry, result.retryAfter * 1000));
  }
  throw new Error('unreachable retry state');
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function persistenceMap(data) {
  const map = new Map();
  for (const row of Array.isArray(data?.ranking) ? data.ranking : []) {
    const coin = String(row?.coin ?? '');
    const score = Number(row?.score);
    if (!coin || !Number.isFinite(score)) continue;
    map.set(coin, score);
    const base = coin.includes(':') ? coin.split(':').pop().toUpperCase() : coin.toUpperCase();
    map.set(base, score);
  }
  return map;
}

function snapshotId(ts) {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA || 'local';
  return `shadow-${ts}-${commit.slice(0, 12)}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const startedAt = Date.now();
  const url = new URL(req.url, BASE);
  const requestedLimit = Math.max(5, Math.min(24, Number(url.searchParams.get('limit')) || 18));

  try {
    const screener = await fetchJson(`${BASE}/api/rank?mode=screener&limit=${requestedLimit}`);
    const watchlistDetails = Array.isArray(screener?.watchlistDetails) ? screener.watchlistDetails : [];
    const coins = watchlistDetails.map((x) => x.coin).filter(Boolean);
    if (!coins.length) throw new Error('empty watchlist');

    const persistencePromise = fetchJson(`${BASE}/api/persistence?mode=watchrank&coins=${encodeURIComponent(coins.join(','))}`);
    const intelResults = await mapLimit(coins, DEEP_CONCURRENCY, async (coin) => {
      try {
        return { ok: true, coin, intel: await fetchJson(`${BASE}/api/intel?coin=${encodeURIComponent(coin)}`) };
      } catch (error) {
        return { ok: false, coin, error: String(error) };
      }
    });
    const persistence = await persistencePromise;
    const pMap = persistenceMap(persistence);
    const detailMap = new Map(watchlistDetails.map((x) => [x.coin, x]));

    const rows = [];
    const invalidReasons = [];
    for (const item of intelResults) {
      if (!item.ok) {
        invalidReasons.push({ coin: item.coin, reason: 'intel_fetch_failed', error: item.error });
        continue;
      }
      const evaluated = evaluateShadowIntel(item.intel);
      const detail = detailMap.get(item.coin) || {};
      const baseScore = screenerBaseScore(evaluated, detail.stage1Score);
      const baseKey = String(item.coin).includes(':') ? String(item.coin).split(':').pop().toUpperCase() : String(item.coin).toUpperCase();
      const persistenceScore = pMap.get(item.coin) ?? pMap.get(baseKey);
      const freshnessMs = n(evaluated?.marketSnapshot?.freshnessMs);
      const live = evaluated?.marketSnapshot?.liveFresh === true;
      const bid = n(evaluated?.marketSnapshot?.price?.bid);
      const ask = n(evaluated?.marketSnapshot?.price?.ask);
      const missingMajor = !Number.isFinite(baseScore) || !Number.isFinite(persistenceScore) || bid == null || ask == null;
      if (missingMajor || !live || (freshnessMs != null && freshnessMs > MAX_FRESHNESS_MS)) {
        invalidReasons.push({
          coin: item.coin,
          reason: missingMajor ? 'major_field_missing' : (!live ? 'live_false' : 'stale_gt_10000ms'),
          freshnessMs,
          live,
        });
      }
      rows.push({
        coin: item.coin,
        bias: evaluated.bias,
        confidence: evaluated.confidence,
        opportunity: evaluated.opportunity,
        executionQuality: evaluated.executionQuality,
        baseScore,
        persistenceScore: Number.isFinite(persistenceScore) ? persistenceScore : null,
        stage1Score: n(detail.stage1Score),
        dex: detail.dex ?? null,
        market: detail.dex ? 'HIP-3' : 'CRYPTO',
        bid,
        ask,
        freshnessMs,
        live,
      });
    }

    const allWeightsSucceeded = rows.length === coins.length && rows.every((r) => Number.isFinite(r.baseScore) && Number.isFinite(r.persistenceScore));
    const globalObservation = classifyObservation({
      freshnessMs: rows.reduce((m, r) => Math.max(m, Number(r.freshnessMs) || 0), 0),
      live: rows.every((r) => r.live === true),
      mappingKnown: true,
      marketOpen: true,
      allWeightsSucceeded,
      majorFieldsPresent: invalidReasons.length === 0,
      candidateCount: rows.filter((r) => r.bias === 'LONG' || r.bias === 'SHORT').length,
    });

    const ts = startedAt;
    const snapshot = buildShadowSnapshot({
      snapshotId: snapshotId(ts),
      inputTimestamp: new Date(ts).toISOString(),
      dataVersion: `rank:${screener?.generatedAt ?? 'unknown'}|persistence:${persistence?.generatedAt ?? 'unknown'}`,
      apiVersion: 'persistence-shadow-v1',
      codeVersion: process.env.VERCEL_GIT_COMMIT_SHA || 'local',
      rows,
      marketScope: { requestedLimit, universe: screener?.universe ?? null, methodology: screener?.methodology ?? null },
      exclusions: { maxFreshnessMs: MAX_FRESHNESS_MS, requireLive: true, requireBidAsk: true },
      feeRate: Number(url.searchParams.get('feeRate')) || 0,
      slippageRate: Number(url.searchParams.get('slippageRate')) || 0,
    });

    return res.status(200).json({
      ok: true,
      generatedAt: Date.now(),
      productionWeightPct: 10,
      productionCodeChanged: false,
      snapshot,
      observation: globalObservation,
      invalidReasons,
      source: {
        screenerGeneratedAt: screener?.generatedAt ?? null,
        deepRequested: requestedLimit,
        deepReceived: rows.length,
        dexesChecked: screener?.universe?.dexesChecked ?? null,
        dexesFailed: screener?.universe?.dexesFailed ?? null,
      },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, generatedAt: Date.now(), error: String(error) });
  }
}

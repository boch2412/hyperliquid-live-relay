import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateShadowIntel, screenerBaseScore } from '../lib/rank-shadow-core.mjs';

function fixture() {
  return {
    coin: 'BTC',
    live: {
      price: { bid: 100, ask: 100.1, mid: 100.05, spreadBps: 1 },
      momentum: {
        m5: { returnPct: 0.2 },
        m15: { returnPct: 0.3 },
        m60: { returnPct: 0.4 },
      },
      context: { funding: 0, openInterest: 1_000_000, dayNtlVlm: 100_000_000 },
      orderBook: {
        top5: { imbalance: 0.2 },
        top20: { imbalance: 0.1, bidSize: 10_000, askSize: 10_000 },
      },
    },
    history: {
      windows: {
        m5: { ready: true, pricePct: 0.2, oiPct: 0.1, fundingDelta: 0 },
        m15: { ready: true, pricePct: 0.3, oiPct: 0.1, fundingDelta: 0 },
        m60: { ready: true, pricePct: 0.4, oiPct: 0.1, fundingDelta: 0 },
      },
    },
    quality: { liveFresh: true, liveAgeMs: 500, historyAvailable: true, full60mReady: true, historyAgeMs: 500 },
  };
}

test('shadow evaluator preserves fresh bid/ask and freshness', () => {
  const evaluated = evaluateShadowIntel(fixture());
  assert.equal(evaluated.marketSnapshot.price.bid, 100);
  assert.equal(evaluated.marketSnapshot.price.ask, 100.1);
  assert.equal(evaluated.marketSnapshot.freshnessMs, 500);
  assert.equal(evaluated.marketSnapshot.liveFresh, true);
});

test('shadow base score is finite for complete fixture', () => {
  const evaluated = evaluateShadowIntel(fixture());
  const score = screenerBaseScore(evaluated, 0.75);
  assert.equal(Number.isFinite(score), true);
});

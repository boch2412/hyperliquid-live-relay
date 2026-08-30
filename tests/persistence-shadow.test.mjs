import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildShadowScores,
  buildShadowSnapshot,
  classifyObservation,
  netReturn,
  rankShadowRows,
  scoreWithPersistence,
} from '../lib/persistence-shadow.mjs';

test('production 10% formula remains exact', () => {
  assert.equal(scoreWithPersistence(0.8, 0.2, 0.10), 0.74);
});

test('5/10/15 shadow scores only change persistence weight', () => {
  const scores = buildShadowScores(0.8, 0.2);
  assert.deepEqual(scores, { '5': 0.77, '10': 0.74, '15': 0.71 });
});

test('shadow ranking uses deterministic tie-break', () => {
  const rows = [
    { coin: 'B', baseScore: 0.5, persistenceScore: 0.5 },
    { coin: 'A', baseScore: 0.5, persistenceScore: 0.5 },
  ];
  const ranked = rankShadowRows(rows, 0.10);
  assert.deepEqual(ranked.map((x) => x.coin), ['A', 'B']);
});

test('snapshot contains all three rankings and versions', () => {
  const snapshot = buildShadowSnapshot({
    snapshotId: 's1',
    inputTimestamp: '2026-08-31T08:30:00+09:00',
    dataVersion: 'd1',
    apiVersion: 'a1',
    codeVersion: 'c1',
    rows: [{ coin: 'BTC', bias: 'LONG', baseScore: 0.8, persistenceScore: 0.2 }],
  });
  assert.equal(snapshot.productionWeightPct, 10);
  assert.deepEqual(snapshot.shadowWeightPcts, [5, 10, 15]);
  assert.ok(snapshot.rankings['5']);
  assert.ok(snapshot.rankings['10']);
  assert.ok(snapshot.rankings['15']);
  assert.equal(snapshot.versions.codeVersion, 'c1');
});

test('normal no-candidate is valid no-trade', () => {
  assert.deepEqual(classifyObservation({ candidateCount: 0 }), {
    valid: true,
    noTrade: true,
    reasons: [],
  });
});

test('stale or partial weight failure is invalid, not no-trade', () => {
  const result = classifyObservation({
    freshnessMs: 10001,
    allWeightsSucceeded: false,
    candidateCount: 0,
  });
  assert.equal(result.valid, false);
  assert.equal(result.noTrade, false);
  assert.deepEqual(result.reasons, ['stale_gt_10000ms', 'partial_weight_failure']);
});

test('LONG uses ask to bid and SHORT uses bid to ask', () => {
  const long = netReturn({ direction: 'LONG', entryAsk: 100, exitBid: 101, feeRate: 0, slippageRate: 0 });
  const short = netReturn({ direction: 'SHORT', entryBid: 100, exitAsk: 99, feeRate: 0, slippageRate: 0 });
  assert.equal(long, 0.01);
  assert.ok(Math.abs(short - (100 / 99 - 1)) < 1e-12);
});

import test from "node:test";
import assert from "node:assert/strict";

import handler, {
  aggregateCampaign,
  assessPositionPlan,
  reconcilePositionSnapshots,
} from "../lib/trade-campaign.js";

import decisionLogHandler from "../api/decision-log.js";

function input() {
  return {
    campaignId: "tria-soxl-20261022-01",
    instrument: "xyz:SOXL",
    timeHorizon: "scalp",
    strategyTag: "tournament",
    positionSide: "LONG",
    riskBucketHint: "equity-beta-long",
    marginUsd: 5_000,
    leverage: 10,
    fundingUsd: -1,
    orderCancelRequired: true,
    orderCancelConfirmed: true,
    protectiveStop: {
      confirmed: true,
      stopPrice: 95,
      quantity: 0,
    },
    fills: [
      {
        fillId: "open-1",
        kind: "OPEN",
        price: 100,
        referencePrice: 99,
        quantity: 1,
        feeUsd: 1,
        reportedPnlUsd: -1,
        occurredAt: "2026-10-22T01:00:00Z",
      },
      {
        fillId: "open-2",
        kind: "OPEN",
        price: 110,
        referencePrice: 109,
        quantity: 1,
        feeUsd: 1,
        reportedPnlUsd: -1,
        occurredAt: "2026-10-22T01:01:00Z",
      },
      {
        fillId: "close-1",
        kind: "CLOSE",
        price: 120,
        referencePrice: 121,
        quantity: 0.5,
        feeUsd: 1,
        reportedPnlUsd: 500,
        occurredAt: "2026-10-22T01:04:00Z",
      },
      {
        fillId: "close-2",
        kind: "CLOSE",
        price: 130,
        referencePrice: 131,
        quantity: 1.5,
        feeUsd: 1,
        reportedPnlUsd: 500,
        occurredAt: "2026-10-22T01:05:00Z",
      },
    ],
  };
}

test("groups split fills into one explicit campaign and computes actual costs once", () => {
  const campaign = aggregateCampaign(input());

  assert.equal(campaign.campaignCount, 1);
  assert.equal(campaign.fillCount, 4);
  assert.equal(campaign.timeHorizon, "scalp");
  assert.equal(campaign.strategyTag, "tournament");
  assert.equal(campaign.avgEntry, 105);
  assert.equal(campaign.avgExit, 127.5);
  assert.equal(campaign.grossPnlUsd, 45);
  assert.equal(campaign.feesUsd, 4);
  assert.equal(campaign.fundingUsd, -1);
  assert.equal(campaign.netPnlUsd, 40);
  assert.equal(campaign.volumeUsd, 465);
  assert.equal(campaign.slippageUsd, 4);
  assert.equal(campaign.holdSeconds, 300);
  assert.equal(campaign.isClosed, true);
  assert.equal(campaign.dataQuality.status, "NORMAL");
});

test("does not reuse displayed fill PnL or subtract its embedded entry fee again", () => {
  const campaign = aggregateCampaign(input());

  assert.equal(campaign.reportedRealizedPnlUsd, 998);
  assert.equal(campaign.netPnlUsd, 40);
  assert.equal(
    campaign.dataQuality.reportedPnlUsedForNet,
    false
  );
  assert.ok(
    campaign.warnings.includes(
      "reported_pnl_not_used_for_net_to_avoid_fee_double_count"
    )
  );
});

test("preserves the explicit strategy horizon instead of inferring it from hold time", () => {
  const value = input();
  value.timeHorizon = "swing";
  const campaign = aggregateCampaign(value);

  assert.equal(campaign.timeHorizon, "swing");
  assert.equal(campaign.holdSeconds, 300);
});

test("keeps unknown funding and order state incomplete instead of assuming zero or canceled", () => {
  const value = input();
  delete value.fundingUsd;
  delete value.orderCancelConfirmed;
  value.fills.pop();
  value.protectiveStop.quantity = 0.5;
  const campaign = aggregateCampaign(value);

  assert.equal(campaign.isClosed, false);
  assert.equal(campaign.exitAt, null);
  assert.equal(campaign.netPnlUsd, null);
  assert.equal(campaign.costPerMillionUsd, null);
  assert.equal(campaign.slCoverage.status, "PARTIAL");
  assert.equal(campaign.orderCancelConfirmed, null);
  assert.equal(campaign.dataQuality.status, "INCOMPLETE");
  assert.ok(campaign.dataQuality.missingFields.includes("fundingUsd"));
  assert.ok(campaign.dataQuality.missingFields.includes("orderCancelConfirmed"));
});

test("rejects duplicate fills, over-closes, and entry fills after closing begins", () => {
  const duplicate = input();
  duplicate.fills[1].fillId = "open-1";
  assert.throws(
    () => aggregateCampaign(duplicate),
    /fillId_invalid_or_duplicate/
  );

  const overClose = input();
  overClose.fills[3].quantity = 2;
  assert.throws(
    () => aggregateCampaign(overClose),
    /close_quantity_exceeds_open_quantity/
  );

  const reopened = input();
  reopened.fills[3].kind = "OPEN";
  assert.throws(
    () => aggregateCampaign(reopened),
    /campaign_requires_open_group_then_close_group/
  );
});

test("keeps the reported NEAR ladder unknown when order quantities and stop coverage are unverified", () => {
  const assessment = assessPositionPlan({
    planId: "tria-near-20261024",
    instrument: "NEAR",
    timeHorizon: "swing",
    positionSide: "LONG",
    riskBucketHint: "crypto-beta-long",
    accountEquityUsd: 50_000,
    currentPosition: {
      quantity: 825,
      avgEntry: 4.57501,
      markPrice: 4.64215,
      marginUsd: 382.85,
      leverage: 10,
    },
    pendingEntries: [
      4.5,
      4.45,
      4.4,
      4.35,
      4.3,
      4.25,
      4.2,
    ].map((price, index) => ({
      orderId: null,
      price,
      quantity: null,
      confirmed: true,
      reduceOnly: null,
      cancelOnStopConfirmed: null,
      sourceIndex: index,
    })),
    protectiveStop: {
      confirmed: null,
      stopPrice: 4.05,
      quantity: null,
      reduceOnly: null,
    },
  });

  assert.equal(assessment.currentQuantity, 825);
  assert.equal(assessment.currentAvgEntry, 4.57501);
  assert.equal(assessment.currentEntryNotionalUsd, 3774.38325);
  assert.equal(assessment.currentMarkNotionalUsd, 3829.77375);
  assert.equal(assessment.pendingEntries.count, 7);
  assert.equal(assessment.pendingEntries.knownQuantityCount, 0);
  assert.equal(assessment.plannedQuantity, null);
  assert.equal(assessment.plannedAvgEntry, null);
  assert.equal(assessment.plannedMarginUsd, null);
  assert.equal(assessment.maxLossUsd, null);
  assert.equal(assessment.slCoverage.status, "UNKNOWN");
  assert.equal(assessment.postStopReentryRisk, "UNKNOWN");
  assert.equal(assessment.dataQuality.status, "INCOMPLETE");
  assert.ok(
    assessment.dataQuality.missingFields.includes(
      "pendingEntries[].quantity"
    )
  );
  assert.ok(
    assessment.warnings.includes(
      "post_stop_reentry_risk_unverified"
    )
  );
});

test("separates a complete ladder margin cap from stop-loss risk and detects post-stop re-entry", () => {
  const assessment = assessPositionPlan({
    planId: "synthetic-complete-ladder",
    instrument: "TEST",
    timeHorizon: "swing",
    positionSide: "LONG",
    riskBucketHint: "crypto-beta-long",
    accountEquityUsd: 50_000,
    currentPosition: {
      quantity: 10,
      avgEntry: 100,
      markPrice: 100,
      marginUsd: 100,
      leverage: 10,
    },
    pendingEntries: [
      {
        orderId: "entry-1",
        price: 95,
        quantity: 10,
        confirmed: true,
        reduceOnly: false,
        cancelOnStopConfirmed: true,
      },
      {
        orderId: "entry-2",
        price: 90,
        quantity: 20,
        confirmed: true,
        reduceOnly: false,
        cancelOnStopConfirmed: false,
      },
    ],
    protectiveStop: {
      confirmed: true,
      stopPrice: 80,
      quantity: 40,
      reduceOnly: true,
    },
    estimatedCosts: {
      entryFeesUsd: 5,
      exitFeesUsd: 5,
      slippageUsd: 10,
      fundingCostUsd: 2,
    },
    riskLimits: {
      marginCapUsd: 10_000,
      maxLossUsd: 500,
    },
  });

  assert.equal(assessment.plannedQuantity, 40);
  assert.equal(assessment.plannedNotionalUsd, 3750);
  assert.equal(assessment.plannedAvgEntry, 93.75);
  assert.equal(assessment.plannedMarginUsd, 375);
  assert.equal(assessment.stopPriceRiskUsd, 550);
  assert.equal(assessment.maxLossUsd, 572);
  assert.equal(assessment.maxLossPctEquity, 1.144);
  assert.equal(assessment.slCoverage.status, "FULL");
  assert.equal(assessment.postStopReentryRisk, "DETECTED");
  assert.equal(assessment.limitChecks.margin.status, "PASS");
  assert.equal(assessment.limitChecks.maxLoss.status, "BLOCK");
  assert.ok(
    assessment.warnings.includes(
      "pending_entries_can_reopen_after_stop"
    )
  );
});

test("does not publish max loss when the stop cannot cover the complete ladder", () => {
  const assessment = assessPositionPlan({
    planId: "partial-stop",
    instrument: "TEST",
    timeHorizon: "swing",
    positionSide: "LONG",
    accountEquityUsd: 50_000,
    currentPosition: {
      quantity: 10,
      avgEntry: 100,
      leverage: 10,
    },
    pendingEntries: [{
      orderId: "entry-1",
      price: 90,
      quantity: 10,
      confirmed: true,
      reduceOnly: false,
      cancelOnStopConfirmed: true,
    }],
    protectiveStop: {
      confirmed: true,
      stopPrice: 80,
      quantity: 10,
      reduceOnly: true,
    },
    estimatedCosts: {
      entryFeesUsd: 1,
      exitFeesUsd: 1,
      slippageUsd: 1,
      fundingCostUsd: 1,
    },
  });

  assert.equal(assessment.slCoverage.status, "PARTIAL");
  assert.equal(assessment.stopPriceRiskUsd, 300);
  assert.equal(assessment.maxLossUsd, null);
  assert.equal(
    assessment.limitChecks.maxLoss.status,
    "UNKNOWN"
  );
});

test("newer verified position snapshots supersede old quantities without becoming current when stale", () => {
  const result = reconcilePositionSnapshots({
    evaluatedAt: "2026-10-26T10:00:00+09:00",
    freshnessLimitMs: 60 * 60 * 1000,
    snapshots: [
      {
        snapshotId: "near-new-screen",
        instrument: "NEAR",
        observedAt: "2026-10-25T00:19:00+09:00",
        sourceType: "user_screen",
        campaignId: "near-swing-20261024",
        quantity: 15_962,
        positionSide: "LONG",
        avgEntry: 4.33537,
        marginUsd: 6_966.61,
      },
      {
        snapshotId: "near-old-screen",
        instrument: "NEAR",
        observedAt: "2026-10-24T11:30:00+09:00",
        sourceType: "user_screen",
        campaignId: "near-swing-20261024",
        quantity: 825,
        positionSide: "LONG",
        avgEntry: 4.57501,
        marginUsd: 382.85,
      },
    ],
  });

  const near = result.instruments[0];
  assert.equal(near.instrument, "NEAR");
  assert.equal(
    near.latestObservedPosition.snapshotId,
    "near-new-screen"
  );
  assert.equal(near.latestObservedPosition.quantity, 15_962);
  assert.deepEqual(
    near.supersededSnapshotIds,
    ["near-old-screen"]
  );
  assert.equal(near.currentStatus, "STALE");
  assert.equal(near.currentPosition, null);
  assert.ok(
    near.warnings.includes(
      "latest_position_snapshot_is_stale"
    )
  );
});

test("a closed BTC short and later BTC long remain separate explicit campaigns", () => {
  const result = reconcilePositionSnapshots({
    evaluatedAt: "2026-10-25T00:20:00+09:00",
    freshnessLimitMs: 60 * 60 * 1000,
    snapshots: [
      {
        snapshotId: "btc-short-close",
        instrument: "BTC",
        observedAt: "2026-10-23T15:12:00+09:00",
        sourceType: "exchange_position",
        campaignId: "btc-short-20261023",
        quantity: 0,
      },
      {
        snapshotId: "btc-long-screen",
        instrument: "BTC",
        observedAt: "2026-10-25T00:19:00+09:00",
        sourceType: "user_screen",
        campaignId: "btc-long-20261025",
        quantity: 1.47169,
        positionSide: "LONG",
        avgEntry: 80_250,
        marginUsd: 2_922.59,
      },
    ],
  });

  const btc = result.instruments[0];
  assert.equal(btc.currentStatus, "CURRENT");
  assert.equal(btc.currentPosition.positionSide, "LONG");
  assert.equal(
    btc.campaignTransition.status,
    "CONFIRMED_SEPARATE"
  );
  assert.equal(
    btc.campaignTransition.previousCampaignId,
    "btc-short-20261023"
  );
  assert.equal(
    btc.campaignTransition.currentCampaignId,
    "btc-long-20261025"
  );
});

test("library handler is POST-only and the existing decision endpoint exposes an opt-in mode", async () => {
  const makeRes = () => ({
    statusCode: null,
    headers: {},
    body: null,
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
  });

  const getRes = makeRes();
  handler({ method: "GET" }, getRes);
  assert.equal(getRes.statusCode, 405);
  assert.equal(getRes.headers.Allow, "POST");

  const postRes = makeRes();
  handler(
    { method: "POST", body: input() },
    postRes
  );
  assert.equal(postRes.statusCode, 200);
  assert.equal(postRes.body.ok, true);

  const routedRes = makeRes();
  await decisionLogHandler(
    {
      method: "POST",
      body: {
        action: "aggregate_campaign",
        campaign: input(),
      },
    },
    routedRes
  );
  assert.equal(routedRes.statusCode, 200);
  assert.equal(routedRes.body.ok, true);
  assert.equal(
    routedRes.body.campaign.campaignCount,
    1
  );

  const positionRes = makeRes();
  await decisionLogHandler(
    {
      method: "POST",
      body: {
        action: "assess_position_plan",
        positionPlan: {
          planId: "route-test",
          instrument: "NEAR",
          timeHorizon: "swing",
          positionSide: "LONG",
          currentPosition: {
            quantity: 1,
            avgEntry: 4.5,
          },
        },
      },
    },
    positionRes
  );
  assert.equal(positionRes.statusCode, 200);
  assert.equal(positionRes.body.ok, true);
  assert.equal(
    positionRes.body.positionPlan.planId,
    "route-test"
  );

  const snapshotsRes = makeRes();
  await decisionLogHandler(
    {
      method: "POST",
      body: {
        action: "reconcile_position_snapshots",
        positionSnapshots: {
          evaluatedAt: "2026-10-25T00:20:00+09:00",
          freshnessLimitMs: 60 * 60 * 1000,
          snapshots: [{
            snapshotId: "route-position",
            instrument: "BTC",
            observedAt: "2026-10-25T00:19:00+09:00",
            sourceType: "user_screen",
            campaignId: "btc-long-20261025",
            quantity: 1,
            positionSide: "LONG",
            avgEntry: 80_250,
          }],
        },
      },
    },
    snapshotsRes
  );
  assert.equal(snapshotsRes.statusCode, 200);
  assert.equal(snapshotsRes.body.ok, true);
  assert.equal(
    snapshotsRes.body.positionSnapshots.instruments[0]
      .currentStatus,
    "CURRENT"
  );
});

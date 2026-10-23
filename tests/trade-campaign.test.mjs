import test from "node:test";
import assert from "node:assert/strict";

import handler, {
  aggregateCampaign,
} from "../api/trade-campaign.js";

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

test("endpoint is POST-only and returns validation failures without side effects", () => {
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
});

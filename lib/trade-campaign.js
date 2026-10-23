const TIME_HORIZONS = new Set([
  "swing",
  "daytrade",
  "scalp",
]);
const POSITION_SIDES = new Set([
  "LONG",
  "SHORT",
]);
const FILL_KINDS = new Set([
  "OPEN",
  "CLOSE",
]);
const MAX_FILLS = 1_000;
const EPSILON = 1e-9;

function number(value) {
  if (
    value == null ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function timestamp(value) {
  if (value == null || value === "") {
    return null;
  }

  const parsed =
    typeof value === "number"
      ? value
      : Date.parse(value);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function round(value) {
  return value == null
    ? null
    : Number(value.toFixed(8));
}

function campaignError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function aggregateCampaign(input) {
  const campaignId =
    typeof input?.campaignId === "string"
      ? input.campaignId.trim()
      : "";
  const instrument =
    typeof input?.instrument === "string"
      ? input.instrument.trim()
      : "";
  const timeHorizon =
    input?.timeHorizon;
  const positionSide =
    input?.positionSide;
  const fills = input?.fills;

  if (!campaignId) {
    throw campaignError("campaignId_required");
  }
  if (!instrument) {
    throw campaignError("instrument_required");
  }
  if (!TIME_HORIZONS.has(timeHorizon)) {
    throw campaignError("timeHorizon_invalid");
  }
  if (!POSITION_SIDES.has(positionSide)) {
    throw campaignError("positionSide_invalid");
  }
  if (
    !Array.isArray(fills) ||
    fills.length === 0 ||
    fills.length > MAX_FILLS
  ) {
    throw campaignError("fills_invalid");
  }

  const ids = new Set();
  const normalized = fills.map(
    (fill, index) => {
      const fillId =
        typeof fill?.fillId === "string"
          ? fill.fillId.trim()
          : "";
      const kind = fill?.kind;
      const price = number(fill?.price);
      const quantity = number(fill?.quantity);
      const occurredAt = timestamp(fill?.occurredAt);
      const feeUsd = number(fill?.feeUsd);
      const referencePrice = number(
        fill?.referencePrice
      );
      const reportedPnlUsd = number(
        fill?.reportedPnlUsd
      );

      if (!fillId || ids.has(fillId)) {
        throw campaignError(
          `fillId_invalid_or_duplicate:${index}`
        );
      }
      ids.add(fillId);

      if (
        !FILL_KINDS.has(kind) ||
        price == null ||
        price <= 0 ||
        quantity == null ||
        quantity <= 0 ||
        occurredAt == null ||
        feeUsd == null ||
        feeUsd < 0 ||
        (
          referencePrice != null &&
          referencePrice <= 0
        )
      ) {
        throw campaignError(
          `fill_invalid:${index}`
        );
      }

      return {
        fillId,
        kind,
        price,
        quantity,
        occurredAt,
        feeUsd,
        referencePrice,
        reportedPnlUsd,
      };
    }
  ).sort(
    (a, b) =>
      a.occurredAt - b.occurredAt
  );

  const firstCloseIndex =
    normalized.findIndex(
      (fill) => fill.kind === "CLOSE"
    );

  if (
    firstCloseIndex < 1 ||
    normalized
      .slice(firstCloseIndex)
      .some((fill) => fill.kind === "OPEN")
  ) {
    throw campaignError(
      "campaign_requires_open_group_then_close_group"
    );
  }

  const opens = normalized.slice(
    0,
    firstCloseIndex
  );
  const closes = normalized.slice(
    firstCloseIndex
  );
  const openQuantity = opens.reduce(
    (sum, fill) => sum + fill.quantity,
    0
  );
  const closeQuantity = closes.reduce(
    (sum, fill) => sum + fill.quantity,
    0
  );

  if (closeQuantity - openQuantity > EPSILON) {
    throw campaignError(
      "close_quantity_exceeds_open_quantity"
    );
  }

  const entryNotionalUsd = opens.reduce(
    (sum, fill) =>
      sum + fill.price * fill.quantity,
    0
  );
  const exitNotionalUsd = closes.reduce(
    (sum, fill) =>
      sum + fill.price * fill.quantity,
    0
  );
  const avgEntry =
    entryNotionalUsd / openQuantity;
  const avgExit =
    exitNotionalUsd / closeQuantity;
  const direction =
    positionSide === "LONG" ? 1 : -1;
  const grossPnlUsd =
    (avgExit - avgEntry) *
    closeQuantity *
    direction;
  const feesUsd = normalized.reduce(
    (sum, fill) => sum + fill.feeUsd,
    0
  );
  const fundingUsd = number(
    input?.fundingUsd
  );
  const volumeUsd =
    entryNotionalUsd + exitNotionalUsd;
  const netPnlUsd =
    fundingUsd == null
      ? null
      : grossPnlUsd - feesUsd + fundingUsd;
  const remainingQuantity = Math.max(
    0,
    openQuantity - closeQuantity
  );
  const isClosed =
    remainingQuantity <= EPSILON;
  const allReferencesPresent =
    normalized.every(
      (fill) => fill.referencePrice != null
    );
  const slippageUsd =
    allReferencesPresent
      ? normalized.reduce(
          (sum, fill) => {
            const sideMultiplier =
              fill.kind === "OPEN"
                ? direction
                : -direction;

            return sum +
              sideMultiplier *
              (
                fill.price -
                fill.referencePrice
              ) *
              fill.quantity;
          },
          0
        )
      : null;
  const reportedRealizedPnlUsd =
    normalized.some(
      (fill) =>
        fill.reportedPnlUsd != null
    )
      ? normalized.reduce(
          (sum, fill) =>
            sum +
            (fill.reportedPnlUsd ?? 0),
          0
        )
      : null;
  const marginUsd = number(
    input?.marginUsd
  );
  const leverage = number(
    input?.leverage
  );

  if (
    (marginUsd != null && marginUsd <= 0) ||
    (leverage != null && leverage <= 0)
  ) {
    throw campaignError(
      "margin_or_leverage_invalid"
    );
  }
  const stop = input?.protectiveStop;
  const stopQuantity = number(
    stop?.quantity
  );
  const stopPrice = number(
    stop?.stopPrice
  );
  let slCoverage = {
    status: "UNKNOWN",
    stopPrice: null,
    coveredQuantity: null,
    requiredQuantity: round(
      remainingQuantity
    ),
    coveragePct: null,
  };

  if (
    stop?.confirmed === true &&
    stopQuantity != null &&
    stopQuantity >= 0 &&
    stopPrice != null &&
    stopPrice > 0
  ) {
    const coveragePct =
      remainingQuantity <= EPSILON
        ? 100
        : Math.min(
            100,
            stopQuantity /
              remainingQuantity *
              100
          );

    slCoverage = {
      status:
        coveragePct >= 100
          ? "FULL"
          : (
              coveragePct > 0
                ? "PARTIAL"
                : "NONE"
            ),
      stopPrice: round(stopPrice),
      coveredQuantity: round(
        stopQuantity
      ),
      requiredQuantity: round(
        remainingQuantity
      ),
      coveragePct: round(
        coveragePct
      ),
    };
  }

  const missingFields = [];
  if (fundingUsd == null) {
    missingFields.push("fundingUsd");
  }
  if (marginUsd == null) {
    missingFields.push("marginUsd");
  }
  if (leverage == null) {
    missingFields.push("leverage");
  }
  if (!allReferencesPresent) {
    missingFields.push(
      "fills[].referencePrice"
    );
  }
  if (
    remainingQuantity > EPSILON &&
    slCoverage.status === "UNKNOWN"
  ) {
    missingFields.push(
      "protectiveStop.confirmed"
    );
  }

  const orderCancelRequired =
    typeof input?.orderCancelRequired ===
      "boolean"
      ? input.orderCancelRequired
      : null;
  const orderCancelConfirmed =
    typeof input?.orderCancelConfirmed ===
      "boolean"
      ? input.orderCancelConfirmed
      : null;

  if (orderCancelRequired == null) {
    missingFields.push(
      "orderCancelRequired"
    );
  }
  if (
    orderCancelRequired === true &&
    orderCancelConfirmed !== true
  ) {
    missingFields.push(
      "orderCancelConfirmed"
    );
  }

  const warnings = [];
  if (reportedRealizedPnlUsd != null) {
    warnings.push(
      "reported_pnl_not_used_for_net_to_avoid_fee_double_count"
    );
  }
  if (
    orderCancelRequired === true &&
    orderCancelConfirmed !== true
  ) {
    warnings.push(
      "order_cancellation_unconfirmed"
    );
  }

  return {
    campaignId,
    campaignCount: 1,
    instrument,
    timeHorizon,
    strategyTag:
      typeof input?.strategyTag === "string"
        ? input.strategyTag
        : null,
    positionSide,
    riskBucketHint:
      typeof input?.riskBucketHint === "string"
        ? input.riskBucketHint
        : null,
    entryAt: opens[0].occurredAt,
    exitAt:
      isClosed
        ? closes.at(-1).occurredAt
        : null,
    avgEntry: round(avgEntry),
    avgExit: round(avgExit),
    openQuantity: round(openQuantity),
    closeQuantity: round(closeQuantity),
    remainingQuantity: round(
      remainingQuantity
    ),
    notionalUsd: round(
      entryNotionalUsd
    ),
    entryNotionalUsd: round(
      entryNotionalUsd
    ),
    exitNotionalUsd: round(
      exitNotionalUsd
    ),
    marginUsd: round(marginUsd),
    leverage: round(leverage),
    fees: round(feesUsd),
    feesUsd: round(feesUsd),
    funding: round(fundingUsd),
    fundingUsd: round(fundingUsd),
    grossPnlUsd: round(grossPnlUsd),
    netPnl: round(netPnlUsd),
    netPnlUsd: round(netPnlUsd),
    reportedRealizedPnlUsd: round(
      reportedRealizedPnlUsd
    ),
    pnlAccounting:
      "price_pnl_minus_fees_plus_signed_funding",
    volumeUsd: round(volumeUsd),
    pnlPerMillionUsd:
      netPnlUsd == null
        ? null
        : round(
            netPnlUsd /
              volumeUsd *
              1_000_000
          ),
    costPerMillionUsd:
      fundingUsd == null
        ? null
        : round(
            (feesUsd - fundingUsd) /
              volumeUsd *
              1_000_000
          ),
    slippageUsd: round(slippageUsd),
    holdSeconds:
      isClosed
        ? round(
            (
              closes.at(-1).occurredAt -
              opens[0].occurredAt
            ) / 1_000
          )
        : null,
    fillCount: normalized.length,
    isClosed,
    slCoverage,
    orderCancelRequired,
    orderCancelConfirmed,
    dataQuality: {
      status:
        missingFields.length
          ? "INCOMPLETE"
          : "NORMAL",
      missingFields:
        [...new Set(missingFields)],
      reportedPnlUsedForNet: false,
    },
    warnings,
  };
}

export default function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      ok: false,
      error: "method_not_allowed",
    });
  }

  try {
    return res.status(200).json({
      ok: true,
      campaign:
        aggregateCampaign(req.body),
    });
  } catch (error) {
    return res
      .status(error?.statusCode ?? 500)
      .json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
  }
}

export { aggregateCampaign };

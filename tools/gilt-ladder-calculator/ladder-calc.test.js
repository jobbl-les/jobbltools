/**
 * Unit tests for ladder-calc.js, using Node's built-in test runner — no
 * npm install required. Run with:
 *
 *   node --test ladder-calc.test.js
 */
"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var GiltLadder = require("./ladder-calc.js");

var SETTLEMENT = "2026-01-05";

function approx(actual, expected, tolerance, message) {
  var tol = tolerance === undefined ? 0.001 : tolerance;
  assert.ok(
    Math.abs(actual - expected) <= tol,
    (message || "") + " — expected " + expected + ", got " + actual
  );
}

/**
 * Builds a synthetic conventional gilt with a semi-annual coupon schedule
 * running back from redemptionDate for `periods` payments (all in the
 * future relative to SETTLEMENT, since these fixtures always use
 * redemptionDate far enough ahead).
 */
function makeGilt(isin, couponPercent, redemptionDate, priceMid, periods) {
  var schedule = [];
  var d = new Date(redemptionDate + "T00:00:00Z");
  var dates = [];
  for (var i = 0; i < periods; i++) {
    var dd = new Date(d);
    dd.setUTCMonth(dd.getUTCMonth() - 6 * i);
    dates.unshift(dd.toISOString().slice(0, 10));
  }
  dates.forEach(function (couponDate, idx) {
    var exDiv = new Date(couponDate + "T00:00:00Z");
    exDiv.setUTCDate(exDiv.getUTCDate() - 7);
    schedule.push({
      couponDate: couponDate,
      exDividendDate: exDiv.toISOString().slice(0, 10),
      isFinal: idx === dates.length - 1
    });
  });
  return {
    isin: isin,
    name: isin + " " + couponPercent + "% " + redemptionDate,
    couponPercent: couponPercent,
    indexLinked: false,
    redemptionDate: redemptionDate,
    price: { mid: priceMid, last: priceMid },
    couponSchedule: schedule
  };
}

// A small synthetic universe: 6 gilts, one per coupon-month bucket
// (Jan/Jul .. Jun/Dec), staggered maturities 2-12 years out, and a mix of
// coupon sizes/prices so yield and capital-gain-to-maturity meaningfully
// differ between them.
var UNIVERSE = [
  makeGilt("G-JAN", 4.0, "2028-01-15", 99.0, 6), // bucket 0 (Jan)
  makeGilt("G-FEB", 0.5, "2030-02-20", 85.0, 10), // bucket 1 (Feb) — low coupon, deep discount
  makeGilt("G-MAR", 4.5, "2031-03-10", 101.5, 12), // bucket 2 (Mar) — small premium
  makeGilt("G-APR", 1.25, "2033-04-05", 88.0, 16), // bucket 3 (Apr)
  makeGilt("G-MAY", 4.25, "2035-05-25", 100.5, 20), // bucket 4 (May)
  makeGilt("G-JUN", 0.75, "2037-06-30", 78.0, 24), // bucket 5 (Jun) — deepest discount
  // Long-dated extras, maturing beyond every horizonEnd used by the tests
  // above (2037-12-31 or earlier) so they never compete for an *initial*
  // slot — they exist purely as reinvestment targets for the rolling-ladder
  // tests further down, which use a longer horizon.
  makeGilt("G-JAN2", 3.5, "2045-01-20", 97.0, 6),
  makeGilt("G-MAR2", 2.0, "2050-03-15", 90.0, 8),
  makeGilt("G-JUN2", 1.5, "2048-06-10", 89.0, 8)
];

function baseParams(overrides) {
  return Object.assign(
    {
      investmentAmount: 60000,
      settlementDate: SETTLEMENT,
      horizonEnd: "2037-12-31",
      minRungs: 6,
      maxRungs: 6,
      roundingUnit: 1000,
      frequencyWeight: 1,
      accountType: "isa",
      rungSizing: "equal",
      ladderType: "terminal",
      reinvestCoupons: false
    },
    overrides || {}
  );
}

// =====================================================================
// accruedInterestPercent / dirtyPrice
// =====================================================================

test("accrued interest is zero exactly on a coupon date", function () {
  var g = makeGilt("X", 4, "2030-06-15", 100, 4);
  // The coupon schedule only lists future coupons — the *previous* one
  // (start of the current accrual period, where accrued interest is zero)
  // is 6 months before the first listed entry.
  var d = new Date(g.couponSchedule[0].couponDate + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - 6);
  var previousCouponDate = d.toISOString().slice(0, 10);
  approx(GiltLadder.accruedInterestPercent(g, previousCouponDate), 0);
});

test("dirtyPrice adds accrued interest to the clean price", function () {
  var g = makeGilt("X", 4, "2030-06-15", 100, 4);
  var accrued = GiltLadder.accruedInterestPercent(g, "2029-03-01");
  approx(GiltLadder.dirtyPrice(g, "2029-03-01"), 100 + accrued);
});

// =====================================================================
// estimateYield / capitalGainAnnualizedPercent
// =====================================================================

test("yield equals coupon rate at par with zero accrued interest", function () {
  var g = makeGilt("X", 4, "2030-01-05", 100, 6);
  // Settle exactly at the start of the accrual period covering the first
  // listed coupon (6 months before it) — zero accrued interest, and every
  // listed coupon plus redemption is still receivable.
  var d = new Date(g.couponSchedule[0].couponDate + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - 6);
  var settlement = d.toISOString().slice(0, 10);
  var y = GiltLadder.estimateYield(g, settlement, 100);
  approx(y, 0.04, 0.001);
});

test("capital gain to maturity is positive below par, negative above par", function () {
  var below = makeGilt("A", 2, "2030-01-05", 90, 6);
  var above = makeGilt("B", 2, "2030-01-05", 110, 6);
  assert.ok(GiltLadder.capitalGainAnnualizedPercent(below, SETTLEMENT) > 0);
  assert.ok(GiltLadder.capitalGainAnnualizedPercent(above, SETTLEMENT) < 0);
});

// =====================================================================
// couponMonthBucket
// =====================================================================

test("gilts paying 6 months apart share the same bucket", function () {
  var jan = makeGilt("A", 4, "2030-01-15", 100, 4);
  var jul = makeGilt("B", 4, "2031-07-15", 100, 4);
  assert.equal(GiltLadder.couponMonthBucket(jan), GiltLadder.couponMonthBucket(jul));
});

test("the 6 canonical buckets are all distinct", function () {
  var buckets = UNIVERSE.map(GiltLadder.couponMonthBucket);
  assert.equal(new Set(buckets).size, 6);
});

// =====================================================================
// computeFeasibleRungCount
// =====================================================================

test("uses the maximum feasible rung count within [min, max]", function () {
  var r = GiltLadder.computeFeasibleRungCount(60000, 3, 8, null, null);
  assert.equal(r.count, 8);
  assert.equal(r.warning, null);
});

test("tightens the range using min/max nominal per rung", function () {
  var r = GiltLadder.computeFeasibleRungCount(60000, 3, 20, 5000, 15000);
  // hi = floor(60000/5000) = 12, lo = ceil(60000/15000) = 4 -> capped at 12
  assert.equal(r.count, 12);
});

test("falls back with a warning when constraints are infeasible", function () {
  var r = GiltLadder.computeFeasibleRungCount(10000, 5, 10, 5000, 6000);
  // lo = ceil(10000/6000) = 2 -> max(lo,minRungs)=5 ; hi = floor(10000/5000) = 2 -> hi<lo
  assert.ok(r.warning);
  assert.equal(r.count, 5);
});

// =====================================================================
// buildLadder — selection
// =====================================================================

test("selects one rung per coupon-month bucket when frequency is fully weighted", function () {
  var result = GiltLadder.buildLadder(UNIVERSE, baseParams({ frequencyWeight: 1 }));
  assert.equal(result.rungs.length, 6);
  var buckets = result.rungs.map(function (r) { return GiltLadder.couponMonthBucket(r.gilt); });
  assert.equal(new Set(buckets).size, 6, "expected all 6 rungs to use distinct coupon-month buckets");
});

test("prefers higher-yielding gilts when frequency weight is zero (ISA account)", function () {
  // With only 2 rungs requested and frequency weight 0, selection should
  // ignore coupon-month diversity and just chase return + maturity fit.
  var result = GiltLadder.buildLadder(
    UNIVERSE,
    baseParams({ minRungs: 2, maxRungs: 2, frequencyWeight: 0, accountType: "isa" })
  );
  assert.equal(result.rungs.length, 2);
  // G-JUN (deep discount, longest-dated) should score well on return; just
  // assert the engine picked *some* valid, non-duplicate pair.
  var isins = result.rungs.map(function (r) { return r.gilt.isin; });
  assert.equal(new Set(isins).size, isins.length);
});

test("taxable accounts tilt selection toward capital-gain-to-maturity over coupon yield", function () {
  // Two candidates maturing on the same date: one high-coupon trading over
  // par (income-heavy), one low-coupon deep-discount (capital-gain-heavy)
  // with a similar-ish total return. A taxable account with the frequency
  // slider fully toward yield should prefer the discount gilt.
  var incomeHeavy = makeGilt("INC", 6.0, "2032-01-15", 108, 12);
  var gainHeavy = makeGilt("GAIN", 0.25, "2032-01-15", 82, 12);
  var pool = [incomeHeavy, gainHeavy];

  var taxableResult = GiltLadder.buildLadder(
    pool,
    baseParams({ minRungs: 1, maxRungs: 1, frequencyWeight: 0, accountType: "taxable", horizonEnd: "2033-01-01" })
  );
  assert.equal(taxableResult.rungs[0].gilt.isin, "GAIN");
});

test("ISA accounts do not apply the capital-gain tilt — pure return decides", function () {
  var incomeHeavy = makeGilt("INC2", 6.0, "2032-01-15", 90, 12); // deliberately cheap AND high coupon -> clearly best total return
  var gainHeavy = makeGilt("GAIN2", 0.25, "2032-01-15", 95, 12);
  var pool = [incomeHeavy, gainHeavy];

  var isaResult = GiltLadder.buildLadder(
    pool,
    baseParams({ minRungs: 1, maxRungs: 1, frequencyWeight: 0, accountType: "isa", horizonEnd: "2033-01-01" })
  );
  assert.equal(isaResult.rungs[0].gilt.isin, "INC2");
});

test("respects an exclusion list", function () {
  var result = GiltLadder.buildLadder(
    UNIVERSE,
    baseParams({ minRungs: 6, maxRungs: 6, excludeIsins: ["G-JAN"] })
  );
  var isins = result.rungs.map(function (r) { return r.gilt.isin; });
  assert.ok(isins.indexOf("G-JAN") === -1);
});

test("only offers gilts maturing within the horizon", function () {
  var result = GiltLadder.buildLadder(UNIVERSE, baseParams({ horizonEnd: "2031-06-01", minRungs: 6, maxRungs: 6 }));
  result.rungs.forEach(function (r) {
    assert.ok(r.gilt.redemptionDate <= "2031-06-01");
  });
  // Only G-JAN, G-FEB, G-MAR mature by then -> fewer rungs than requested, with a warning.
  assert.equal(result.rungs.length, 3);
  assert.ok(result.warnings.some(function (w) { return /fewer rungs/.test(w); }));
});

test("duration cap excludes long-dated gilts beyond the allowed share", function () {
  var withoutCap = GiltLadder.buildLadder(UNIVERSE, baseParams({ minRungs: 6, maxRungs: 6, frequencyWeight: 0 }));
  var withCap = GiltLadder.buildLadder(
    UNIVERSE,
    baseParams({ minRungs: 6, maxRungs: 6, frequencyWeight: 0, durationCapYears: 6, durationCapPercent: 20 })
  );
  function longDatedShare(result) {
    var longCount = result.rungs.filter(function (r) {
      return (new Date(r.gilt.redemptionDate) - new Date(SETTLEMENT)) / (1000 * 60 * 60 * 24 * 365.25) > 6;
    }).length;
    return longCount / result.rungs.length;
  }
  assert.ok(longDatedShare(withCap) <= longDatedShare(withoutCap));
});

// =====================================================================
// sizeRungs / buildBuyInstructions
// =====================================================================

test("equal sizing rounds nominal to the rounding unit and clamps to position-size limits", function () {
  var result = GiltLadder.buildLadder(
    UNIVERSE,
    baseParams({ minRungs: 6, maxRungs: 6, roundingUnit: 500, minNominalPerRung: 1000, maxNominalPerRung: 20000 })
  );
  result.rungs.forEach(function (r) {
    assert.equal(r.nominal % 500, 0);
    assert.ok(r.nominal >= 1000 && r.nominal <= 20000);
  });
});

test("buy instructions report cumulative cost and any shortfall against the investment amount", function () {
  var params = baseParams({ minRungs: 6, maxRungs: 6, investmentAmount: 60000 });
  var result = GiltLadder.buildLadder(UNIVERSE, params);
  var instructions = GiltLadder.buildBuyInstructions(result.rungs, params);
  approx(instructions.totalCost, instructions.lines[instructions.lines.length - 1].cumulativeCost);
  approx(instructions.shortfall, params.investmentAmount - instructions.totalCost);
});

// =====================================================================
// projectSchedule — terminal ladder
// =====================================================================

test("terminal ladder never emits a reinvestment event", function () {
  var params = baseParams({ minRungs: 6, maxRungs: 6, ladderType: "terminal" });
  var result = GiltLadder.buildLadder(UNIVERSE, params);
  var schedule = GiltLadder.projectSchedule(result.rungs, UNIVERSE, params);
  assert.ok(!schedule.events.some(function (e) { return e.type === "reinvestment"; }));
});

test("terminal ladder: total redeemed nominal equals total nominal bought", function () {
  var params = baseParams({ minRungs: 6, maxRungs: 6, ladderType: "terminal" });
  var result = GiltLadder.buildLadder(UNIVERSE, params);
  var schedule = GiltLadder.projectSchedule(result.rungs, UNIVERSE, params);
  var redeemed = schedule.events.filter(function (e) { return e.type === "redemption"; }).reduce(function (s, e) { return s + e.amount; }, 0);
  var bought = result.rungs.reduce(function (s, r) { return s + r.nominal; }, 0);
  approx(redeemed, bought, 0.01);
  assert.equal(schedule.openPositions.length, 0, "a terminal ladder should have nothing still open at the horizon end");
});

test("cumulative income and cumulative capital returned are monotonically non-decreasing and match running totals", function () {
  var params = baseParams({ minRungs: 6, maxRungs: 6 });
  var result = GiltLadder.buildLadder(UNIVERSE, params);
  var schedule = GiltLadder.projectSchedule(result.rungs, UNIVERSE, params);
  var runningIncome = 0;
  var runningCapital = 0;
  schedule.events.forEach(function (e) {
    if (e.type === "coupon") runningIncome += e.amount;
    if (e.type === "redemption") runningCapital += e.amount;
    approx(e.cumulativeIncome, runningIncome, 0.01);
    approx(e.cumulativeCapitalReturned, runningCapital, 0.01);
  });
});

test("events are sorted by date", function () {
  var params = baseParams({ minRungs: 6, maxRungs: 6 });
  var result = GiltLadder.buildLadder(UNIVERSE, params);
  var schedule = GiltLadder.projectSchedule(result.rungs, UNIVERSE, params);
  for (var i = 1; i < schedule.events.length; i++) {
    assert.ok(schedule.events[i].date >= schedule.events[i - 1].date);
  }
});

// =====================================================================
// projectSchedule — rolling ladder
// =====================================================================

test("rolling ladder reinvests a matured rung's proceeds into a new gilt before the horizon end", function () {
  var params = baseParams({
    minRungs: 6,
    maxRungs: 6,
    ladderType: "rolling",
    horizonEnd: "2040-01-01"
  });
  var result = GiltLadder.buildLadder(UNIVERSE, params);
  var schedule = GiltLadder.projectSchedule(result.rungs, UNIVERSE, params);
  var reinvestments = schedule.events.filter(function (e) { return e.type === "reinvestment"; });
  assert.ok(reinvestments.length >= 1, "expected at least one reinvestment once the earliest rung (G-JAN, 2028) matures well before 2040");
});

test("reinvested redemptions are excluded from capital-returned and IRR (no double counting)", function () {
  var params = baseParams({ minRungs: 6, maxRungs: 6, ladderType: "rolling", horizonEnd: "2040-01-01" });
  var result = GiltLadder.buildLadder(UNIVERSE, params);
  var schedule = GiltLadder.projectSchedule(result.rungs, UNIVERSE, params);
  var summary = GiltLadder.computeSummary(result.rungs, schedule, params);

  var reinvestedRedemptions = schedule.events.filter(function (e) { return e.type === "redemption" && e.reinvested; });
  assert.ok(reinvestedRedemptions.length > 0, "expected at least one rung to roll forward in this scenario");

  var manualCapitalReturned = schedule.events
    .filter(function (e) { return e.type === "redemption" && !e.reinvested; })
    .reduce(function (s, e) { return s + e.amount; }, 0);
  approx(summary.totalCapitalReturned, manualCapitalReturned, 0.01);

  // A sane blended IRR for this universe (coupons 0.25%-4.5%, prices 78-101.5)
  // should sit in the low single digits — not balloon from double-counting
  // capital that was actually redeployed into the next rung rather than
  // handed back (the bug this test guards against inflated it to ~20%).
  assert.ok(summary.blendedIrr > -0.02 && summary.blendedIrr < 0.1, "blendedIrr out of sane range: " + summary.blendedIrr);
});

test("rolling ladder leaves an open position for whatever hasn't matured by the horizon end", function () {
  var params = baseParams({ minRungs: 6, maxRungs: 6, ladderType: "rolling", horizonEnd: "2029-01-01" });
  var result = GiltLadder.buildLadder(UNIVERSE, params);
  var schedule = GiltLadder.projectSchedule(result.rungs, UNIVERSE, params);
  assert.ok(schedule.openPositions.length >= 1);
});

test("an open position below par is marked to market, not credited at full face value", function () {
  // A short gilt matures well before the horizon end and (rolling) rolls
  // into G-FEB (0.5% coupon, price 85, matures 2030-02-20) — the only other
  // gilt in this pool, and the only maturity beyond the horizon end, so it
  // ends up as an open position. Its nominal was bought at a discount and
  // shouldn't be valued at its full (post-discount-realised) face value
  // while it's still years from its own maturity.
  var shortGilt = makeGilt("SHORT", 4, "2027-06-01", 100, 4);
  var pool = [shortGilt, UNIVERSE.find(function (g) { return g.isin === "G-FEB"; })];
  var params = baseParams({ minRungs: 1, maxRungs: 1, ladderType: "rolling", horizonEnd: "2029-01-01", frequencyWeight: 0 });
  var result = GiltLadder.buildLadder(pool, params);
  var schedule = GiltLadder.projectSchedule(result.rungs, pool, params);
  var summary = GiltLadder.computeSummary(result.rungs, schedule, params);

  var openFaceValue = schedule.openPositions.reduce(function (s, p) { return s + p.nominal; }, 0);
  assert.ok(openFaceValue > 0, "expected the reinvestment into G-FEB to still be open at the horizon end");
  assert.ok(
    summary.capitalStillInLadder < openFaceValue,
    "expected mark-to-market value (" + summary.capitalStillInLadder + ") below face value (" + openFaceValue + ") for a discount gilt still open"
  );
});

// =====================================================================
// solveIrr
// =====================================================================

test("solveIrr recovers a known rate for a simple two-cashflow example", function () {
  // Invest 1000 today, receive 1050 in exactly 1 year -> ~5% simple, close
  // enough under semi-annual compounding to sanity-check against.
  var cashflows = [
    { date: "2026-01-01", amount: -1000 },
    { date: "2027-01-01", amount: 1050 }
  ];
  var irr = GiltLadder.solveIrr(cashflows, "2026-01-01");
  approx(irr, 0.0494, 0.001); // (1+r/2)^2 = 1.05 -> r ≈ 0.04939
});

test("solveIrr returns null with fewer than 2 cashflows", function () {
  assert.equal(GiltLadder.solveIrr([{ date: "2026-01-01", amount: -1000 }], "2026-01-01"), null);
});

// =====================================================================
// computeSummary
// =====================================================================

test("blended running yield is annual coupon income divided by total cost", function () {
  var params = baseParams({ minRungs: 6, maxRungs: 6 });
  var result = GiltLadder.buildLadder(UNIVERSE, params);
  var schedule = GiltLadder.projectSchedule(result.rungs, UNIVERSE, params);
  var summary = GiltLadder.computeSummary(result.rungs, schedule, params);
  var annualIncome = result.rungs.reduce(function (s, r) { return s + (r.nominal * r.gilt.couponPercent) / 100; }, 0);
  approx(summary.blendedRunningYield, annualIncome / summary.totalCost, 0.0001);
});

test("income frequency achieved counts distinct calendar months in year one", function () {
  var params = baseParams({ minRungs: 6, maxRungs: 6, frequencyWeight: 1, horizonEnd: "2037-12-31" });
  var result = GiltLadder.buildLadder(UNIVERSE, params);
  var schedule = GiltLadder.projectSchedule(result.rungs, UNIVERSE, params);
  var summary = GiltLadder.computeSummary(result.rungs, schedule, params);
  assert.ok(summary.monthsWithPaymentsCount >= 1 && summary.monthsWithPaymentsCount <= 12);
});

test("terminal ladder has zero capital still in the ladder once fully projected", function () {
  var params = baseParams({ minRungs: 6, maxRungs: 6, ladderType: "terminal" });
  var result = GiltLadder.buildLadder(UNIVERSE, params);
  var schedule = GiltLadder.projectSchedule(result.rungs, UNIVERSE, params);
  var summary = GiltLadder.computeSummary(result.rungs, schedule, params);
  approx(summary.capitalStillInLadder, 0);
});

test("projectedValueAtHorizonEnd is only computed when reinvestCoupons is true", function () {
  var params = baseParams({ minRungs: 6, maxRungs: 6, reinvestCoupons: false });
  var result = GiltLadder.buildLadder(UNIVERSE, params);
  var schedule = GiltLadder.projectSchedule(result.rungs, UNIVERSE, params);
  var summaryNoReinvest = GiltLadder.computeSummary(result.rungs, schedule, params);
  assert.equal(summaryNoReinvest.projectedValueAtHorizonEnd, null);

  var paramsReinvest = baseParams({ minRungs: 6, maxRungs: 6, reinvestCoupons: true });
  var summaryReinvest = GiltLadder.computeSummary(result.rungs, schedule, paramsReinvest);
  assert.ok(summaryReinvest.projectedValueAtHorizonEnd > 0);
});

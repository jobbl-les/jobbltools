/**
 * Unit tests for calc.js, using Node's built-in test runner and assert
 * module — no npm install required. Run with:
 *
 *   node --test calc.test.js
 */
"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var GiltCalc = require("./calc.js");

function approx(actual, expected, tolerance, message) {
  var tol = tolerance === undefined ? 0.001 : tolerance;
  assert.ok(
    Math.abs(actual - expected) <= tol,
    (message || "") + " — expected " + expected + ", got " + actual
  );
}

// A real gilt from data/gilts.json (4 1/4% Treasury Gilt 2027, redemption
// 2027-12-07, coupons 7 Jun / 7 Dec) fixed as of a known point in time so
// these tests don't depend on today's date.
var GILT = {
  isin: "GB00B16NNR78",
  name: "4 1/4% TREASURY GILT 27",
  couponPercent: 4.25,
  indexLinked: false,
  redemptionDate: "2027-12-07",
  price: { last: 99.67, mid: 99.715 },
  couponSchedule: [
    { couponDate: "2026-12-07", exDividendDate: "2026-11-26", isFinal: false },
    { couponDate: "2027-06-07", exDividendDate: "2027-05-26", isFinal: false },
    { couponDate: "2027-12-07", exDividendDate: "2027-11-26", isFinal: true }
  ]
};

// 2026-06-07 is exactly the previous coupon date implied by the first
// schedule entry (2026-12-07, 6 months later) — settling exactly on a
// coupon date means zero accrued interest, so clean price == dirty price
// and these identities hold exactly.
var ZERO_ACCRUED_SETTLEMENT = "2026-06-07";

test("nominal is derived from investment amount and price (price per £100 nominal)", function () {
  var result = GiltCalc.computeCashflows(GILT, 1000, ZERO_ACCRUED_SETTLEMENT, 100);
  approx(result.nominal, 1000); // at par, £1000 buys £1000 nominal
});

test("buying below par: nominal exceeds cash invested", function () {
  var result = GiltCalc.computeCashflows(GILT, 1000, ZERO_ACCRUED_SETTLEMENT, 50);
  approx(result.nominal, 2000); // half price -> double the nominal
});

test("well before the first ex-dividend date: every coupon plus redemption is included", function () {
  var result = GiltCalc.computeCashflows(GILT, 1000, "2026-09-22", 100);
  var coupons = result.cashflows.filter(function (c) { return c.type === "coupon"; });
  assert.equal(coupons.length, 3);
  assert.deepEqual(
    coupons.map(function (c) { return c.date; }),
    ["2026-12-07", "2027-06-07", "2027-12-07"]
  );
  var redemption = result.cashflows.filter(function (c) { return c.type === "redemption"; });
  assert.equal(redemption.length, 1);
  assert.equal(redemption[0].date, "2027-12-07");
});

test("settling on the ex-dividend date itself excludes that coupon (goes to the previous holder)", function () {
  var result = GiltCalc.computeCashflows(GILT, 1000, "2026-11-26", 100);
  var couponDates = result.cashflows
    .filter(function (c) { return c.type === "coupon"; })
    .map(function (c) { return c.date; });
  assert.deepEqual(couponDates, ["2027-06-07", "2027-12-07"]);
});

test("settling the day before the ex-dividend date includes that coupon", function () {
  var result = GiltCalc.computeCashflows(GILT, 1000, "2026-11-25", 100);
  var couponDates = result.cashflows
    .filter(function (c) { return c.type === "coupon"; })
    .map(function (c) { return c.date; });
  assert.deepEqual(couponDates, ["2026-12-07", "2027-06-07", "2027-12-07"]);
});

test("coupon amount is half the annual rate applied to nominal (semi-annual payments)", function () {
  var result = GiltCalc.computeCashflows(GILT, 1000, ZERO_ACCRUED_SETTLEMENT, 100);
  var firstCoupon = result.cashflows.find(function (c) { return c.type === "coupon"; });
  approx(firstCoupon.amount, 1000 * 0.0425 / 2); // 21.25
});

test("capital gain is positive when bought below par, negative (a loss) when bought above par", function () {
  var below = GiltCalc.computeCashflows(GILT, 1000, "2026-09-22", 95);
  assert.ok(below.totals.capitalGain > 0);

  var above = GiltCalc.computeCashflows(GILT, 1000, "2026-09-22", 105);
  assert.ok(above.totals.capitalGain < 0);
});

test("invariant: total received = invested + capital gain + coupon income", function () {
  var result = GiltCalc.computeCashflows(GILT, 1000, "2026-09-22", 97.5);
  approx(
    result.totals.totalReceived,
    result.totals.invested + result.totals.capitalGain + result.totals.couponIncomeTotal
  );
});

test("every cashflow is labelled taxable (coupon) or not (redemption/capital)", function () {
  var result = GiltCalc.computeCashflows(GILT, 1000, "2026-09-22", 100);
  result.cashflows.forEach(function (c) {
    assert.equal(c.taxable, c.type === "coupon");
  });
});

test("a gilt with only its final coupon left produces exactly one coupon + one redemption", function () {
  var shortGilt = {
    redemptionDate: "2026-10-22",
    couponPercent: 0.375,
    couponSchedule: [{ couponDate: "2026-10-22", exDividendDate: "2026-10-13", isFinal: true }]
  };
  var result = GiltCalc.computeCashflows(shortGilt, 500, "2026-09-22", 99.73);
  assert.equal(result.cashflows.length, 2);
});

test("throws if settlement date is after redemption", function () {
  assert.throws(function () {
    GiltCalc.computeCashflows(GILT, 1000, "2028-01-01", 100);
  }, /after redemption/);
});

test("throws on non-positive investment amount", function () {
  assert.throws(function () {
    GiltCalc.computeCashflows(GILT, 0, "2026-09-22", 100);
  });
});

// =====================================================================
// accruedInterestPercent / dirty price
// =====================================================================

test("accrued interest is zero exactly on a coupon date", function () {
  approx(GiltCalc.accruedInterestPercent(GILT, ZERO_ACCRUED_SETTLEMENT), 0);
});

test("accrued interest matches a hand-computed Actual/Actual example", function () {
  // Period is 2026-06-07 -> 2026-12-07 (183 days). Settling 2026-09-22 is
  // 107 days into that period.
  var accrued = GiltCalc.accruedInterestPercent(GILT, "2026-09-22");
  approx(accrued, (4.25 / 2) * (107 / 183), 0.0001);
});

test("computeCashflows' dirtyPrice and accruedInterest are consistent with nominal", function () {
  var result = GiltCalc.computeCashflows(GILT, 1000, "2026-09-22", 99.715);
  approx(result.dirtyPrice, result.cleanPrice + GiltCalc.accruedInterestPercent(GILT, "2026-09-22"));
  approx(result.accruedInterest, (result.nominal * GiltCalc.accruedInterestPercent(GILT, "2026-09-22")) / 100);
  approx(result.nominal, (1000 * 100) / result.dirtyPrice);
});

// =====================================================================
// estimateYield (gross redemption yield)
// =====================================================================

test("yield equals coupon rate for a bond priced exactly at par with zero accrued interest", function () {
  var y = GiltCalc.estimateYield(GILT, ZERO_ACCRUED_SETTLEMENT, 100);
  approx(y, 0.0425, 0.001);
});

test("yield is higher when the price is lower, all else equal", function () {
  var yLow = GiltCalc.estimateYield(GILT, "2026-09-22", 90);
  var yHigh = GiltCalc.estimateYield(GILT, "2026-09-22", 110);
  assert.ok(yLow > yHigh);
});

test("round-trips exactly against a closed-form single-cashflow (zero-coupon-like) price", function () {
  var settlementDate = "2026-09-22";
  var couponDate = "2027-09-22";
  var zeroCouponGilt = {
    couponPercent: 0,
    redemptionDate: couponDate,
    price: { mid: 0 }, // unused, priceOverride is always passed below
    couponSchedule: [{ couponDate: couponDate, exDividendDate: "2027-09-13", isFinal: true }]
  };

  var targetYield = 0.05;
  var t = (new Date(couponDate) - new Date(settlementDate)) / (1000 * 60 * 60 * 24 * 365.25);
  var price = 100 * Math.pow(1 + targetYield / 2, -2 * t);

  var y = GiltCalc.estimateYield(zeroCouponGilt, settlementDate, price);
  approx(y, targetYield, 0.00001);
});

test("returns null when there are no remaining cashflows", function () {
  var maturedGilt = { couponPercent: 4, couponSchedule: [] };
  assert.equal(GiltCalc.estimateYield(maturedGilt, "2026-09-22", 100), null);
});

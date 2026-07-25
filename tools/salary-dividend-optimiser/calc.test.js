/**
 * Unit tests for calc.js, using Node's built-in test runner and assert
 * module — no npm install required. Run with:
 *
 *   node --test calc.test.js
 *
 * (or just `node calc.test.js`, which also works since Node's test runner
 * auto-executes registered tests when the file itself is run directly).
 */
"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var TaxCalc = require("./calc.js");
var TaxConfig = require("./config.js");

var CFG = TaxConfig.TAX_YEARS["2026-27"];

function approx(actual, expected, tolerance, message) {
  var tol = tolerance === undefined ? 0.01 : tolerance;
  assert.ok(
    Math.abs(actual - expected) <= tol,
    (message || "") + " — expected " + expected + ", got " + actual
  );
}

// =====================================================================
// Personal Allowance taper
// =====================================================================

test("Personal Allowance taper: below threshold gives full allowance", function () {
  approx(TaxCalc.taperedPersonalAllowance(99999, CFG.personalAllowance), 12570);
});

test("Personal Allowance taper: exactly at threshold gives full allowance", function () {
  approx(TaxCalc.taperedPersonalAllowance(100000, CFG.personalAllowance), 12570);
});

test("Personal Allowance taper: £1 over threshold reduces allowance by 50p", function () {
  approx(TaxCalc.taperedPersonalAllowance(100001, CFG.personalAllowance), 12569.5);
});

test("Personal Allowance taper: just below full taper-out point", function () {
  approx(TaxCalc.taperedPersonalAllowance(125138, CFG.personalAllowance), 1);
});

test("Personal Allowance taper: fully tapered at £125,140", function () {
  approx(TaxCalc.taperedPersonalAllowance(125140, CFG.personalAllowance), 0);
});

test("Personal Allowance taper: stays at zero above full taper-out point", function () {
  approx(TaxCalc.taperedPersonalAllowance(200000, CFG.personalAllowance), 0);
});

// =====================================================================
// Employee National Insurance
// =====================================================================

test("Employee NI: zero below Primary Threshold", function () {
  approx(TaxCalc.calcEmployeeNI(12000, CFG.employeeNI), 0);
});

test("Employee NI: zero exactly at Primary Threshold", function () {
  approx(TaxCalc.calcEmployeeNI(12570, CFG.employeeNI), 0);
});

test("Employee NI: 8% just above Primary Threshold", function () {
  approx(TaxCalc.calcEmployeeNI(12571, CFG.employeeNI), 0.08);
});

test("Employee NI: exactly at Upper Earnings Limit", function () {
  approx(TaxCalc.calcEmployeeNI(50270, CFG.employeeNI), (50270 - 12570) * 0.08);
});

test("Employee NI: just above Upper Earnings Limit switches to 2%", function () {
  var atUel = (50270 - 12570) * 0.08;
  approx(TaxCalc.calcEmployeeNI(50271, CFG.employeeNI), atUel + 0.02);
});

test("Employee NI: high salary combines both bands correctly", function () {
  var expected = (50270 - 12570) * 0.08 + (100000 - 50270) * 0.02;
  approx(TaxCalc.calcEmployeeNI(100000, CFG.employeeNI), expected);
});

// =====================================================================
// Employer National Insurance + Employment Allowance
// =====================================================================

test("Employer NI gross: zero below Secondary Threshold", function () {
  approx(TaxCalc.calcEmployerNIGross(4999, CFG.employerNI), 0);
});

test("Employer NI gross: zero exactly at Secondary Threshold", function () {
  approx(TaxCalc.calcEmployerNIGross(5000, CFG.employerNI), 0);
});

test("Employer NI gross: 15% just above Secondary Threshold", function () {
  approx(TaxCalc.calcEmployerNIGross(5001, CFG.employerNI), 0.15);
});

test("Marginal employer NI: fully absorbed by Employment Allowance when small", function () {
  // existing salary 0, additional salary small enough that gross NIC < EA
  var marginal = TaxCalc.calcMarginalEmployerNI(0, 10000, CFG.employerNI, true);
  approx(marginal, 0, 0.01, "gross NIC on £10,000 salary is well under the £10,500 allowance");
});

test("Marginal employer NI: partially offset when existing salary already used some EA", function () {
  // existing salary alone generates employer NIC of (60000-5000)*0.15 = 8250, using 8250 of the 10500 EA
  // remaining EA = 2250. Additional salary of 20000 generates marginal gross NIC of 20000*0.15=3000
  // net marginal = 3000 - 2250 = 750
  var marginal = TaxCalc.calcMarginalEmployerNI(60000, 20000, CFG.employerNI, true);
  approx(marginal, 750);
});

test("Marginal employer NI: no EA benefit once existing salary alone exhausts it", function () {
  // existing salary generates gross NIC of (75000-5000)*0.15=10500, exactly using all EA.
  // Any additional salary is charged in full at 15% with no further offset.
  var marginal = TaxCalc.calcMarginalEmployerNI(75000, 10000, CFG.employerNI, true);
  approx(marginal, 1500);
});

test("Marginal employer NI: EA disabled means full 15% from the first pound above ST", function () {
  var marginal = TaxCalc.calcMarginalEmployerNI(0, 10000, CFG.employerNI, false);
  approx(marginal, (10000 - 5000) * 0.15);
});

// =====================================================================
// Corporation Tax + marginal relief
// =====================================================================

test("Corporation Tax: zero profit gives zero tax", function () {
  var result = TaxCalc.calcCorporationTax(0, 0, 1, CFG.corporationTax);
  approx(result.tax, 0);
  assert.equal(result.regime, "none");
});

test("Corporation Tax: just below lower limit uses small profits rate", function () {
  var result = TaxCalc.calcCorporationTax(49999, 0, 1, CFG.corporationTax);
  approx(result.tax, 49999 * 0.19);
  assert.equal(result.regime, "small");
});

test("Corporation Tax: exactly at lower limit still uses small profits rate", function () {
  var result = TaxCalc.calcCorporationTax(50000, 0, 1, CFG.corporationTax);
  approx(result.tax, 50000 * 0.19);
  assert.equal(result.regime, "small");
});

test("Corporation Tax: just above lower limit enters marginal relief band", function () {
  var result = TaxCalc.calcCorporationTax(50001, 0, 1, CFG.corporationTax);
  assert.equal(result.regime, "marginal");
  var expectedRelief = (3 / 200) * (250000 - 50001);
  approx(result.marginalRelief, expectedRelief);
  approx(result.tax, 50001 * 0.25 - expectedRelief);
});

test("Corporation Tax: marginal band is continuous with small-profits rate at the lower limit", function () {
  var justBelow = TaxCalc.calcCorporationTax(50000, 0, 1, CFG.corporationTax).tax;
  var justAbove = TaxCalc.calcCorporationTax(50000.01, 0, 1, CFG.corporationTax).tax;
  approx(justBelow, justAbove, 0.05, "tax should not jump discontinuously across the lower limit");
});

test("Corporation Tax: marginal band is continuous with main rate at the upper limit", function () {
  var atUpper = TaxCalc.calcCorporationTax(250000, 0, 1, CFG.corporationTax).tax;
  var justAbove = TaxCalc.calcCorporationTax(250000.01, 0, 1, CFG.corporationTax).tax;
  approx(atUpper, justAbove, 0.05, "tax should not jump discontinuously across the upper limit");
});

test("Corporation Tax: known example, £100,000 profit, no associated companies", function () {
  // marginal relief = 3/200 × (250000-100000) = 2250; tax = 25000 - 2250 = 22750
  var result = TaxCalc.calcCorporationTax(100000, 0, 1, CFG.corporationTax);
  approx(result.tax, 22750);
});

test("Corporation Tax: above upper limit uses main rate", function () {
  var result = TaxCalc.calcCorporationTax(300000, 0, 1, CFG.corporationTax);
  approx(result.tax, 300000 * 0.25);
  assert.equal(result.regime, "main");
});

test("Corporation Tax: one associated company halves both limits", function () {
  var result = TaxCalc.calcCorporationTax(30000, 1, 1, CFG.corporationTax);
  approx(result.lowerLimit, 25000);
  approx(result.upperLimit, 125000);
  // 30000 is now ABOVE the halved lower limit of 25000, so it should be in the marginal band
  assert.equal(result.regime, "marginal");
});

test("Corporation Tax: three associated companies divides limits by four", function () {
  var result = TaxCalc.calcCorporationTax(10000, 3, 1, CFG.corporationTax);
  approx(result.lowerLimit, 12500);
  approx(result.upperLimit, 62500);
  assert.equal(result.regime, "small");
});

test("Corporation Tax: 6-month accounting period halves both limits", function () {
  var result = TaxCalc.calcCorporationTax(30000, 0, 0.5, CFG.corporationTax);
  approx(result.lowerLimit, 25000);
  approx(result.upperLimit, 125000);
  assert.equal(result.regime, "marginal");
});

test("Corporation Tax: associated companies and short period compound multiplicatively", function () {
  // 1 associated company (÷2) AND 6-month period (×0.5) => limits ÷4
  var result = TaxCalc.calcCorporationTax(10000, 1, 0.5, CFG.corporationTax);
  approx(result.lowerLimit, 12500);
  approx(result.upperLimit, 62500);
});

// =====================================================================
// Dividend tax stacking (including the Scottish-uses-rUK-bands rule)
// =====================================================================

test("Dividend tax: fully covered by unused Personal Allowance is tax-free", function () {
  var result = TaxCalc.calcPersonalTax({
    salary: 0, otherIncome: 0, dividends: 10000, jurisdiction: "rUK"
  }, CFG);
  approx(result.taxableDividends, 0);
  approx(result.dividendTax, 0);
});

test("Dividend tax: within the £500 allowance is tax-free even with no spare Personal Allowance", function () {
  var result = TaxCalc.calcPersonalTax({
    salary: 20000, otherIncome: 0, dividends: 500, jurisdiction: "rUK"
  }, CFG);
  approx(result.dividendAllowanceUsed, 500);
  approx(result.dividendTax, 0);
});

test("Dividend tax: known hand-worked example spanning the basic/higher boundary", function () {
  // salary 42570 => nonDividendTaxable = 42570-12570 = 30000
  // dividends 20500 => allowance 500, remaining 20000
  // position 30500: 7200 in basic band (30500-37700) @10.75%, 12800 in higher band (37700-50500) @35.75%
  var result = TaxCalc.calcPersonalTax({
    salary: 42570, otherIncome: 0, dividends: 20500, jurisdiction: "rUK"
  }, CFG);
  var expected = 7200 * 0.1075 + 12800 * 0.3575;
  approx(result.dividendTax, expected, 0.5);
});

test("Dividend tax: identical for rUK and Scotland when non-dividend taxable income is the same (reserved matter)", function () {
  var rukResult = TaxCalc.calcPersonalTax({
    salary: 42570, otherIncome: 0, dividends: 20500, jurisdiction: "rUK"
  }, CFG);
  var scotResult = TaxCalc.calcPersonalTax({
    salary: 42570, otherIncome: 0, dividends: 20500, jurisdiction: "scotland"
  }, CFG);
  approx(rukResult.dividendTax, scotResult.dividendTax, 0.01,
    "dividend tax must be identical regardless of jurisdiction — it is reserved to Westminster");
  assert.notEqual(rukResult.incomeTax, scotResult.incomeTax,
    "sanity check: non-dividend income tax SHOULD differ between jurisdictions for this test to be meaningful");
});

test("Dividend tax: zero dividends gives zero dividend tax and zero allowance used", function () {
  var result = TaxCalc.calcPersonalTax({
    salary: 50000, otherIncome: 0, dividends: 0, jurisdiction: "rUK"
  }, CFG);
  approx(result.dividendTax, 0);
  approx(result.dividendAllowanceUsed, 0);
});

// =====================================================================
// Income tax bands — rUK and Scotland boundaries
// =====================================================================

test("rUK income tax: just below and at the basic/higher boundary", function () {
  var below = TaxCalc.calcBandedTax(37700, CFG.incomeTax.rUK.bands).tax;
  approx(below, 37700 * 0.20);
});

test("rUK income tax: just above the basic/higher boundary taxes the excess at 40%", function () {
  var atBoundary = 37700 * 0.20;
  var justAbove = TaxCalc.calcBandedTax(37701, CFG.incomeTax.rUK.bands).tax;
  approx(justAbove, atBoundary + 0.40);
});

test("rUK income tax: just above the higher/additional boundary taxes the excess at 45%", function () {
  var atBoundary = 37700 * 0.20 + (125140 - 37700) * 0.40;
  var justAbove = TaxCalc.calcBandedTax(125141, CFG.incomeTax.rUK.bands).tax;
  approx(justAbove, atBoundary + 0.45);
});

test("Scotland income tax: all six band boundaries", function () {
  var bands = CFG.incomeTax.scotland.bands;
  approx(TaxCalc.calcBandedTax(3967, bands).tax, 3967 * 0.19);
  var afterStarter = 3967 * 0.19;
  approx(TaxCalc.calcBandedTax(3968, bands).tax, afterStarter + 0.20, 0.01);
  approx(TaxCalc.calcBandedTax(16956, bands).tax, afterStarter + (16956 - 3967) * 0.20);
  var afterBasic = afterStarter + (16956 - 3967) * 0.20;
  approx(TaxCalc.calcBandedTax(31092, bands).tax, afterBasic + (31092 - 16956) * 0.21);
  var afterIntermediate = afterBasic + (31092 - 16956) * 0.21;
  approx(TaxCalc.calcBandedTax(62430, bands).tax, afterIntermediate + (62430 - 31092) * 0.42);
  var afterHigher = afterIntermediate + (62430 - 31092) * 0.42;
  approx(TaxCalc.calcBandedTax(112570, bands).tax, afterHigher + (112570 - 62430) * 0.45);
});

// =====================================================================
// evaluateSplit / runOptimiser — structural and scenario tests
// =====================================================================

var BASELINE_INPUT = {
  pool: 80000,
  existingSalary: 9100,
  otherIncome: 0,
  existingDividends: 0,
  jurisdiction: "rUK",
  associatedCompanies: 0,
  apFractionOfYear: 1,
  employmentAllowanceApplies: true
};

test("evaluateSplit: company-cost invariant holds (salary + employer NIC + CT + dividend = pool) for a feasible split", function () {
  var input = Object.assign({}, BASELINE_INPUT, { additionalSalary: 20000 });
  var result = TaxCalc.evaluateSplit(input, CFG);
  var total = input.additionalSalary + result.marginalEmployerNI + result.corporationTax + result.newDividend;
  approx(total, BASELINE_INPUT.pool, 0.05, "the whole pool must be accounted for exactly once");
});

test("evaluateSplit: at additionalSalary = 0, employer NIC contribution from this split is zero", function () {
  var input = Object.assign({}, BASELINE_INPUT, { additionalSalary: 0 });
  var result = TaxCalc.evaluateSplit(input, CFG);
  approx(result.marginalEmployerNI, 0);
  approx(result.newDividend, BASELINE_INPUT.pool - result.corporationTax, 0.05);
});

test("findMaxFeasibleSalary: cost at the boundary is within the pool, and just above it is not", function () {
  var bound = TaxCalc.findMaxFeasibleSalary(80000, 9100, CFG.employerNI, true);
  var costAtBound = bound + TaxCalc.calcMarginalEmployerNI(9100, bound, CFG.employerNI, true);
  var costJustAbove = (bound + 50) + TaxCalc.calcMarginalEmployerNI(9100, bound + 50, CFG.employerNI, true);
  assert.ok(costAtBound <= 80000 + 0.01);
  assert.ok(costJustAbove > 80000);
});

test("runOptimiser: zero or negative pool produces a clear warning and no points", function () {
  var result = TaxCalc.runOptimiser(Object.assign({}, BASELINE_INPUT, { pool: 0, stepSize: 100 }), CFG);
  assert.equal(result.points.length, 0);
  assert.ok(result.warnings.length > 0);
});

test("runOptimiser: warns when the optimum takes little or no dividend beyond the allowance", function () {
  // Forcing Corporation Tax to the main rate throughout (via an extreme
  // associated-companies count, which is a legitimate way to shrink the
  // small-profits/marginal-relief limits to near zero) combined with a
  // high existing salary and dividends already exceeding the £500
  // allowance makes salary genuinely dominate at the margin. Verified
  // empirically (see the investigation in the commit that added this
  // test) to land at ~£45 of dividend — comfortably under the allowance.
  var input = Object.assign({}, BASELINE_INPUT, {
    pool: 3000, existingSalary: 150000, existingDividends: 5000,
    associatedCompanies: 1000, stepSize: 10
  });
  var result = TaxCalc.runOptimiser(input, CFG);
  assert.ok(result.optimum.newDividend <= 500.01);
  assert.ok(result.warnings.some(function (w) { return /dominates here/.test(w); }));
});

test("runOptimiser: does NOT warn about low dividend in an ordinary scenario", function () {
  // Regression guard for a bug found during manual testing: the all-salary
  // endpoint always has zero distributable profit by construction (that's
  // the definition of the max feasible salary boundary), which is not a
  // meaningful warning on its own and must not fire for a normal scenario
  // where the optimum itself takes a substantial dividend.
  var result = TaxCalc.runOptimiser(Object.assign({}, BASELINE_INPUT, { stepSize: 100 }), CFG);
  assert.ok(result.optimum.newDividend > CFG.dividendTax.allowance,
    "sanity check: the baseline scenario's optimum should take a meaningful dividend for this test to be valid");
  assert.ok(!result.warnings.some(function (w) { return /dominates here/.test(w); }));
});

test("runOptimiser: zero dividend capacity when the pool is smaller than achievable-salary NIC overhead", function () {
  // A very small pool: even a modest salary plus its employer NIC can consume it entirely
  // depending on existing salary already having used the Employment Allowance.
  var input = Object.assign({}, BASELINE_INPUT, {
    pool: 500, existingSalary: 100000, stepSize: 50
  });
  var result = TaxCalc.runOptimiser(input, CFG);
  assert.ok(result.allSalary.ctTaxableProfit <= 0.01);
  approx(result.allSalary.newDividend, 0, 0.01);
});

test("runOptimiser: the chosen optimum is never worse than either all-salary or all-dividend", function () {
  var result = TaxCalc.runOptimiser(Object.assign({}, BASELINE_INPUT, { stepSize: 100 }), CFG);
  assert.ok(result.optimum.netReceipt >= result.allSalary.netReceipt - 0.01);
  assert.ok(result.optimum.netReceipt >= result.allDividend.netReceipt - 0.01);
});

test("runOptimiser: enabling Employment Allowance never makes the achievable optimum worse", function () {
  var withEA = TaxCalc.runOptimiser(Object.assign({}, BASELINE_INPUT, { stepSize: 100, employmentAllowanceApplies: true }), CFG);
  var withoutEA = TaxCalc.runOptimiser(Object.assign({}, BASELINE_INPUT, { stepSize: 100, employmentAllowanceApplies: false }), CFG);
  assert.ok(withEA.optimum.netReceipt >= withoutEA.optimum.netReceipt - 0.01,
    "Employment Allowance reduces employer NIC cost, so it should never leave the director worse off");
});

test("runOptimiser: threshold breakpoints are included exactly in the grid", function () {
  var result = TaxCalc.runOptimiser(Object.assign({}, BASELINE_INPUT, { stepSize: 1000 }), CFG);
  var salaries = result.points.map(function (p) { return p.additionalSalary; });
  var expectedBreakpoint = Math.round((CFG.employeeNI.primaryThreshold - BASELINE_INPUT.existingSalary) * 100) / 100;
  assert.ok(
    salaries.some(function (s) { return Math.abs(s - expectedBreakpoint) < 0.01; }),
    "Primary Threshold breakpoint should be present even at a coarse £1000 step size"
  );
});

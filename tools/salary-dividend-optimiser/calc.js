/**
 * Pure tax-calculation engine for the salary/dividend extraction optimiser.
 *
 * No DOM access, no globals beyond the module export, no I/O. Every function
 * here is a deterministic function of its inputs, so it can be (and is, in
 * calc.test.js) unit tested directly, and re-used unchanged between the
 * browser UI and the Node test runner.
 *
 * See README.md for the full economic model and the reasoning behind each
 * piece below; the comments here focus on *what* each function computes.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TaxCalc = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Generic progressive band calculator
  // ---------------------------------------------------------------------

  // bands: [{ upto, rate, name }], cumulative upper bounds, last one Infinity.
  // taxableAmount must already have any allowance deducted.
  function calcBandedTax(taxableAmount, bands) {
    var tax = 0;
    var prev = 0;
    var breakdown = [];
    for (var i = 0; i < bands.length; i++) {
      var band = bands[i];
      var amount = Math.max(0, Math.min(taxableAmount, band.upto) - prev);
      var bandTax = amount * band.rate;
      tax += bandTax;
      breakdown.push({ name: band.name, rate: band.rate, amount: amount, tax: bandTax });
      prev = band.upto;
      if (taxableAmount <= band.upto) break;
    }
    return { tax: tax, breakdown: breakdown };
  }

  // ---------------------------------------------------------------------
  // Personal Allowance taper
  // ---------------------------------------------------------------------

  function taperedPersonalAllowance(adjustedNetIncome, paConfig) {
    if (adjustedNetIncome <= paConfig.taperThreshold) return paConfig.amount;
    var reduction = (adjustedNetIncome - paConfig.taperThreshold) / 2;
    return Math.max(0, paConfig.amount - reduction);
  }

  // ---------------------------------------------------------------------
  // Employee (Class 1 primary) National Insurance
  // ---------------------------------------------------------------------

  function calcEmployeeNI(annualSalary, cfg) {
    var pt = cfg.primaryThreshold;
    var uel = cfg.upperEarningsLimit;
    if (annualSalary <= pt) return 0;
    if (annualSalary <= uel) return (annualSalary - pt) * cfg.mainRate;
    return (uel - pt) * cfg.mainRate + (annualSalary - uel) * cfg.upperRate;
  }

  // ---------------------------------------------------------------------
  // Employer (Class 1 secondary) National Insurance
  // ---------------------------------------------------------------------

  // Gross employer NIC before any Employment Allowance offset.
  function calcEmployerNIGross(annualSalary, cfg) {
    return Math.max(0, annualSalary - cfg.secondaryThreshold) * cfg.rate;
  }

  // The MARGINAL employer NIC cost of adding `additionalSalary` on top of an
  // `existingSalary` that is already being paid (and, in reality, already
  // drawing on the Employment Allowance). Employment Allowance is a single
  // pot per company, not per employee, so it has to be applied to the
  // *combined* liability and the marginal cost taken as the difference —
  // applying it independently to the additional slice alone would double-
  // count it if existingSalary hadn't already used it up.
  function calcMarginalEmployerNI(existingSalary, additionalSalary, cfg, employmentAllowanceApplies) {
    var ea = employmentAllowanceApplies ? cfg.employmentAllowance : 0;
    var grossExisting = calcEmployerNIGross(existingSalary, cfg);
    var grossTotal = calcEmployerNIGross(existingSalary + additionalSalary, cfg);
    var netExisting = Math.max(0, grossExisting - ea);
    var netTotal = Math.max(0, grossTotal - ea);
    return netTotal - netExisting;
  }

  // ---------------------------------------------------------------------
  // Corporation Tax, including marginal relief
  // ---------------------------------------------------------------------

  // apFractionOfYear: accounting period length expressed as a fraction of a
  // full 12-month year (e.g. 9 months -> 0.75). Divides the lower/upper
  // limits alongside the associated-companies adjustment.
  function calcCorporationTax(profit, associatedCompanies, apFractionOfYear, cfg) {
    var divisor = 1 + Math.max(0, associatedCompanies);
    var lowerLimit = (cfg.lowerLimit / divisor) * apFractionOfYear;
    var upperLimit = (cfg.upperLimit / divisor) * apFractionOfYear;

    if (profit <= 0) {
      return { tax: 0, regime: "none", lowerLimit: lowerLimit, upperLimit: upperLimit, marginalRelief: 0 };
    }
    if (profit <= lowerLimit) {
      return { tax: profit * cfg.smallProfitsRate, regime: "small", lowerLimit: lowerLimit, upperLimit: upperLimit, marginalRelief: 0 };
    }
    if (profit > upperLimit) {
      return { tax: profit * cfg.mainRate, regime: "main", lowerLimit: lowerLimit, upperLimit: upperLimit, marginalRelief: 0 };
    }
    // Marginal band. Formula (Corporation Tax Act 2010, s.19):
    //   relief = fraction × (upperLimit − augmentedProfits) × (basicProfits / augmentedProfits)
    // This tool assumes augmentedProfits = basicProfits = profit throughout
    // (no dividends received from other companies), so basicProfits /
    // augmentedProfits = 1 and the ratio term drops out.
    var marginalRelief = cfg.marginalReliefFraction * (upperLimit - profit);
    var tax = profit * cfg.mainRate - marginalRelief;
    return { tax: tax, regime: "marginal", lowerLimit: lowerLimit, upperLimit: upperLimit, marginalRelief: marginalRelief };
  }

  // ---------------------------------------------------------------------
  // Dividend tax slice — always UK-wide bands/rates, stacked on top of
  // wherever non-dividend taxable income already reaches, regardless of
  // which jurisdiction's non-dividend bands were used for that income.
  // ---------------------------------------------------------------------

  // startPosition: non-dividend taxable income (i.e. how much of the UK-wide
  // band space dividends stack on top of).
  // taxableDividends: dividend income remaining after any UNUSED personal
  // allowance has already been deducted from it by the caller.
  function calcDividendTaxSlice(startPosition, taxableDividends, divCfg) {
    var allowanceUsed = Math.min(taxableDividends, divCfg.allowance);
    var remaining = taxableDividends - allowanceUsed;
    var pos = startPosition + allowanceUsed; // position after the 0%-allowance slice
    var tax = 0;
    var breakdown = [];
    var lower = 0;
    for (var i = 0; i < divCfg.bands.length; i++) {
      var band = divCfg.bands[i];
      var upper = band.upto;
      var startInBand = Math.max(pos, lower);
      var endInBand = Math.min(pos + remaining, upper);
      var amount = Math.max(0, endInBand - startInBand);
      if (amount > 0) {
        var bandTax = amount * band.rate;
        tax += bandTax;
        breakdown.push({ name: band.name, rate: band.rate, amount: amount, tax: bandTax });
      }
      lower = upper;
      if (pos + remaining <= upper) break;
    }
    return { tax: tax, allowanceUsed: allowanceUsed, breakdown: breakdown };
  }

  // ---------------------------------------------------------------------
  // Full personal tax position for a given salary/other-income/dividend mix
  // ---------------------------------------------------------------------

  function calcPersonalTax(input, config) {
    var salary = input.salary;
    var otherIncome = input.otherIncome || 0;
    var dividends = input.dividends;
    var jurisdiction = input.jurisdiction;

    var nonDividendIncome = salary + otherIncome;
    var totalIncome = nonDividendIncome + dividends;

    var taperedPA = taperedPersonalAllowance(totalIncome, config.personalAllowance);

    var nonDividendTaxable = Math.max(0, nonDividendIncome - taperedPA);
    var remainingPA = Math.max(0, taperedPA - nonDividendIncome);

    var jurisdictionBands = config.incomeTax[jurisdiction].bands;
    var nonDividendResult = calcBandedTax(nonDividendTaxable, jurisdictionBands);

    var taxableDividends = Math.max(0, dividends - remainingPA);
    var dividendResult = calcDividendTaxSlice(nonDividendTaxable, taxableDividends, config.dividendTax);

    return {
      totalIncome: totalIncome,
      taperedPersonalAllowance: taperedPA,
      remainingPersonalAllowanceForDividends: remainingPA,
      nonDividendTaxable: nonDividendTaxable,
      incomeTax: nonDividendResult.tax,
      incomeTaxBreakdown: nonDividendResult.breakdown,
      taxableDividends: taxableDividends,
      dividendAllowanceUsed: dividendResult.allowanceUsed,
      dividendTax: dividendResult.tax,
      dividendTaxBreakdown: dividendResult.breakdown
    };
  }

  // ---------------------------------------------------------------------
  // Per-candidate-split evaluator
  // ---------------------------------------------------------------------

  // input: {
  //   pool, existingSalary, additionalSalary, otherIncome, existingDividends,
  //   jurisdiction, associatedCompanies, apFractionOfYear,
  //   employmentAllowanceApplies
  // }
  function evaluateSplit(input, config) {
    var totalSalary = input.existingSalary + input.additionalSalary;

    var marginalEmployerNI = calcMarginalEmployerNI(
      input.existingSalary,
      input.additionalSalary,
      config.employerNI,
      input.employmentAllowanceApplies
    );

    var salaryPlusNICost = input.additionalSalary + marginalEmployerNI;
    var feasible = salaryPlusNICost <= input.pool + 1e-6;
    var ctTaxableProfit = Math.max(0, input.pool - salaryPlusNICost);

    var ct = calcCorporationTax(ctTaxableProfit, input.associatedCompanies, input.apFractionOfYear, config.corporationTax);
    var distributable = Math.max(0, ctTaxableProfit - ct.tax);
    var newDividend = distributable;
    var totalDividends = input.existingDividends + newDividend;

    var employeeNI = calcEmployeeNI(totalSalary, config.employeeNI);

    var personalTax = calcPersonalTax({
      salary: totalSalary,
      otherIncome: input.otherIncome,
      dividends: totalDividends,
      jurisdiction: input.jurisdiction
    }, config);

    var netReceipt = totalSalary + totalDividends + input.otherIncome
      - employeeNI - personalTax.incomeTax - personalTax.dividendTax;

    var totalCompanyCost = input.additionalSalary + marginalEmployerNI + ct.tax + newDividend;

    return {
      additionalSalary: input.additionalSalary,
      totalSalary: totalSalary,
      marginalEmployerNI: marginalEmployerNI,
      ctTaxableProfit: ctTaxableProfit,
      corporationTax: ct.tax,
      ctRegime: ct.regime,
      ctMarginalRelief: ct.marginalRelief,
      newDividend: newDividend,
      totalDividends: totalDividends,
      employeeNI: employeeNI,
      incomeTax: personalTax.incomeTax,
      dividendTax: personalTax.dividendTax,
      taperedPersonalAllowance: personalTax.taperedPersonalAllowance,
      netReceipt: netReceipt,
      totalCompanyCost: totalCompanyCost,
      feasible: feasible,
      hasLawfulDividend: newDividend > 0.005 || ctTaxableProfit <= 0.005
    };
  }

  // ---------------------------------------------------------------------
  // Bisection solver: the largest additionalSalary such that
  // additionalSalary + marginalEmployerNI(additionalSalary) <= pool.
  // cost(x) is monotonically non-decreasing in x (employer NIC rate is
  // never negative), so bisection is safe here even though the overall
  // net-receipt curve (handled by grid search, not bisection) is not
  // guaranteed unimodal.
  // ---------------------------------------------------------------------

  function findMaxFeasibleSalary(pool, existingSalary, employerNIConfig, employmentAllowanceApplies) {
    if (pool <= 0) return 0;
    function cost(x) {
      return x + calcMarginalEmployerNI(existingSalary, x, employerNIConfig, employmentAllowanceApplies);
    }
    var lo = 0;
    var hi = pool;
    // Guard: cost(hi) should exceed pool whenever NIC is charged at all; if
    // not (e.g. rate is 0), the whole pool is already the feasible bound.
    if (cost(hi) <= pool) return hi;
    for (var i = 0; i < 60; i++) {
      var mid = (lo + hi) / 2;
      if (cost(mid) <= pool) lo = mid; else hi = mid;
    }
    return lo;
  }

  // ---------------------------------------------------------------------
  // Grid-search optimiser
  // ---------------------------------------------------------------------

  // Threshold breakpoints that are cheap to invert exactly (pure functions
  // of total salary alone) are snapped into the grid so the chart and the
  // optimum are precise at those kinks even at a coarse step size. Kinks
  // that depend on the combined salary+dividend income (Personal Allowance
  // taper, dividend bands, Corporation Tax limits) are NOT snapped — they
  // rely on the grid's step size for resolution; see README for why.
  function thresholdBreakpoints(existingSalary, config) {
    var eni = config.employeeNI;
    var erni = config.employerNI;
    var points = [
      eni.primaryThreshold - existingSalary,
      eni.upperEarningsLimit - existingSalary,
      erni.secondaryThreshold - existingSalary,
      erni.secondaryThreshold + erni.employmentAllowance / erni.rate - existingSalary
    ];
    return points.filter(function (p) { return isFinite(p); });
  }

  function buildGrid(maxFeasibleSalary, stepSize, existingSalary, config) {
    var points = [];
    for (var x = 0; x <= maxFeasibleSalary; x += stepSize) {
      points.push(Math.round(x * 100) / 100);
    }
    if (points[points.length - 1] < maxFeasibleSalary - 1e-9) {
      points.push(Math.round(maxFeasibleSalary * 100) / 100);
    }
    thresholdBreakpoints(existingSalary, config).forEach(function (p) {
      if (p >= 0 && p <= maxFeasibleSalary) points.push(Math.round(p * 100) / 100);
    });
    points.sort(function (a, b) { return a - b; });
    // dedupe (within a penny)
    var deduped = [];
    for (var i = 0; i < points.length; i++) {
      if (i === 0 || points[i] - deduped[deduped.length - 1] > 0.005) {
        deduped.push(points[i]);
      }
    }
    return deduped;
  }

  function runOptimiser(rawInput, config) {
    var input = {
      pool: rawInput.pool,
      existingSalary: rawInput.existingSalary,
      otherIncome: rawInput.otherIncome,
      existingDividends: rawInput.existingDividends,
      jurisdiction: rawInput.jurisdiction,
      associatedCompanies: rawInput.associatedCompanies,
      apFractionOfYear: rawInput.apFractionOfYear,
      employmentAllowanceApplies: rawInput.employmentAllowanceApplies
    };

    var warnings = [];

    if (input.pool <= 0) {
      warnings.push("No company profit is available for extraction, so there is nothing to optimise.");
      return { points: [], optimum: null, allSalary: null, allDividend: null, warnings: warnings, maxFeasibleSalary: 0 };
    }

    var maxFeasibleSalary = findMaxFeasibleSalary(
      input.pool, input.existingSalary, config.employerNI, input.employmentAllowanceApplies
    );

    var stepSize = rawInput.stepSize > 0 ? rawInput.stepSize : 100;
    var grid = buildGrid(maxFeasibleSalary, stepSize, input.existingSalary, config);

    var points = grid.map(function (additionalSalary) {
      return evaluateSplit(mergeInput(input, additionalSalary), config);
    });

    var optimum = points[0];
    for (var i = 1; i < points.length; i++) {
      if (points[i].netReceipt > optimum.netReceipt + 1e-9) optimum = points[i];
    }

    var allDividend = points[0];
    var allSalary = points[points.length - 1];

    // Note on what's NOT flagged here: the all-salary endpoint (by
    // construction of findMaxFeasibleSalary) always has zero distributable
    // profit, and the all-dividend endpoint (additionalSalary = 0) always
    // has SOME distributable profit whenever pool > 0 (Corporation Tax can
    // take at most the main rate, 25%, leaving at least 75% of the pool
    // distributable) — so neither of those facts is a meaningful warning.
    // What IS meaningful is whether the actual chosen OPTIMUM avoids
    // dividends beyond the tax-free dividend allowance itself — i.e. pure
    // salary genuinely wins here and any dividend at the optimum is just
    // mopping up the allowance rather than a real tax-efficiency gain.
    // (A bit-exact newDividend === 0 is a poor threshold in practice: the
    // £500 allowance is "free" regardless of existing dividends, so a
    // small residual dividend around that size persists in almost every
    // scenario even when salary otherwise dominates at the margin.)
    if (optimum.newDividend <= config.dividendTax.allowance + 0.005) {
      warnings.push("The optimum in this scenario takes little or no dividend beyond the tax-free dividend allowance — pure salary/bonus dominates here.");
    }
    var baselineIncome = input.existingSalary + input.otherIncome + input.existingDividends;
    if (baselineIncome > 125140) {
      warnings.push("Existing salary, other income and dividends already exceed £125,140, so all extracted income falls in the top marginal rates and the Personal Allowance is already fully tapered away.");
    }

    return {
      points: points,
      optimum: optimum,
      allDividend: allDividend,
      allSalary: allSalary,
      warnings: warnings,
      maxFeasibleSalary: maxFeasibleSalary
    };
  }

  function mergeInput(input, additionalSalary) {
    return {
      pool: input.pool,
      existingSalary: input.existingSalary,
      additionalSalary: additionalSalary,
      otherIncome: input.otherIncome,
      existingDividends: input.existingDividends,
      jurisdiction: input.jurisdiction,
      associatedCompanies: input.associatedCompanies,
      apFractionOfYear: input.apFractionOfYear,
      employmentAllowanceApplies: input.employmentAllowanceApplies
    };
  }

  return {
    calcBandedTax: calcBandedTax,
    taperedPersonalAllowance: taperedPersonalAllowance,
    calcEmployeeNI: calcEmployeeNI,
    calcEmployerNIGross: calcEmployerNIGross,
    calcMarginalEmployerNI: calcMarginalEmployerNI,
    calcCorporationTax: calcCorporationTax,
    calcDividendTaxSlice: calcDividendTaxSlice,
    calcPersonalTax: calcPersonalTax,
    evaluateSplit: evaluateSplit,
    findMaxFeasibleSalary: findMaxFeasibleSalary,
    thresholdBreakpoints: thresholdBreakpoints,
    buildGrid: buildGrid,
    runOptimiser: runOptimiser
  };
});

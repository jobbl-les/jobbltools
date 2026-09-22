/**
 * Pure calculation engine for the Gilt Ladder Calculator.
 *
 * No DOM access, no I/O, no Date.now() — every function is a deterministic
 * function of its inputs (including the settlement/horizon dates), so it's
 * fully unit-testable and shared unchanged between the browser UI and the
 * Node test runner. See README.md for the model and the decisions this file
 * bakes in (greedy selection vs a proper MILP, rolling vs terminal ladders,
 * the tax-preference heuristic, etc).
 *
 * A handful of small helpers (daysInMonthUTC, addMonthsClamped, daysBetween,
 * accruedInterestPercent, estimateYield) are deliberately duplicated from
 * ../gilt-cashflow-calculator/calc.js rather than imported — this site's
 * convention (see that file's own comment) is that every tool is
 * self-contained, with no cross-tool script dependency, even though both
 * tools read the same data/gilts.json.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GiltLadder = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DAYS_PER_YEAR = 365.25;

  // ---- Tunable heuristic constants (see README "The selection heuristic") ----

  // Weight given to "this gilt matures close to this rung's target date"
  // in the composite slot score. Applied unconditionally (not scaled by the
  // frequency/yield slider) so a ladder always stays a *ladder* — evenly
  // staggered maturities — regardless of how the slider is set.
  var MATURITY_FIT_WEIGHT = 0.5;

  // Multiplies the (small, ~0.02-0.06) annualised return figures so they sit
  // in a comparable range to the 0/1 frequency indicator and the maturity
  // fit score below, before being blended by the frequency/yield slider.
  var RETURN_SCALE = 8;

  // For taxable accounts, the fraction of the "return" score taken from
  // annualised capital-gain-to-maturity (tax-free under TCGA 1992 s.115)
  // rather than gross redemption yield (which is mostly taxable coupon
  // income) — see README "Tax treatment". ISA/SIPP accounts don't apply
  // this tilt since both components are tax-free there.
  var TAXABLE_CAPITAL_GAIN_TILT = 0.7;

  // Safety cap on how many times a single rung can roll forward in a
  // rolling ladder, so a long horizon combined with short-dated gilts can't
  // generate an unbounded reinvestment chain.
  var MAX_ROLL_EVENTS_PER_RUNG = 40;

  var DEFAULTS = {
    minRungs: 5,
    maxRungs: 10,
    roundingUnit: 1000,
    minNominalPerRung: null,
    maxNominalPerRung: null,
    frequencyWeight: 0.5,
    accountType: "taxable",
    rungSizing: "equal",
    ladderType: "terminal",
    reinvestCoupons: false,
    durationCapYears: null,
    durationCapPercent: null,
    excludeIsins: []
  };

  // ---- Date helpers (duplicated from gilt-cashflow-calculator/calc.js) ----

  function daysInMonthUTC(year, monthIndex) {
    return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  }

  function addMonthsClamped(isoDate, monthsDelta) {
    var d = new Date(isoDate + "T00:00:00Z");
    var day = d.getUTCDate();
    var totalMonths = d.getUTCFullYear() * 12 + d.getUTCMonth() + monthsDelta;
    var year = Math.floor(totalMonths / 12);
    var monthIndex = ((totalMonths % 12) + 12) % 12;
    var clampedDay = Math.min(day, daysInMonthUTC(year, monthIndex));
    return new Date(Date.UTC(year, monthIndex, clampedDay)).toISOString().slice(0, 10);
  }

  function daysBetween(isoA, isoB) {
    return (new Date(isoB) - new Date(isoA)) / (1000 * 60 * 60 * 24);
  }

  function addDaysISO(iso, days) {
    var d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + Math.round(days));
    return d.toISOString().slice(0, 10);
  }

  /** See gilt-cashflow-calculator's calc.js for the full derivation/comment. */
  function accruedInterestPercent(gilt, settlementDate) {
    var nextEntry = null;
    for (var i = 0; i < gilt.couponSchedule.length; i++) {
      if (gilt.couponSchedule[i].couponDate >= settlementDate) {
        nextEntry = gilt.couponSchedule[i];
        break;
      }
    }
    if (!nextEntry) return 0;

    var previousCouponDate = addMonthsClamped(nextEntry.couponDate, -6);
    var periodDays = daysBetween(previousCouponDate, nextEntry.couponDate);
    var elapsedDays = Math.max(0, daysBetween(previousCouponDate, settlementDate));

    return (gilt.couponPercent / 2) * (elapsedDays / periodDays);
  }

  function dirtyPrice(gilt, settlementDate, priceOverride) {
    var clean = typeof priceOverride === "number" ? priceOverride : gilt.price.mid;
    return clean + accruedInterestPercent(gilt, settlementDate);
  }

  /** Gross redemption yield — see gilt-cashflow-calculator's calc.js for the full comment. */
  function estimateYield(gilt, settlementDate, priceOverride) {
    var dp = dirtyPrice(gilt, settlementDate, priceOverride);

    var cashflows = [];
    gilt.couponSchedule.forEach(function (entry) {
      if (entry.couponDate < settlementDate) return;
      var t = daysBetween(settlementDate, entry.couponDate) / DAYS_PER_YEAR;
      var received = settlementDate < entry.exDividendDate;
      if (received) cashflows.push({ t: t, amount: gilt.couponPercent / 2 });
      if (entry.isFinal) cashflows.push({ t: t, amount: 100 });
    });
    if (cashflows.length === 0) return null;

    var y = gilt.couponPercent / 100 || 0.04;
    for (var i = 0; i < 100; i++) {
      var f = -dp;
      var fPrime = 0;
      cashflows.forEach(function (cf) {
        var discount = Math.pow(1 + y / 2, -2 * cf.t);
        f += cf.amount * discount;
        fPrime += cf.amount * -cf.t * Math.pow(1 + y / 2, -2 * cf.t - 1);
      });
      if (Math.abs(fPrime) < 1e-12) break;
      var next = y - f / fPrime;
      if (Math.abs(next - y) < 1e-10) {
        y = next;
        break;
      }
      y = next;
    }
    return y;
  }

  /**
   * Simple (non-compounded) annualised capital gain to maturity, as a
   * decimal — e.g. 0.015 for 1.5%/yr. Positive for a gilt trading below par
   * (the common case), negative above par. Used to let the selection
   * heuristic favour "return via tax-free capital uplift" over "return via
   * taxable coupon" for taxable accounts — see README "Tax treatment".
   */
  function capitalGainAnnualizedPercent(gilt, settlementDate, priceOverride) {
    var dp = dirtyPrice(gilt, settlementDate, priceOverride);
    var years = daysBetween(settlementDate, gilt.redemptionDate) / DAYS_PER_YEAR;
    if (years <= 0) return 0;
    return (100 - dp) / dp / years;
  }

  /**
   * A stable 0-5 bucket identifying which "coupon month pair" a gilt pays
   * in (e.g. Jan/Jul, Feb/Aug, ...). UK gilts pay semi-annually 6 months
   * apart, and redemption always coincides with the final coupon, so
   * `redemptionMonth % 6` is the same value as every other coupon's month
   * in that schedule (months 6 apart share a mod-6 residue). There are only
   * 6 possible buckets — perfect monthly income needs one gilt from each.
   */
  function couponMonthBucket(gilt) {
    return new Date(gilt.redemptionDate + "T00:00:00Z").getUTCMonth() % 6;
  }

  function roundToUnit(amount, unit) {
    if (!unit || unit <= 0) return Math.round(amount);
    return Math.round(amount / unit) * unit;
  }

  function clamp(amount, min, max) {
    if (typeof min === "number" && amount < min) amount = min;
    if (typeof max === "number" && amount > max) amount = max;
    return amount;
  }

  /**
   * Gross redemption yield solved for an arbitrary set of dated cashflows
   * (rather than one bond's coupon/redemption structure) — same
   * semi-annual-compounding Newton-Raphson as estimateYield, generalised so
   * it can value a whole ladder's combined cost + cashflow stream at once.
   *
   * @param {Array<{date: string, amount: number}>} cashflows amount<0 for outlays
   * @param {string} asOfDate ISO date cashflows are discounted back to
   * @returns {number|null} annualised rate as a decimal, or null if it can't be solved
   */
  function solveIrr(cashflows, asOfDate) {
    if (!cashflows || cashflows.length < 2) return null;
    var y = 0.04;
    for (var iter = 0; iter < 100; iter++) {
      var f = 0;
      var fPrime = 0;
      for (var i = 0; i < cashflows.length; i++) {
        var cf = cashflows[i];
        var t = daysBetween(asOfDate, cf.date) / DAYS_PER_YEAR;
        var discount = Math.pow(1 + y / 2, -2 * t);
        f += cf.amount * discount;
        fPrime += cf.amount * -t * Math.pow(1 + y / 2, -2 * t - 1);
      }
      if (Math.abs(fPrime) < 1e-12) break;
      var next = y - f / fPrime;
      if (!isFinite(next)) return null;
      if (Math.abs(next - y) < 1e-10) {
        y = next;
        break;
      }
      y = next;
    }
    return isFinite(y) ? y : null;
  }

  /**
   * How many rungs to build: clamped into [minRungs, maxRungs] by what the
   * position-size constraints actually allow, then set to the *maximum*
   * feasible count. More rungs strictly improves this model's frequency and
   * granularity objectives at no cost to yield (nominal is just split
   * finer), since dealing costs are explicitly out of scope (see README) —
   * so there's no trade-off pushing toward fewer rungs for a greedy model
   * to weigh. If you want a fixed count instead, set minRungs = maxRungs.
   */
  function computeFeasibleRungCount(investmentAmount, minRungs, maxRungs, minNominalPerRung, maxNominalPerRung) {
    var lo = minRungs;
    var hi = maxRungs;
    if (maxNominalPerRung) lo = Math.max(lo, Math.ceil(investmentAmount / maxNominalPerRung));
    if (minNominalPerRung) hi = Math.min(hi, Math.floor(investmentAmount / minNominalPerRung));
    if (hi < lo) {
      var fallback = Math.max(1, minRungs);
      return {
        count: fallback,
        warning:
          "The min/max nominal-per-rung limits are inconsistent with the investment amount and rung-count range — " +
          "using " + fallback + " rung(s) and ignoring those limits."
      };
    }
    return { count: hi, warning: null };
  }

  /**
   * Scores one candidate gilt against one ladder slot: how well its
   * maturity fits the slot's target date, blended with a return component
   * (yield, or yield/capital-gain blend for taxable accounts) and a
   * frequency component (does it use a not-yet-used coupon-month bucket),
   * weighted by params.frequencyWeight (0 = pure return, 1 = pure
   * frequency). Duration-capped candidates are skipped entirely rather than
   * scored down. See README "The selection heuristic" for the rationale
   * behind the constants involved.
   */
  function pickBestForSlot(pool, targetMaturityISO, usedBuckets, params, asOfISO, durationState, cashProxy) {
    var slotSpanDays = Math.max(1, params.horizonSpanDays / params.rungCount);
    var best = null;

    pool.forEach(function (g) {
      var ytm = estimateYield(g, asOfISO);
      if (ytm === null) return;

      var yearsToMat = daysBetween(asOfISO, g.redemptionDate) / DAYS_PER_YEAR;
      if (params.durationCapYears != null && params.durationCapPercent != null && yearsToMat > params.durationCapYears) {
        var projectedPercent = ((durationState.longDatedCash + cashProxy) / params.investmentAmount) * 100;
        if (projectedPercent > params.durationCapPercent) return;
      }

      var capGain = capitalGainAnnualizedPercent(g, asOfISO);
      var returnComponent =
        params.accountType === "taxable"
          ? TAXABLE_CAPITAL_GAIN_TILT * capGain + (1 - TAXABLE_CAPITAL_GAIN_TILT) * ytm
          : ytm;

      var daysDiff = Math.abs(daysBetween(targetMaturityISO, g.redemptionDate));
      var maturityFit = Math.max(0, 1 - daysDiff / slotSpanDays);
      var freqIndicator = usedBuckets.has(couponMonthBucket(g)) ? 0 : 1;

      var score =
        maturityFit * MATURITY_FIT_WEIGHT +
        (1 - params.frequencyWeight) * returnComponent * RETURN_SCALE +
        params.frequencyWeight * freqIndicator;

      if (!best || score > best.score) best = { gilt: g, score: score, yearsToMaturity: yearsToMat };
    });

    return best;
  }

  /**
   * Sizes each already-selected rung's nominal (face value), given a
   * sizing method:
   *   - "equal": equal cash share per rung
   *   - "weighted": cash share proportional to each rung's return score
   *     (the same taxable-tilted score used during selection)
   * The cash share is converted to nominal via that gilt's dirty price,
   * then rounded to params.roundingUnit and clamped to
   * [minNominalPerRung, maxNominalPerRung] — so the total actually spent
   * can end up above or below investmentAmount; buildBuyInstructions
   * reports that shortfall/overshoot explicitly.
   */
  function sizeRungs(rungs, params) {
    var k = rungs.length;
    if (k === 0) return rungs;

    var weights = rungs.map(function (r) {
      if (params.rungSizing !== "weighted") return 1;
      var ytm = estimateYield(r.gilt, params.settlementDate) || 0;
      var capGain = capitalGainAnnualizedPercent(r.gilt, params.settlementDate);
      var score =
        params.accountType === "taxable"
          ? TAXABLE_CAPITAL_GAIN_TILT * capGain + (1 - TAXABLE_CAPITAL_GAIN_TILT) * ytm
          : ytm;
      return Math.max(0.0001, score);
    });
    var totalWeight = weights.reduce(function (a, b) { return a + b; }, 0);

    rungs.forEach(function (r, i) {
      var cashShare = (params.investmentAmount * weights[i]) / totalWeight;
      var dp = dirtyPrice(r.gilt, params.settlementDate);
      var rawNominal = (cashShare * 100) / dp;
      var nominal = roundToUnit(rawNominal, params.roundingUnit);
      nominal = clamp(nominal, params.minNominalPerRung, params.maxNominalPerRung);
      r.nominal = Math.max(0, nominal);
      r.dirtyPrice = dp;
    });

    return rungs;
  }

  /**
   * Builds a ladder: selects up to computeFeasibleRungCount(...) gilts from
   * `universe`, one per roughly-evenly-spaced maturity slot between
   * settlementDate and horizonEnd, then sizes each rung's nominal.
   *
   * @param {Array<object>} universe entries from data/gilts.json's `gilts` array
   * @param {object} params see README "Inputs" for the full field list;
   *   required: investmentAmount, settlementDate, horizonEnd
   * @returns {{rungs: Array, requestedRungCount: number, warnings: string[]}}
   */
  function buildLadder(universe, rawParams) {
    var params = Object.assign({}, DEFAULTS, rawParams);
    var warnings = [];

    var excludeSet = params.excludeIsins instanceof Set ? params.excludeIsins : new Set(params.excludeIsins || []);
    var conventional = universe.filter(function (g) { return !g.indexLinked; });
    var eligible = conventional.filter(function (g) {
      return !excludeSet.has(g.isin) && g.redemptionDate > params.settlementDate && g.redemptionDate <= params.horizonEnd;
    });

    var horizonSpanDays = daysBetween(params.settlementDate, params.horizonEnd);
    if (horizonSpanDays <= 0) {
      return { rungs: [], requestedRungCount: 0, warnings: ["Horizon end date must be after the settlement date."] };
    }

    var feasible = computeFeasibleRungCount(
      params.investmentAmount,
      params.minRungs,
      params.maxRungs,
      params.minNominalPerRung,
      params.maxNominalPerRung
    );
    if (feasible.warning) warnings.push(feasible.warning);

    var rungCount = Math.min(feasible.count, eligible.length);
    if (rungCount < feasible.count) {
      warnings.push(
        "Only " + eligible.length + " eligible gilt(s) mature within the chosen horizon — " +
        "the ladder has fewer rungs than requested."
      );
    }
    if (rungCount === 0) {
      return { rungs: [], requestedRungCount: feasible.count, warnings: warnings.concat(["No eligible gilts found for these filters."]) };
    }

    var runtimeParams = Object.assign({}, params, { horizonSpanDays: horizonSpanDays, rungCount: rungCount });

    var pool = eligible.slice();
    var usedBuckets = new Set();
    var durationState = { longDatedCash: 0 };
    var cashProxy = params.investmentAmount / rungCount;
    var rungs = [];

    for (var i = 0; i < rungCount; i++) {
      var targetMaturity = addDaysISO(params.settlementDate, Math.round((horizonSpanDays * (i + 1)) / rungCount));
      var pick = pickBestForSlot(pool, targetMaturity, usedBuckets, runtimeParams, params.settlementDate, durationState, cashProxy);
      if (!pick) {
        warnings.push("No suitable gilt found for the slot maturing around " + targetMaturity + " — skipped.");
        continue;
      }
      pool = pool.filter(function (g) { return g.isin !== pick.gilt.isin; });
      usedBuckets.add(couponMonthBucket(pick.gilt));
      if (params.durationCapYears != null && pick.yearsToMaturity > params.durationCapYears) {
        durationState.longDatedCash += cashProxy;
      }
      rungs.push({ gilt: pick.gilt, targetMaturity: targetMaturity, slotSpanDays: horizonSpanDays / rungCount });
    }

    sizeRungs(rungs, params);
    return { rungs: rungs, requestedRungCount: feasible.count, warnings: warnings };
  }

  /**
   * Per-rung buy instructions as of params.settlementDate — see README
   * §6.1. Only covers the initial purchase; reinvestment "buys" made later
   * by a rolling ladder show up as `reinvestment` rows in projectSchedule's
   * event list instead.
   */
  function buildBuyInstructions(rungs, params) {
    var cumulative = 0;
    var lines = rungs.map(function (r) {
      var accrued = accruedInterestPercent(r.gilt, params.settlementDate);
      var clean = r.gilt.price.mid;
      var dp = clean + accrued;
      var accruedCash = (r.nominal * accrued) / 100;
      var cost = (r.nominal * dp) / 100;
      cumulative += cost;
      return {
        isin: r.gilt.isin,
        name: r.gilt.name,
        couponPercent: r.gilt.couponPercent,
        redemptionDate: r.gilt.redemptionDate,
        nominal: r.nominal,
        cleanPrice: clean,
        accruedInterest: accruedCash,
        dirtyPrice: dp,
        cost: cost,
        cumulativeCost: cumulative
      };
    });
    return { lines: lines, totalCost: cumulative, shortfall: params.investmentAmount - cumulative };
  }

  /** Coupon + redemption events for one rung, cut off at horizonEndISO. */
  function generateRungEvents(gilt, nominal, fromDateISO, horizonEndISO) {
    var events = [];
    gilt.couponSchedule.forEach(function (entry) {
      if (entry.couponDate < fromDateISO) return;
      if (entry.couponDate > horizonEndISO) return;
      var received = fromDateISO < entry.exDividendDate;
      if (!received) return;
      events.push({
        date: entry.couponDate,
        type: "coupon",
        amount: (nominal * gilt.couponPercent / 100) / 2,
        isin: gilt.isin,
        name: gilt.name
      });
    });
    var matured = gilt.redemptionDate <= horizonEndISO;
    if (matured) {
      events.push({ date: gilt.redemptionDate, type: "redemption", amount: nominal, isin: gilt.isin, name: gilt.name });
    }
    return { events: events, matured: matured };
  }

  /**
   * Projects every coupon/redemption (and, for a rolling ladder,
   * reinvestment) event across the whole ladder up to params.horizonEnd —
   * see README §6.2/"Rolling vs terminal ladders".
   *
   * For a rolling ladder, whenever a rung matures before horizonEnd, its
   * redemption proceeds are modelled as immediately reinvested into a new
   * gilt targeting the same maturity distance from *its* maturity date as
   * the original rung had from settlement (keeping the ladder roughly
   * constant-length) — chosen from the full remaining universe using the
   * same pickBestForSlot heuristic as initial selection. This reuses
   * today's snapshot price for the new gilt even though the reinvestment
   * happens on a future date, since no future price is knowable — a
   * disclosed simplification, not a forecast.
   *
   * Any rung still unmatured at horizonEnd is reported in `openPositions`
   * rather than forced to a redemption event — a rolling ladder is
   * expected to still be running at the end of the projection window.
   *
   * @returns {{events: Array, openPositions: Array}}
   */
  function projectSchedule(rungs, universe, rawParams) {
    var params = Object.assign({}, DEFAULTS, rawParams);
    var conventional = universe.filter(function (g) { return !g.indexLinked; });
    var excludeSet = params.excludeIsins instanceof Set ? params.excludeIsins : new Set(params.excludeIsins || []);
    var everUsed = new Set(rungs.map(function (r) { return r.gilt.isin; }));
    var usedBuckets = new Set(rungs.map(function (r) { return couponMonthBucket(r.gilt); }));
    var durationState = { longDatedCash: 0 };

    var allEvents = [];
    var openPositions = [];
    var queue = rungs.map(function (r) {
      return {
        gilt: r.gilt,
        nominal: r.nominal,
        fromDate: params.settlementDate,
        ladderLabel: r.gilt.name,
        generation: 0,
        slotSpanDays: r.slotSpanDays
      };
    });

    while (queue.length) {
      var item = queue.shift();
      var result = generateRungEvents(item.gilt, item.nominal, item.fromDate, params.horizonEnd);
      var redemptionEvent = null;
      result.events.forEach(function (e) {
        e.ladderLabel = item.ladderLabel;
        e.generation = item.generation;
        if (e.type === "redemption") redemptionEvent = e;
        allEvents.push(e);
      });

      if (!result.matured) {
        openPositions.push({
          gilt: item.gilt,
          isin: item.gilt.isin,
          name: item.gilt.name,
          nominal: item.nominal,
          redemptionDate: item.gilt.redemptionDate,
          ladderLabel: item.ladderLabel
        });
        continue;
      }

      var rollsForward =
        params.ladderType === "rolling" &&
        item.gilt.redemptionDate < params.horizonEnd &&
        item.generation < MAX_ROLL_EVENTS_PER_RUNG;
      if (!rollsForward) continue;

      var targetMaturity = addDaysISO(item.gilt.redemptionDate, item.slotSpanDays);
      var pool = conventional.filter(function (g) {
        return !excludeSet.has(g.isin) && !everUsed.has(g.isin) && g.redemptionDate > item.gilt.redemptionDate;
      });
      var slotParams = {
        investmentAmount: params.investmentAmount,
        frequencyWeight: params.frequencyWeight,
        accountType: params.accountType,
        durationCapYears: params.durationCapYears,
        durationCapPercent: params.durationCapPercent,
        horizonSpanDays: item.slotSpanDays,
        rungCount: 1
      };
      var pick = pickBestForSlot(pool, targetMaturity, usedBuckets, slotParams, item.gilt.redemptionDate, durationState, item.nominal);

      // No reinvestment target found (universe exhausted) — the redemption
      // event already recorded above stands as real "capital returned",
      // same as a terminal ladder's final redemption.
      if (!pick) continue;

      // A reinvestment target was found: the redemption event's proceeds
      // are redeployed rather than handed back to the investor, so flag it
      // out of "capital returned" sums/IRR — the `reinvestment` marker
      // below is the one that carries this cash forward in the schedule.
      redemptionEvent.reinvested = true;

      everUsed.add(pick.gilt.isin);
      usedBuckets.add(couponMonthBucket(pick.gilt));
      var dp = dirtyPrice(pick.gilt, item.gilt.redemptionDate);
      var newNominal = (item.nominal * 100) / dp;

      allEvents.push({
        date: item.gilt.redemptionDate,
        type: "reinvestment",
        amount: item.nominal,
        isin: pick.gilt.isin,
        name: pick.gilt.name,
        ladderLabel: item.ladderLabel + " → " + pick.gilt.name,
        generation: item.generation
      });

      queue.push({
        gilt: pick.gilt,
        nominal: newNominal,
        fromDate: item.gilt.redemptionDate,
        ladderLabel: item.ladderLabel,
        generation: item.generation + 1,
        slotSpanDays: item.slotSpanDays
      });
    }

    allEvents.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

    var cumulativeIncome = 0;
    var cumulativeCapitalReturned = 0;
    allEvents.forEach(function (e) {
      if (e.type === "coupon") cumulativeIncome += e.amount;
      if (e.type === "redemption" && !e.reinvested) cumulativeCapitalReturned += e.amount;
      e.cumulativeIncome = cumulativeIncome;
      e.cumulativeCapitalReturned = cumulativeCapitalReturned;
    });

    return { events: allEvents, openPositions: openPositions };
  }

  /**
   * Mark-to-market value of a still-open position as of the horizon end —
   * the gilt hasn't matured yet, so it's worth its (today's-snapshot-price)
   * dirty price, not its face-value nominal. Valuing it at par would credit
   * the whole of its embedded, not-yet-realised capital gain immediately,
   * which is exactly wrong for a gilt bought at a discount that still has
   * years left to run — the discount is only earned by holding to maturity.
   */
  function openPositionMarketValue(position, asOfDate) {
    return (position.nominal * dirtyPrice(position.gilt, asOfDate)) / 100;
  }

  /**
   * Summary statistics across the whole ladder — see README §6.3.
   * blendedIrr and capitalStillInLadder both mark any still-open position
   * (a rolling ladder still at work when horizonEnd is reached) to market
   * at horizonEnd rather than assuming it's worth its full face value —
   * see openPositionMarketValue.
   */
  function computeSummary(rungs, schedule, rawParams) {
    var params = Object.assign({}, DEFAULTS, rawParams);

    var totalCost = rungs.reduce(function (s, r) { return s + (r.nominal * dirtyPrice(r.gilt, params.settlementDate)) / 100; }, 0);
    var annualCouponIncome = rungs.reduce(function (s, r) { return s + (r.nominal * r.gilt.couponPercent) / 100; }, 0);
    var blendedRunningYield = totalCost > 0 ? annualCouponIncome / totalCost : 0;

    var irrCashflows = [{ date: params.settlementDate, amount: -totalCost }];
    schedule.events.forEach(function (e) {
      if (e.type === "coupon" || (e.type === "redemption" && !e.reinvested)) {
        irrCashflows.push({ date: e.date, amount: e.amount });
      }
    });
    schedule.openPositions.forEach(function (p) {
      irrCashflows.push({ date: params.horizonEnd, amount: openPositionMarketValue(p, params.horizonEnd) });
    });
    var blendedIrr = solveIrr(irrCashflows, params.settlementDate);

    var totalCouponIncome = 0;
    var totalCapitalReturned = 0;
    schedule.events.forEach(function (e) {
      if (e.type === "coupon") totalCouponIncome += e.amount;
      if (e.type === "redemption" && !e.reinvested) totalCapitalReturned += e.amount;
    });
    var capitalStillInLadder = schedule.openPositions.reduce(function (s, p) { return s + openPositionMarketValue(p, params.horizonEnd); }, 0);

    var yearOneEnd = addDaysISO(params.settlementDate, 364);
    var monthsWithPayments = new Set();
    schedule.events.forEach(function (e) {
      if (e.date <= yearOneEnd && (e.type === "coupon" || e.type === "redemption")) {
        monthsWithPayments.add(new Date(e.date + "T00:00:00Z").getUTCMonth());
      }
    });

    var projectedValueAtHorizonEnd = null;
    if (params.reinvestCoupons) {
      projectedValueAtHorizonEnd = capitalStillInLadder + totalCapitalReturned;
      schedule.events.forEach(function (e) {
        if (e.type !== "coupon") return;
        var yearsToHorizon = daysBetween(e.date, params.horizonEnd) / DAYS_PER_YEAR;
        projectedValueAtHorizonEnd += e.amount * Math.pow(1 + blendedRunningYield, Math.max(0, yearsToHorizon));
      });
    }

    return {
      totalCost: totalCost,
      blendedRunningYield: blendedRunningYield,
      blendedIrr: blendedIrr,
      totalCouponIncome: totalCouponIncome,
      totalCapitalReturned: totalCapitalReturned,
      capitalStillInLadder: capitalStillInLadder,
      monthsWithPaymentsCount: monthsWithPayments.size,
      projectedValueAtHorizonEnd: projectedValueAtHorizonEnd
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    accruedInterestPercent: accruedInterestPercent,
    dirtyPrice: dirtyPrice,
    estimateYield: estimateYield,
    capitalGainAnnualizedPercent: capitalGainAnnualizedPercent,
    couponMonthBucket: couponMonthBucket,
    solveIrr: solveIrr,
    computeFeasibleRungCount: computeFeasibleRungCount,
    buildLadder: buildLadder,
    buildBuyInstructions: buildBuyInstructions,
    projectSchedule: projectSchedule,
    computeSummary: computeSummary
  };
});

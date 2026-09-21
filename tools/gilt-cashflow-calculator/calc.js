/**
 * Pure calculation engine for the gilt cashflow & tax calculator.
 *
 * No DOM access, no I/O, no Date.now() — every function is a deterministic
 * function of its inputs (including the settlement date), so it's fully
 * unit-testable and re-used unchanged between the browser UI and the Node
 * test runner. See README.md for the economic model and tax treatment.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GiltCalc = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function daysInMonthUTC(year, monthIndex) {
    return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  }

  // Same clamped month arithmetic as giltfetcher's couponSchedule.js (kept
  // as a small duplicate here rather than a shared dependency, per this
  // site's "every tool is self-contained" convention) — used to find the
  // *previous* coupon date, which isn't itself in gilt.couponSchedule
  // (that only lists coupons from-today-onward).
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

  /**
   * Accrued interest per £100 nominal, Actual/Actual (the UK gilt market
   * convention): the coupon rate for the *current* coupon period, prorated
   * by how much of that period has already elapsed as of settlementDate.
   *
   * Quoted gilt prices (LSE, DMO, everywhere) are always "clean" — they
   * exclude this. Anyone buying between coupon dates (i.e. almost always)
   * actually pays clean price + accrued interest ("dirty"/"invoice" price)
   * to compensate the seller for the part of the current period they held
   * it. Ignoring this understates the true cost and (via computeCashflows)
   * overstates how much nominal a given cash amount actually buys.
   *
   * @param {object} gilt
   * @param {string} settlementDate ISO date (YYYY-MM-DD)
   * @returns {number} accrued interest per £100 nominal (0 if settlement
   *   falls exactly on a coupon date, or there's no more accruing to do)
   */
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

  /**
   * @param {object} gilt one entry from data/gilts.json's `gilts` array
   * @param {number} investmentAmount cash amount to spend, excluding fees
   * @param {string} settlementDate ISO date (YYYY-MM-DD) the purchase settles
   * @param {number} [priceOverride] clean price per £100 nominal to use instead of gilt.price.mid
   * @returns {object} cashflow projection, see README.md for the shape
   */
  function computeCashflows(gilt, investmentAmount, settlementDate, priceOverride) {
    var cleanPrice = typeof priceOverride === "number" ? priceOverride : gilt.price.mid;
    if (!(investmentAmount > 0)) throw new Error("investmentAmount must be positive");
    if (!(cleanPrice > 0)) throw new Error("price must be positive");
    if (settlementDate > gilt.redemptionDate) {
      throw new Error("settlementDate is after redemption — nothing left to buy");
    }

    var accrued = accruedInterestPercent(gilt, settlementDate);
    var dirtyPrice = cleanPrice + accrued;

    // Nominal (face value) bought: dirtyPrice is the actual cost per £100
    // nominal — clean price alone understates it whenever settlement falls
    // between coupon dates.
    var nominal = (investmentAmount * 100) / dirtyPrice;

    var cashflows = [];
    var couponIncomeTotal = 0;

    gilt.couponSchedule.forEach(function (entry) {
      if (entry.couponDate < settlementDate) return; // already occurred

      // Cum-dividend (buyer receives it) iff settlement is strictly before
      // that coupon's own ex-dividend date; otherwise it's already gone to
      // whoever held the gilt at the ex-dividend date.
      var received = settlementDate < entry.exDividendDate;
      if (!received) return;

      var couponAmount = (nominal * (gilt.couponPercent / 100)) / 2;
      couponIncomeTotal += couponAmount;
      cashflows.push({
        date: entry.couponDate,
        type: "coupon",
        amount: couponAmount,
        taxable: true,
        description: "Coupon payment (subject to Income Tax as savings income)"
      });
    });

    var redemptionAmount = nominal; // conventional gilts redeem at par: 100% of nominal
    cashflows.push({
      date: gilt.redemptionDate,
      type: "redemption",
      amount: redemptionAmount,
      taxable: false,
      description: "Redemption at par (capital — exempt from Capital Gains Tax)"
    });

    cashflows.sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });

    var totalReceived = couponIncomeTotal + redemptionAmount;
    var capitalGain = redemptionAmount - investmentAmount; // may be negative if bought above par

    return {
      nominal: nominal,
      cleanPrice: cleanPrice,
      accruedInterest: (nominal * accrued) / 100,
      dirtyPrice: dirtyPrice,
      cashflows: cashflows,
      totals: {
        invested: investmentAmount,
        totalReceived: totalReceived,
        couponIncomeTotal: couponIncomeTotal, // taxable as savings income
        capitalGain: capitalGain, // CGT-exempt under TCGA 1992 s.115, gain or loss
        netGainLoss: totalReceived - investmentAmount
      }
    };
  }

  var DAYS_PER_YEAR = 365.25;

  /**
   * Gross redemption yield (yield to maturity): the single semi-annually-
   * compounded rate y such that the present value of every remaining
   * cashflow (per £100 nominal) equals the *dirty* price paid (clean price
   * plus accrued interest — see accruedInterestPercent). Solved with
   * Newton-Raphson — bond price-vs-yield is smooth and monotonic, so this
   * converges in a handful of iterations from any sane starting guess.
   *
   * This is a *computed* market yield, distinct from the gilt's printed
   * coupon rate — a low-coupon gilt trading well below par can yield more
   * than its coupon suggests, which is exactly why this is offered as a
   * separate filter from coupon size.
   *
   * @param {object} gilt
   * @param {string} settlementDate ISO date (YYYY-MM-DD)
   * @param {number} [priceOverride] clean price per £100 nominal to use instead of gilt.price.mid
   * @returns {number|null} annualised yield as a decimal (e.g. 0.045 for 4.5%),
   *   or null if there are no remaining cashflows to value (settled on/after redemption)
   */
  function estimateYield(gilt, settlementDate, priceOverride) {
    var cleanPrice = typeof priceOverride === "number" ? priceOverride : gilt.price.mid;
    var dirtyPrice = cleanPrice + accruedInterestPercent(gilt, settlementDate);

    var cashflows = [];
    gilt.couponSchedule.forEach(function (entry) {
      if (entry.couponDate < settlementDate) return;
      var t = daysBetween(settlementDate, entry.couponDate) / DAYS_PER_YEAR;
      var received = settlementDate < entry.exDividendDate;
      if (received) cashflows.push({ t: t, amount: gilt.couponPercent / 2 });
      if (entry.isFinal) cashflows.push({ t: t, amount: 100 });
    });
    if (cashflows.length === 0) return null;

    var y = gilt.couponPercent / 100 || 0.04; // seed with the coupon rate, or 4% for zero-coupon-like cases
    for (var i = 0; i < 100; i++) {
      var f = -dirtyPrice;
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

  return {
    accruedInterestPercent: accruedInterestPercent,
    computeCashflows: computeCashflows,
    estimateYield: estimateYield
  };
});

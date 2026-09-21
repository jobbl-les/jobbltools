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

  /**
   * @param {object} gilt one entry from data/gilts.json's `gilts` array
   * @param {number} investmentAmount cash amount to spend, excluding fees
   * @param {string} settlementDate ISO date (YYYY-MM-DD) the purchase settles
   * @param {number} [priceOverride] price per £100 nominal to use instead of gilt.price.mid
   * @returns {object} cashflow projection, see README.md for the shape
   */
  function computeCashflows(gilt, investmentAmount, settlementDate, priceOverride) {
    var price = typeof priceOverride === "number" ? priceOverride : gilt.price.mid;
    if (!(investmentAmount > 0)) throw new Error("investmentAmount must be positive");
    if (!(price > 0)) throw new Error("price must be positive");
    if (settlementDate > gilt.redemptionDate) {
      throw new Error("settlementDate is after redemption — nothing left to buy");
    }

    // Nominal (face value) bought: price is quoted per £100 nominal.
    var nominal = (investmentAmount * 100) / price;

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
      pricePaid: price,
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

  return {
    computeCashflows: computeCashflows
  };
});

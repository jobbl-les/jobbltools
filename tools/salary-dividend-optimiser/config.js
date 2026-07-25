/**
 * Versioned UK tax parameters for the salary/dividend extraction optimiser.
 *
 * Every figure below was verified directly against GOV.UK (and gov.scot for
 * Scottish income tax) on 2026-07-25 for the 2026/27 tax year — not assumed
 * to have carried over from prior years. Two figures in particular changed
 * at Autumn Budget 2025 and are easy to get wrong if copied from an older
 * source: the dividend tax rates (ordinary rate 8.75% -> 10.75%, upper rate
 * 33.75% -> 35.75%, effective 6 April 2026) and nothing else in employer NIC
 * changed from 2025/26 (15% / £5,000 secondary threshold / £10,500
 * Employment Allowance all carried over unchanged).
 *
 * To add a future tax year: copy the "2026-27" block, update every rate/
 * threshold from the then-current GOV.UK guidance (do not assume anything
 * is unchanged — verify each figure), update `source` citations, and add
 * the new key to TAX_YEARS. See README.md for the full walkthrough.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TaxConfig = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TAX_YEARS = {
    "2026-27": {
      label: "2026/27",
      effectiveFrom: "2026-04-06",
      effectiveTo: "2027-04-05",

      // Personal Allowance and the high-income taper (£1 lost per £2 of
      // "adjusted net income" above the threshold, fully gone at PA*2 above
      // the threshold i.e. £125,140 for a £12,570 allowance).
      personalAllowance: {
        amount: 12570,
        taperThreshold: 100000,
        source: "https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027 ; https://www.gov.uk/income-tax-rates (Personal Allowance and taper) — verified 2026/27"
      },

      // Income tax on non-dividend, non-savings income (salary, bonus,
      // "other taxable income" such as rental/self-employment profit).
      // Bands are expressed as cumulative taxable-income (i.e. AFTER the
      // Personal Allowance has been deducted) upper bounds, matching the
      // representation used throughout this site's other UK tax tools.
      incomeTax: {
        rUK: {
          label: "England, Wales & Northern Ireland",
          bands: [
            { upto: 37700, rate: 0.20, name: "Basic rate" },
            { upto: 125140, rate: 0.40, name: "Higher rate" },
            { upto: Infinity, rate: 0.45, name: "Additional rate" }
          ],
          source: "https://www.gov.uk/income-tax-rates — verified for 2026/27"
        },
        scotland: {
          label: "Scotland",
          bands: [
            { upto: 3967, rate: 0.19, name: "Starter rate" },
            { upto: 16956, rate: 0.20, name: "Basic rate" },
            { upto: 31092, rate: 0.21, name: "Intermediate rate" },
            { upto: 62430, rate: 0.42, name: "Higher rate" },
            { upto: 112570, rate: 0.45, name: "Advanced rate" },
            { upto: Infinity, rate: 0.48, name: "Top rate" }
          ],
          source: "https://www.gov.scot/publications/scottish-income-tax-rates-and-bands/pages/2026-to-2027/ — thresholds converted here to taxable-income (post-Personal-Allowance) terms; verified for 2026/27"
        }
      },

      // Dividend tax is a RESERVED matter: every UK taxpayer, including
      // Scottish taxpayers, is taxed on dividends using these UK-wide rates
      // and band thresholds (the rUK non-dividend thresholds, £37,700 and
      // £125,140) — never the Scottish non-dividend bands. See README for
      // how the calculator applies this.
      dividendTax: {
        allowance: 500,
        bands: [
          { upto: 37700, rate: 0.1075, name: "Ordinary rate" },
          { upto: 125140, rate: 0.3575, name: "Upper rate" },
          { upto: Infinity, rate: 0.3935, name: "Additional rate" }
        ],
        source: "https://www.gov.uk/tax-on-dividends — rates increased at Autumn Budget 2025, effective 6 April 2026 (10.75% / 35.75% / 39.35%, £500 allowance); verified directly for 2026/27"
      },

      // Class 1 (employee, "primary") National Insurance.
      employeeNI: {
        primaryThreshold: 12570,
        upperEarningsLimit: 50270,
        mainRate: 0.08,
        upperRate: 0.02,
        source: "https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027 — verified for 2026/27"
      },

      // Class 1 (employer, "secondary") National Insurance, plus the
      // Employment Allowance that can offset it.
      employerNI: {
        secondaryThreshold: 5000,
        rate: 0.15,
        employmentAllowance: 10500,
        source: "https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027 — verified for 2026/27 (unchanged from 2025/26). Employment Allowance eligibility rules are NOT modelled here — most importantly, a company whose only employee is also a director is NOT eligible; the 'Employment Allowance applies' input is a manual override and it is the user's responsibility to confirm eligibility."
      },

      // Corporation Tax, including marginal relief for profits between the
      // lower and upper limits. Formula (Corporation Tax Act 2010, s.19):
      //   marginalRelief = fraction × (upperLimit − augmentedProfits) × (basicProfits / augmentedProfits)
      //   CT payable = mainRate × basicProfits − marginalRelief
      // This tool assumes augmentedProfits = basicProfits throughout (the
      // company receives no dividends from other companies) — see README.
      corporationTax: {
        smallProfitsRate: 0.19,
        mainRate: 0.25,
        lowerLimit: 50000,
        upperLimit: 250000,
        marginalReliefFraction: 3 / 200,
        source: "https://www.gov.uk/guidance/corporation-tax-marginal-relief ; https://www.gov.uk/hmrc-internal-manuals/company-taxation-manual/ctm03910 — verified for FY2026 (unchanged since FY2023 introduction of these rates). Lower/upper limits are divided by (1 + number of associated companies) and prorated for accounting periods shorter than 12 months."
      }
    }
  };

  return { TAX_YEARS: TAX_YEARS };
});

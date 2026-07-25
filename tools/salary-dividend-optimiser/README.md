# Salary vs Dividend Extraction Optimiser

A static, browser-only tool that compares every feasible split of a UK limited
company's available profit between additional director's salary/bonus and
dividends, for a single director-shareholder, and highlights the split that
maximises the director's total net cash.

**This is an illustrative estimator, not tax or accounting advice.** Dividends
require adequate distributable reserves and proper company authorisation
(board minutes and a dividend voucher) — this tool has no knowledge of your
company's actual accounts beyond the profit pool you enter. Always confirm
figures with a qualified accountant.

## Files

| File | Purpose |
|---|---|
| `config.js` | Versioned tax parameters (rates, thresholds, GOV.UK source citations) |
| `calc.js` | Pure calculation engine — no DOM, no I/O, fully unit-testable |
| `calc.test.js` | Unit tests, run with `node --test calc.test.js` (no npm install needed) |
| `index.html` | UI: form, SVG chart, tooltips, comparison, detail table, warnings |

`config.js` and `calc.js` are plain UMD-style scripts: loaded via `<script src>`
tags in the browser (attaching to `window.TaxConfig` / `window.TaxCalc`) and
also `require()`-able directly from Node for the test suite — same code, no
build step either way.

## The economic model

The user enters a fixed **pool**: company profit available for extraction,
*before* any of it is paid out. The tool evaluates a whole range of candidate
**additional salary/bonus** amounts (from £0 up to the largest amount the pool
can support), and for each one works out what's left for dividends and what
the director ends up with, net of every tax and NIC charge along the way:

1. **Additional salary/bonus** is set. Its **employer NIC** cost is computed
   (see below) — both are paid out of the pool and are deductible for
   Corporation Tax.
2. Whatever remains of the pool is the **Corporation Tax taxable profit**.
   Corporation Tax (including marginal relief, if applicable) is charged on
   it.
3. Whatever's left after Corporation Tax is the **new dividend** — this tool
   assumes full extraction, i.e. the entire post-tax remainder is paid as a
   dividend rather than retained (there's no "leave it in the company"
   option in this pool-splitting model; see Exclusions).
4. On the personal side, **total salary** (existing + additional) and
   **total dividends** (existing + new) are combined with **other taxable
   income** to work out Personal Allowance tapering, PAYE income tax,
   employee NIC, and dividend tax.
5. **Net cash received by the director** = total salary + total dividends +
   other income − employee NIC − PAYE income tax − dividend tax. This is the
   headline number plotted on the chart, and it includes the director's
   *existing* salary/dividends too, so the `£0 additional salary` point on
   the chart is the director's current baseline, before any new extraction.

A structural invariant holds at every feasible point (and is checked by a
unit test): `additional salary + employer NIC + Corporation Tax + new
dividend = pool`, exactly. Nothing is created or destroyed by the split —
only how the pool is divided, and how much tax is taken along the way,
changes.

### Why "marginal" employer NIC and Employment Allowance

The director's *existing* salary is already being paid — its employer NIC and
whatever Employment Allowance it uses are sunk costs, not part of this
decision. What the pool actually pays for is the **incremental** employer NIC
caused by the *additional* salary, correctly accounting for however much of
the £10,500 Employment Allowance (a single pot per company, not per employee)
the existing salary has already used up:

```
marginal employer NIC
  = netNIC(existing + additional) − netNIC(existing)
  where netNIC(salary) = max(0, grossNIC(salary) − EmploymentAllowance)
```

### Dividend stacking, and the Scottish exception

Non-dividend income (salary + other income) uses up the Personal Allowance
and the income tax bands first. Dividends stack on top, in this order:

1. Any **unused Personal Allowance** left over (if non-dividend income didn't
   use it all) covers the bottom slice of dividends at 0%.
2. The **£500 dividend allowance** covers the next slice at 0% — but this
   slice still occupies band space for determining what comes next, even
   though it's taxed at nil.
3. Everything above that is taxed at the dividend ordinary/upper/additional
   rate for whichever band it falls into.

**Dividend tax is a reserved matter.** Even for a Scottish taxpayer, whose
salary and other income are taxed using the Scottish bands (19–48%, six
bands), dividends are *always* taxed using the UK-wide rates (10.75% /
35.75% / 39.35%) and the rUK band thresholds (£37,700 / £125,140) — never the
Scottish ones. The calculator's non-dividend taxable income figure (computed
using whichever jurisdiction's bands apply) is the same number used to
position dividends against the UK-wide thresholds; only the *rate* differs
by jurisdiction for non-dividend income, never for dividends. This is
verified directly in `calc.test.js` by asserting identical dividend tax for
rUK and Scotland given the same salary and dividend inputs.

### Corporation Tax and marginal relief

For accounting periods with taxable total profits between the lower and
upper limits, marginal relief applies (Corporation Tax Act 2010, s.19):

```
marginal relief = standardFraction × (upperLimit − augmentedProfits) × (basicProfits / augmentedProfits)
Corporation Tax = mainRate × basicProfits − marginal relief
```

This tool assumes **augmented profits = basic profits** throughout (the
company receives no dividends from other companies), so the ratio term is
always 1 and drops out — leaving `tax = mainRate × profit − fraction ×
(upperLimit − profit)` for profit between the limits.

The lower limit (£50,000) and upper limit (£250,000) are both divided by
`1 + number of associated companies`, and further scaled by the accounting
period length as a fraction of 12 months (a 6-month period halves both
limits again). Both adjustments are applied multiplicatively and are covered
by dedicated tests.

## Assumptions and exclusions (v1)

- **Single director-shareholder only.** No modelling of multiple
  shareholders, different share classes, or dividend waivers.
- **No pension contributions, benefits in kind, student loan repayments, or
  IR35/off-payroll working rules.**
- **No prior retained reserves.** The pool entered is treated as the entire
  distributable resource under consideration for this decision — it neither
  adds to nor draws down any reserves already on the company's balance
  sheet.
- **Full extraction assumed.** Every candidate split pays out the entire
  post-Corporation-Tax remainder as a dividend; there's no "retain some
  profit in the company" option.
- **"Other taxable income"** is assumed to be non-savings, non-dividend
  income (e.g. rental or self-employment profit) taxed identically to salary
  for band purposes. Savings interest and its separate starting-rate/
  Personal Savings Allowance treatment are not modelled.
- **Employment Allowance eligibility is a manual toggle, not derived.** Most
  importantly: a company whose only employee is also its director is **not**
  eligible for Employment Allowance under HMRC's rules. This tool does not
  check that — it's the user's responsibility to confirm eligibility before
  relying on the toggle.
- **Corporation Tax marginal relief assumes augmented profits = basic
  profits** (see above) — i.e. no dividends received from other companies.
- **Accounting period length is modelled as a simple fraction of 12 months**
  (e.g. 6 months → limits halved), not as exact calendar dates. It does not
  model an accounting period straddling two Corporation Tax financial years
  with different rates (not currently a live concern: FY2023–FY2026 all
  share the same 19%/25%/£50k/£250k parameters).
- **Precision of the "optimum" is bounded by the calculation step size**
  (default £100). National Insurance and Employment Allowance thresholds are
  snapped into the evaluated grid *exactly*, regardless of step size, because
  they're cheap to invert (pure functions of total salary alone). Personal
  Allowance taper, dividend-band, and Corporation Tax threshold crossings are
  **not** snapped exactly — they depend on the combined salary+dividend
  income, which isn't cheaply invertible once Corporation Tax sits between
  the two — so their precision depends on the step size. Reduce it for more
  precision near those specific boundaries.

## Test cases (`calc.test.js`, 50 tests)

Run with:

```bash
node --test calc.test.js
```

Coverage includes, for every threshold: the exact boundary value, and one
point immediately either side of it —

- Personal Allowance taper: below/at/just-above the £100,000 threshold, just
  below and exactly at the £125,140 full-taper point.
- Employee NIC: Primary Threshold and Upper Earnings Limit boundaries.
- Employer NIC: Secondary Threshold boundary, and Employment Allowance
  interaction (fully absorbed, partially offset by existing salary's usage,
  fully exhausted by existing salary alone, and disabled entirely).
- Corporation Tax: zero profit, just below/at/just-above the lower limit,
  continuity across both the lower and upper limit boundaries, a known
  hand-workable example (£100,000 profit), above the upper limit,
  associated-companies adjustment (1, and 3 companies), a short (6-month)
  accounting period, and both adjustments compounding together.
- Dividend tax: fully covered by unused Personal Allowance, fully within the
  £500 allowance, a hand-worked example spanning the ordinary/upper rate
  boundary, the rUK-vs-Scotland reserved-matter identity check, and zero
  dividends.
- Income tax bands: every rUK and Scottish band boundary.
- Structural/integration tests on `evaluateSplit` and `runOptimiser`: the
  pool-conservation invariant, the max-feasible-salary bisection solver's
  boundary correctness, a zero/negative pool, a pool too small to leave any
  dividend capacity at the maximum feasible salary, the chosen optimum never
  being worse than either endpoint, Employment Allowance never making the
  achievable optimum worse, and exact threshold-breakpoint inclusion in the
  grid even at a coarse step size.

Two of these tests exist specifically as **regression guards for a bug found
during manual browser testing**: an early version of the warnings logic
flagged "no dividend available" whenever the *all-salary* endpoint had zero
distributable profit — which is always true by construction of how that
endpoint is defined, making it a tautology rather than a useful warning. The
tests lock in the corrected behaviour (only warn when the actual *optimum*
takes no meaningful dividend) and confirm the old, always-true condition no
longer fires in an ordinary scenario.

## Adding a future tax year

1. Verify **every** rate and threshold directly from GOV.UK (and gov.scot for
   Scottish income tax) for the new tax year — do not assume anything carried
   over unchanged from the prior year. (For 2026/27, dividend tax rates in
   particular changed at Autumn Budget 2025; everything else happened to
   carry over from 2025/26.)
2. Copy the `"2026-27"` block in `config.js`, update every figure, and update
   the `source` citation on each section to the specific page you checked.
3. Add the new key to `TAX_YEARS`.
4. Add a matching `<option>` to the `#taxYear` select in `index.html`.
5. If any structural rule changed (e.g. a new Corporation Tax band, a new
   NIC category, a change to how marginal relief or the taper works), update
   the relevant function in `calc.js` — and add threshold-boundary tests for
   it in `calc.test.js` following the existing pattern before trusting it.

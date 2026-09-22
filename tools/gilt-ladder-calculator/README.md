# Gilt Ladder Calculator

A static, browser-only tool that answers: "given a lump sum, build me an
illustrative UK gilt ladder — staggered maturities and coupon dates — and
show me the buy instructions plus the full cash-flow and capital schedule."

**This is an illustrative planning tool, not an execution tool or investment
advice.** Buy instructions are a proposed allocation against a price
snapshot, not a live dealing ticket. Dealing/platform charges are excluded
entirely — at smaller ladder sizes with many rungs, per-line dealing costs
are exactly where a real ladder becomes less attractive than this
projection suggests.

## Files

| File | Purpose |
|---|---|
| `ladder-calc.js` | Pure calculation engine — selection, sizing, cash-flow projection, summary stats. No DOM, no I/O, fully unit-testable. |
| `ladder-calc.test.js` | Unit tests, run with `node --test ladder-calc.test.js` |
| `index.html` | UI: inputs, buy instructions, cash-flow schedule, two SVG charts |

Same pattern as `../gilt-cashflow-calculator/` and
`../salary-dividend-optimiser/`: `ladder-calc.js` attaches to
`window.GiltLadder` for the browser and is also `require()`-able directly
from Node for the test suite — one file, no build step either way.

## Where the data comes from

`index.html` fetches the same `../../data/gilts.json` as
`../gilt-cashflow-calculator/` — this tool is a sibling/companion, reusing
that data rather than sourcing its own (see that tool's README for where
the file comes from and how it's kept current). Only conventional
(fixed-coupon) gilts are considered; index-linked gilts are excluded
because their future coupon and redemption amounts depend on RPI inflation
between now and each payment date, which can't be projected
deterministically.

A handful of small pure functions (`accruedInterestPercent`, `dirtyPrice`,
`estimateYield`) are duplicated from `../gilt-cashflow-calculator/calc.js`
rather than imported via a shared `<script src>` — this site's convention
(see that file's own comment) is that every tool is self-contained, with no
cross-tool script dependency, even when two tools read the same JSON.

## The selection heuristic

Picking a ladder is a constrained optimisation problem: choose N gilts and
a nominal allocation per gilt to best satisfy a weighted objective (income
frequency vs. yield/return), subject to position-size, duration, exclusion
and rounding constraints, using no more than the stated investment amount.

**This implementation is a greedy heuristic, not a formal optimiser.** A
proper LP/MILP formulation over selection + weighting would be strictly
more optimal — especially once frequency and yield are blended via a single
slider — but needs a solver this static, no-build, no-npm-install site
doesn't have and isn't set up to add. The trade-off is deliberate and
disclosed here rather than accidental:

1. The horizon (settlement date → horizon end) is divided into
   `rungCount` equal-length **slots**, each with a target maturity date.
2. For each slot, every remaining eligible gilt is scored on:
   - **Maturity fit** — how close its redemption date is to the slot's
     target date, as a fraction of the slot width. Applied unconditionally
     (not scaled by the frequency/yield slider) so the result stays a
     genuine *ladder* — evenly staggered maturities — regardless of how
     the slider is set.
   - **Return** — gross redemption yield, or (for taxable accounts) a
     70/30 blend of annualised capital-gain-to-maturity and yield — see
     "Tax treatment" below.
   - **Frequency** — a bonus for using a coupon-month bucket ("Jan/Jul",
     "Feb/Aug", ... six buckets in total, since UK gilts pay semi-annually
     6 months apart) not already used elsewhere in the ladder.
   - These three are blended by `frequencyWeight` (the 0–100 slider: 0 =
     pure return, 100 = pure frequency) and the gilt with the highest
     composite score is picked, then removed from the pool.
3. Nominal is sized per rung — equal cash share, or weighted toward
   higher-return rungs — converted to face-value nominal via that gilt's
   dirty price, then rounded to the configured unit and clamped to any
   min/max nominal-per-rung constraint. Rounding means the ladder's total
   cost can land above or below the requested investment amount; the buy
   instructions report that shortfall/overshoot explicitly rather than
   hiding it.
4. **Rung count** is always the *maximum* feasible count within
   `[minRungs, maxRungs]` (further bounded by what the position-size limits
   allow) — more rungs strictly improves this model's frequency and
   granularity at no yield cost, since dealing costs are out of scope. Set
   `minRungs = maxRungs` for a fixed count instead of a range.

See `ladder-calc.js`'s `pickBestForSlot` for the exact scoring constants
(`MATURITY_FIT_WEIGHT`, `RETURN_SCALE`, `TAXABLE_CAPITAL_GAIN_TILT`) — all
called out as tunable heuristic choices in comments there, not derived
constants.

## Tax treatment

UK gilts are exempt from Capital Gains Tax on disposal or redemption
([TCGA 1992 s.115](https://www.gov.uk/guidance/gilt-edged-securities-exempt-from-capital-gains-tax)),
while coupon income is taxable as savings income outside a wrapper. So for
a **taxable** account, a low-coupon gilt trading below par (return skewed
toward tax-free capital uplift at maturity) can be preferable to a
high-coupon gilt at a similar yield (return skewed toward taxable income) —
even though both might show a similar yield-to-maturity.

This is implemented as a fixed 70/30 tilt in the selection/sizing score:
`0.7 × annualisedCapitalGainToMaturity + 0.3 × yieldToMaturity` for taxable
accounts, vs. plain yield-to-maturity for **ISA**/**SIPP** accounts (where
neither component is taxed, so there's no reason to prefer one over the
other). This is a heuristic weighting, not a real after-tax calculation —
it doesn't collect or use an actual marginal rate, Personal Savings
Allowance, or starting rate for savings, matching the same scope decision
the Gilt Cashflow & Tax Calculator makes for its own tax-split display.

HMRC's Accrued Income Scheme (ITA 2007, Part 12) — which taxes the
pre-purchase slice of a mid-period buyer's first coupon as the *seller's*
income, not the buyer's — is not modelled here either, for the same reason
disclosed in that tool's README: implementing it properly (including its
seller-side mechanics) was judged out of scope for an illustrative tool.

## Rolling vs. terminal ladders

This is a required input (`ladderType`), not a silently-assumed default,
because it fundamentally changes what "the cash-flow schedule" means:

- **Terminal**: every rung matures by the horizon end and nothing is
  reinvested — the ladder winds down and returns all capital within the
  projection window. This is the simpler, self-liquidating case.
- **Rolling**: whenever a rung matures *before* the horizon end, its
  proceeds are modelled as immediately reinvested into a new gilt targeting
  a similarly-spaced future maturity (maintaining the ladder's
  approximate length), chosen from the full remaining universe with the
  same slot-scoring heuristic as initial selection. This reuses **today's**
  snapshot price for the new gilt, since no future price is knowable — a
  disclosed simplification, not a forecast. Each reinvestment shows up as
  its own `reinvestment` row in the cash-flow schedule, distinct from a
  plain `redemption`, so it isn't silently folded into the numbers.

  A rolling ladder is expected to still be "open" when the projection
  window ends — whatever hasn't matured by then is reported separately as
  `capitalStillInLadder` / an open position, not forced into a fictitious
  final redemption. Only capital that redeems *without* a reinvestment
  target being found (a fallback for when the universe is exhausted) counts
  toward "capital returned" for a rolling ladder — normally close to zero,
  since the dataset's longest-dated gilts extend decades out.

Similarly, **coupon reinvestment** (`reinvestCoupons`) is a separate input
from the ladder type: it only affects the "projected value at horizon end"
summary figure, which compounds coupon cash forward at the ladder's blended
running yield from each coupon's date to the horizon end (a simple,
disclosed approximation — not a model of actually buying specific future
gilts with that cash). With it off, coupons are treated as spent as
received and that figure isn't shown at all.

## Position-size, duration and exclusion constraints

- **Rounding** (`roundingUnit`) and **min/max nominal per rung** are
  applied when sizing, after selection — see step 3 above.
- **Duration cap** (`durationCapYears` + `durationCapPercent`, both
  required together) limits how much of the capital can sit in gilts
  maturing beyond the given threshold, independent of the yield objective —
  a candidate that would push the running long-dated share over the cap is
  skipped for that slot entirely (not merely scored down), falling back to
  the next-best shorter-dated candidate.
- **Exclusion list** is matched by exact ISIN (case-insensitive), entered
  one per line or comma-separated in the UI.

## Testing

```bash
node --test ladder-calc.test.js
```

Covers: accrued interest/dirty price/yield (shared logic with the sibling
tool), coupon-month bucketing, feasible rung-count clamping, slot selection
under each objective extreme (pure yield vs. pure frequency), the taxable
vs. ISA/SIPP tilt, exclusion and horizon filtering, the duration cap,
rounding/clamping during sizing, buy-instruction totals, terminal-vs-rolling
schedule projection (including the reinvestment/open-position paths),
`solveIrr` against a known closed-form rate, and the summary statistics'
invariants.

**Cache-bust `ladder-calc.js?v=N`** in `index.html` any time its content
changes — see the root `CLAUDE.md` for why (GitHub Pages + Safari's
sub-resource caching can otherwise serve a stale script indefinitely after
an edit, independent of the page itself reloading).

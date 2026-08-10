# jobbltools

A collection of free, single-page browser utilities (calculators, generators,
validators), deployed statically to **tools.intheshire.io** (see `CNAME`,
likely GitHub Pages). Written almost entirely by Claude, one tool at a time.

## Structure

```
index.html              landing page: card grid, category filter chips, favourites
tools/<slug>/index.html one folder per tool, self-contained
```

Most tools are a single `index.html` with inline `<style>` and `<script>` —
no build step, no bundler, no framework. A few tools split out logic:

- `tools/hash-generator/` — `hash-lib.js` (pure logic) + `hash-lib.test.js`
- `tools/salary-dividend-optimiser/` — `config.js` (versioned data) +
  `calc.js` (pure calc engine) + `calc.test.js` + its own `README.md`

That split exists specifically so the logic is unit-testable and reusable
without a DOM. Default to a single `index.html` unless a tool has real
calculation logic worth testing in isolation — then pull it into a plain
script attached to `window.<Something>` that's also `require()`-able from
Node with zero build step (see "Testing" below).

## Adding a new tool

1. Create `tools/<slug>/index.html` (kebab-case slug).
2. Follow the shared visual conventions (below) — copy `tools/example/`'s
   `<head>`/CSS as a starting point.
3. Register it in the root `index.html`'s `TOOLS` array: `{ name, desc, href,
   categories: [...] }`. `href` is `tools/<slug>/`. Reuse an existing
   category key from `CATEGORY_LABELS` where it fits; only add a new category
   key + label if nothing existing applies.
4. No other registration needed — no sitemap, no build, no manifest.

## Shared conventions (every tool)

- `<!doctype html>`, `lang="en"`, single `<meta viewport>`, `<title>{Name} —
  tools</title>`.
- Theming via CSS custom properties on `:root`, redefined under
  `@media (prefers-color-scheme: dark)` — no toggle, follows the OS/browser.
  Always set `color-scheme: light dark`. Standard variable names across
  tools: `--bg`, `--fg`, `--muted`, `--card`, `--border`, `--accent` (add
  more like `--surface`, `--good`, `--star` as a tool needs them, keeping the
  light/dark pair in sync).
- Font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.
- Layout: `body` is a centered flex column, `main` capped with a
  `max-width` sized to the tool's content (480px for something like the
  percentage calculator, ~780px for richer tools).
- A `<a class="back" href="../../index.html">&larr; tools</a>` link at the
  top of every tool page, before the `<h1>`.
- Inputs/cards use the `--card`/`--border`/`--bg` variables, `border-radius:
  8–12px`. Keep this consistent rather than inventing a new visual language
  per tool.
- No external dependencies, no analytics, no tracking, no network calls
  unless the tool's entire purpose requires one (e.g. What's My IP, UK
  Location Facts, UK Postcode Validator's real-postcode lookup). Everything
  else runs entirely client-side.
- No frameworks (no React/Vue/etc.), no npm install required to *use* any
  tool — plain `<script>` tags only.

## Testing

There's no `package.json` at the repo root and no test runner dependency —
tools with unit tests use Node's built-in test runner directly:

```bash
node --test tools/hash-generator/hash-lib.test.js
node --test tools/salary-dividend-optimiser/calc.test.js
```

The pattern (see `salary-dividend-optimiser/README.md` for the fullest
example): logic lives in a plain script that attaches its API to a `window.*`
global for the browser, and is also `require()`-able as-is from the test
file — same file, no transpilation, no build step either way. Reach for this
split when a tool has non-trivial calculation logic (tax/finance rules, hash
algorithms) worth locking down with boundary/threshold tests; skip it for
simple, easily-eyeballed UI logic.

## Domain-specific tools

Some tools encode real-world rules that change over time (UK tax years, NIC
thresholds, Corporation Tax rates). For those:

- Cite the source (GOV.UK / gov.scot page) next to the figure, not just in a
  commit message — see `salary-dividend-optimiser/config.js`'s pattern.
- Never carry a rate/threshold over to a new year without re-verifying it
  directly from source, even if it "probably" didn't change.
- Add an explicit disclaimer in-tool when the output could be mistaken for
  advice ("illustrative estimator, not tax advice", etc.) — several tools
  already do this (salary/dividend optimiser, retirement projection,
  take-home pay).

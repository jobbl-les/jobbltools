# tools

A small collection of free, single-page utilities (calculators, generators, validators) hosted on GitHub Pages.

Live at: https://jobbl-les.github.io/jobbltools/

## Structure

```
jobbltools/
├── index.html          # landing page linking to every tool
└── tools/
    └── example/
        └── index.html  # copy this folder as a starting point for a new tool
```

Each tool lives in its own folder under `tools/` and is a single self-contained
`index.html` (HTML/CSS/JS inlined, no build step, no external dependencies).

## Adding a new tool

1. Copy `tools/example` to `tools/<your-tool-name>`.
2. Edit `tools/<your-tool-name>/index.html`.
3. Add an entry to the `TOOLS` array in the root `index.html` — `{ name, desc, href, categories: [...] }`.
   Reuse an existing category id from `CATEGORY_LABELS` where it fits, or add a new one there if none do.
4. Commit and push — GitHub Pages redeploys automatically within a minute or two.

## Navigation

The landing page (`index.html`) renders its grid from a `TOOLS` array rather than static HTML, with category
filter chips (deep-linkable via `?cat=<id>`) and a browser-local-storage-backed favourites system (a star on each
tile, filterable via the "Favourites" chip). Nothing here is server-side — favourites live only in the visitor's
own browser.

## Local preview

No build step needed. Just open the file directly:

```bash
open index.html
```

or serve the folder so relative links between tools work:

```bash
python3 -m http.server 8000
```

then visit `http://localhost:8000`.

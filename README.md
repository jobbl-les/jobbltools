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
3. Add a card for it in the root `index.html`.
4. Commit and push — GitHub Pages redeploys automatically within a minute or two.

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

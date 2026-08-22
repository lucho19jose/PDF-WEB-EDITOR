# PDF sweep harness

Runs the editor against a producer-diverse corpus of real PDFs and judges every
operation against invariants that hold for **any** generator. It exists because
PDF bugs in this project are silent and generator-specific: each new producer
exposes a new content-stream shape, and the failure is usually wrong output
rather than an exception.

## The invariants

An operation must change **exactly** what it targeted:

| check | edit | move |
|---|---|---|
| `char_delta` — characters on the page, as a multiset | target's text swapped for the new text, nothing else | **zero** change |
| `blocks_touched` — blocks whose (text, position) changed | — | ~1 |
| `geometry_error` | — | landed within 6pt of where it was asked to go |

Character histograms are used instead of block lists because MuPDF legitimately
re-groups blocks after an edit (adjacent runs merge, long runs split). That is a
presentation change, not corruption, and counting it as failure buries the real
bugs in noise.

This single family of checks found every bug the sweep has caught so far:
silent no-ops, the wrong block being edited, collateral damage, text destroyed,
and one document that hung the engine for 20 minutes.

## Running it

```bash
# 1. census every PDF in a folder (producer, version, page count)
node tools/pdf-sweep/survey.mjs "/path/to/pdfs" > tools/pdf-sweep/survey.json

# 2. stage a producer-diverse sample under public/_sweep/
node tools/pdf-sweep/pick.mjs "/path/to/pdfs" 50

# 3. static features: fonts, CID, ToUnicode, ActualText, CTM, clipping, operators
node tools/pdf-sweep/features.mjs

# 4. experiments — in the browser, with the dev server running
#    (the driver needs the live worker, so it runs inside the app page)
#    open http://localhost:9000, then in the console:
#      await import('/_sweep/driver.js')
#      window.__manifest = await (await fetch('/_sweep/manifest.json')).json()
#      window.__results = []
#      for (const m of window.__manifest) window.__results.push(await window.__sweep.runPdf(m))
#      copy(JSON.stringify(window.__results))
#    save that as tools/pdf-sweep/results.json

# 5. merge into one report per PDF + a flat dataset
node tools/pdf-sweep/report.mjs
```

## Output

- `reports/NNN.json` — one report per PDF: features, every experiment, per-strategy
  summary, `best_strategy`.
- `dataset.jsonl` — one flat row per experiment, features and outcome together.
  This is the training-ready file: the features are the inputs, `success` /
  `internal_strategy` the labels.
- `aggregate.json` — failures grouped by producer family and strategy, for triage.

## Privacy

The corpus is the user's real documents and the reports quote their text and
file names. `public/_sweep/*.pdf`, the manifest and every generated artefact are
gitignored; only these scripts and the driver are tracked. This repository is
public — keep it that way.

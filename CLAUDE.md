# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PDF Editor Pro v2 — a professional PDF editor that edits the **actual PDF content stream** (like Adobe Acrobat Pro), not overlays. Uses a dual-engine architecture: PDF.js for rendering + MuPDF WASM for content stream editing.

## Commands

```bash
npm run dev        # Vite dev server on http://localhost:9000 (or 9002 if 9000 taken)
npm run build      # Production build
npm run preview    # Preview production build
```

## Stack

- **Vue 3** + **TypeScript** + **Quasar 2** (dark theme, Vite-based)
- **Pinia** for state management
- **PDF.js** (pdfjs-dist v5) for rendering
- **MuPDF WASM** (`mupdf` npm package) for content stream parsing/editing in a Web Worker

## Architecture

### Dual-Engine Design
- **PDF.js** handles all rendering (canvas-based page display)
- **MuPDF WASM** handles content stream reading/writing/text extraction in a Web Worker
- After editing, MuPDF saves → PDF.js reloads the saved bytes → re-renders

### Rendering Layer
- `src/composables/usePDFViewer.ts` — PDF.js wrapper: load documents, render pages
- `src/components/viewer/PDFViewer.vue` — Canvas-based rendering + TextBlockOverlay + re-render after edit

### Content Stream Engine (`src/engine/`)
- `bridge.ts` — Main-thread Promise-based API wrapping worker postMessage. Singleton via `getMuPDFBridge()`
- `worker/mupdf.worker.ts` — Web Worker hosting MuPDF WASM with:
  - Dynamic `await import('mupdf')` (not static import — avoids top-level await hang)
  - ToUnicode CMap parsing for font encoding (`parseToUnicodeCMap()`)
  - Font-aware text replacement: decode hex glyph IDs → match text → re-encode with reverse CMap
  - Fuzzy text matching for incomplete CMaps (ligatures cause '?' placeholders)
- `worker/worker-protocol.ts` — TypeScript message types for worker communication
- `types.ts` — TextBlock, TextChar, TextLine, PageTextData interfaces

### Stores
- `src/stores/document.ts` — Document state: loaded, pages, scale, bytes, modified flag
- `src/stores/editor.ts` — Tool selection, status text, editing state

### Text Editing Flow
1. User clicks text block in edit mode → inline textarea opens
2. On commit: `bridge.replaceText()` → worker finds matching BT/ET block in content stream
3. Worker decodes hex Tj strings using font's ToUnicode CMap, matches via fuzzy matching
4. Worker re-encodes new text to hex glyph IDs using reverse CMap (Unicode → GlyphID)
5. Modified content stream written back to PDF page
6. MuPDF saves → PDF.js reloads → canvas re-renders showing the change

### Component Hierarchy

```
App.vue
└── EditorLayout.vue (q-layout)
    ├── MainToolbar.vue (q-header)
    ├── PageThumbnails.vue (q-drawer left)
    ├── EditorPage.vue (q-page-container) — provides pdfViewer + pdfEngine
    │   └── PDFViewer.vue (canvas rendering)
    │       └── TextBlockOverlay.vue (clickable text blocks + inline editor)
    └── StatusBar.vue (q-footer)
```

### Saving is a download, and downloads have three preconditions
`saveFile` → `offerDownload` in `EditorLayout.vue`. All three of these failed
silently while the status bar still said "PDF saved successfully":
- the anchor must be IN the document before `click()` (Firefox ignores a
  detached one);
- the object URL must outlive the click — `URL.revokeObjectURL` on the next
  line cancels the transfer, worst on the multi-megabyte files this app makes;
- a programmatic download needs **transient user activation**, which expires
  ~5s after the click that granted it. `saveDocument()` can outlast that when
  the op queue is still finishing an edit's save→reload on a large document,
  and the browser then drops the download without firing any event.

When `navigator.userActivation.isActive` is false at download time, prompt for
a fresh click instead of reporting a success that never happened. Never mark
the document saved on a path where the bytes did not actually leave.

### Concurrency invariant
ALL document-level mutations (text edits, annotations, page ops, undo/redo,
save) run through the global FIFO queue in `src/utils/opQueue.ts`
(`enqueueOp`). An op landing between another op's `saveDocument` and
`loadDocument` mutates a doc that is about to be replaced (silently lost), and
undo snapshots read stale `docStore.pdfBytes`. Never call the engine's
mutating APIs outside the queue.

### Ghostscript / signed-PDF support (Intellisign etc.)
- `readContentStream` must call `readStream()` on the INDIRECT array element,
  never on the resolved object (MuPDF quirk) — resolving first makes every
  chunk of a multi-stream page read as empty.
- Symbolic embedded subsets with no `/Encoding` (Flags bit 3) use raw glyph
  indices as byte codes; they decode/encode via the ToUnicode CMap
  (`codeBytes` 1 or 2), and replacements are written as hex literals.
- Ghostscript merges a whole table ROW into one TJ array with kern jumps
  between cells: `replaceInsideTjArray` swaps only the target glyphs, appends
  a width-compensating kern, and picks the occurrence nearest the clicked
  position (`scanShowOps` tracks per-op x/y via Tm/Td/TL/T*).

### Content-stream parsing invariant
BT/ET block scanning uses `scanBtBlocks()`/`maskStreamLiterals()` — string
literals, hex strings and name tokens are masked before operator scans, so
text like "(BUDGET REPORT)" or "/GS_ET" can't truncate a block. Show-text ops
are decoded/replaced via a sequential literal walk (`decodeBtBlockText`,
`replaceTjInBlock`) covering Tj, TJ, ' and " with nested parens and `]`
inside array strings. ToUnicode CMaps record `codeBytes` (1- or 2-byte codes).

### Key Patterns
- `usePDFViewer` and `usePDFEngine` composables are `provide`d from `EditorPage` and `inject`ed in children
- PDF.js worker: `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)`
- MuPDF worker: `new URL('./worker/mupdf.worker.ts', import.meta.url)` with `{ type: 'module' }`
- `shallowRef` used for PDF.js document proxy (prevents Vue deep proxying)
- Font encoding cache avoids re-parsing ToUnicode CMaps on each edit

### Font handling (Acrobat-style)
Replacement text is encoded via `planTextEncoding()` in the worker:
1. **Keep original font** when every character can be encoded: hex CID fonts via
   reverse ToUnicode CMap; simple fonts via MacRoman/WinAnsi tables plus a
   glyph-availability check (Widths of 0 inside FirstChar..LastChar = glyph
   missing from the subset).
2. **Substitute a standard base-14 font** (Helvetica/Times/Courier family picked
   from the original's name + FontDescriptor flags, preserving bold/italic) when
   the original subset lacks needed glyphs — like Acrobat's font fallback. The
   UI reports "substituted <font>" in the status bar and `replaceText()` returns
   `substitutedFont`.
3. Error only when even WinAnsi can't represent the text (e.g. CJK).

`getCtmAtOffset()` replays q/Q/cm operators so move/resize (`transformTextBlock`)
converts page-space deltas through the inverse CTM — required for print-to-PDF
files that wrap text in scaled/flipped matrices like `0.24 0 0 0.24 cm`.

### Text positioning invariant (Tm is NOT guaranteed)
A BT block's origin must be read with `getBlockOrigin()`, which replays
Tm/Td/TD/TL/T*, never by grepping for `Tm`. Many generators (wkhtmltopdf,
FPDF/TCPDF — e.g. the "ACTA DE ENTREGA" forms) emit `BT x y Td (text) Tj ET`
with no Tm at all; reading only Tm reported "no position", which silently
disabled line grouping and made move/resize fail with "Could not find matching
text in content stream". `BtInfo.hasPos`/`hasTm` carry that state — filter on
`hasPos`, not on `yPos >= 0` (a legitimate Td origin can be negative).

`transformTextBlock` therefore has two paths: rewrite the existing Tm, or —
when the block has none — inject `sx 0 0 sy e f Tm` right after `BT`. BT resets
the line matrix to the identity, so every following Td/TD/T* is relative to the
injected matrix and the whole block (all its lines) transforms with it.

### Text is not only in the page's content stream
`getContentSources()` returns the page stream AND every Form XObject the page
invokes, walked recursively (TCPDF's page invokes `/TPL0`, whose stream invokes
a *different* `/TPL0` — the text is two levels down). Each source carries the
`/Resources` its fonts resolve against, set through `withSource()`; `/F1` inside
an XObject is a different font from `/F1` on the page, and the font caches are
keyed by source for that reason. Whole generators (TCPDF, Canva) were entirely
uneditable before this: MuPDF extracts their text, so the UI showed blocks the
editor could never find.

Sources are cached per page and invalidated on load, on any content-stream
write, and on page reordering. Without the cache a Visio page with 230 `Do`
operations re-read every XObject on every keystroke-level operation and the
editor hung for minutes. The number of XObject sources is capped
(`MAX_XOBJECT_SOURCES`) and the cap is logged rather than silently applied.

### A glyph is unusable when its advance is zero
`encodeForSimpleFont` decides substitution from the **Widths array**, never from
the BaseFont name or the embedding flag. Word subsets fonts without the
`ABCDEF+` prefix, and even a NON-embedded font takes its advances from the PDF's
own Widths — so a zero width stacks every such glyph on one spot whatever face
the viewer substitutes. Reading it any other way silently turned "SWEEPMARK"
into "SWEPMARK".

### ToUnicode bfrange has two destination forms
`<lo> <hi> <dst>` (incremental) and `<lo> <hi> [<d1> <d2> …]` (explicit list).
A regex that only knows the first does not merely miss the second — it
re-matches triples of entries INSIDE the array and invents mappings, which is
why Qt output decoded as `????????` and could not be edited at all.

### Matching invariant: text alone never identifies a block
The same string appears more than once on a page all the time — an email
subject repeated in the quoted original, a running header, a value in several
table rows. Both matchers (`replaceTextInContentStreamFontAware` and
`findBtBlocksByPosition`) therefore COLLECT every textual match, score each by
`btBlockDistanceToTarget()` — the block's Tm origin pushed through the
enclosing CTM and flipped into MuPDF's top-left page coords — and apply the
nearest one. Returning the first textual match silently rewrote a different
paragraph while the clicked one looked uneditable.

Never compare raw Tm values against a bbox: print-to-PDF files wrap text in
matrices like `0.675 0 0 -0.675 28.5 813.42 cm`, so the two live in different
spaces. Distances are bucketed (8pt) before the score tiebreak so the
comparator stays a valid total order.

### Moving one line out of a many-line block
Adobe and TeX draw a whole page from one BT whose lines hang off a single
shared Tm; nudging that Tm slides all of them (dragging one label moved 34
blocks). When the block holds materially more text than the target and the move
is a pure translation, `transformTextBlock` brackets just the target's show-op
run with a `Td` and its inverse — the line matrix is restored immediately after,
so every later line lands exactly where it did.

Two constraints: the run must START a line (a Td inserted mid-line resets the
pen to the line start and scrambles the rest of it), and the operands must be
expressed in **Tm space**, not CTM space — Td is multiplied by the text matrix,
so feeding it the CTM-space delta overshot by 5.9x on a page whose Tm scales by
0.17. **Known limitation:** a mid-line target inside a shared-Tm block still
falls back to moving the whole block.

### One BT block can hold several independently positioned lines
SUNAT/JasperReports emit `BT Tm (line 1) Tj Tm (line 2) Tj ... ET`. Moving such
a block must rewrite the Tm that GOVERNS the clicked text — `findGoverningTm()`
locates the show-op run matching the target and walks back to the last Tm
before it. A plain `content.match(/… Tm/)` grabs the first one and drags the
wrong line (moving "GUÍA DE REMISIÓN ELECTRÓNICA" moved "RUC N°…" instead).

### Small caps: fold case, and never trust /ActualText after an edit
LibreOffice small-caps exports (Elejandría ebooks) draw every letter as a
CAPITAL glyph and fake lowercase with a smaller `Tf` — one visual line becomes
~24 BT blocks alternating 20pt/14pt, each letter wrapped in
`/Span <</ActualText (l)>> BDC … EMC`. Three consequences, all of which made
such pages completely uneditable:

1. The stream decodes to `EL PRINCIPITO` while MuPDF, honouring ActualText,
   reports `El Principito`. All text comparison therefore goes through
   `foldForMatch()` (case-folded, whitespace-collapsed). The discrimination
   this costs is bought back by the position ranking above.
2. Run scoring uses `matchRatio()`, which measures length AFTER folding and
   dropping `?` placeholders. Scoring on raw length rewarded a run for shedding
   its first letter whenever the full run contained an unmapped glyph, leaving
   a stray "A" in front of the replacement.
3. `applyLineReplacement` counts any block with a visible glyph, NOT just
   `hasSubstantialText` (>1 char). One-character blocks are the norm here, and
   skipping them left "L", "." and "," stranded beside the new text.

After rewriting glyphs, `stripActualText()` must run on the block: the override
describes the OLD letters, so extraction (including this engine's own next
`getTextBlocks`) reports them instead of what was actually drawn.

**Known limitation:** when a font is substituted, MuPDF's re-extraction can
report spurious spaces inside the new run ("Texto  editado corr ect amente").
The render and the saved PDF are correct; only the block list is affected.

### Moving text must move its clip window
Browser print-to-PDF wraps each page header/footer in its own
`q <x y w h> re W* n  q <scale> cm  BT … ET  Q Q`, and the band is barely
taller than the line. `transformTextBlock` therefore looks up the innermost
active clip (`getActiveClipAtOffset`) and grows it to the union of its old and
transformed self (`expandClipForTransform`). Without that, dragging such a line
more than ~3pt pushes it outside the band and it disappears from the render AND
from MuPDF's extraction — the text is still in the file, just clipped away,
which reads as "the block vanished".

The union is used rather than a plain translation because it can only reveal
more of the clipped group, never hide something that was visible — hiding is
the failure being fixed. Rewrites are collected as splices and applied
back-to-front, since a clip sits at a LOWER offset than the block it bounds.

### Text-block selection is anchored, not id-based
`TextBlock.id` is `page:extractionIndex` and is **not stable**: every edit runs
a save→reload cycle that re-extracts the page, and moving a block changes its
place in MuPDF's extraction order. `TextBlockOverlay` keeps a
`selectionAnchor` (text + centre) and re-resolves `selectedBlockId` after each
`loadBlocks()`. Never persist a raw block id across a reload — before this, the
selection either vanished on every move (the `renderVersion` watcher cleared
it) or, worse, stayed pointing at whatever paragraph inherited the index.

### Known Limitations
- **CID fonts with incomplete CMaps**: Some glyphs (especially ligatures like 'ti', 'fi') may not have ToUnicode mappings → decoded as '?' → fuzzy matching compensates
- **Single BT block replacement**: Each edit targets one BT/ET block. Multi-block edits need separate operations
- **Text position**: Replaced text uses the same position/size as original — no automatic reflow; justified TJ kerning is not regenerated
- **Substituted fonts are not embedded** (standard base-14, always available in viewers)

## Vite Config Notes
- COEP/COOP headers needed for SharedArrayBuffer (WASM)
- `optimizeDeps: { exclude: ['mupdf'] }` — prevents Vite pre-bundling of MuPDF
- `worker: { format: 'es' }` — ES module workers

## Important Notes
- The old v1 app at `../web-app/` uses a fundamentally different overlay approach — do not copy its patterns
- MuPDF is AGPL licensed — fine for personal use, needs commercial license for distribution
- `fontDict.length` returns 0 in MuPDF JS bindings — access fonts by name via `.get('F48')` instead of iterating
- ToUnicode stream: call `readStream()` on the unresolved indirect reference (`.isStream()` returns false after `.resolve()`)

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

### Ask where to save BEFORE saving, not after
Both ways of writing a file out — `showSaveFilePicker` and a programmatic
`<a download>` click — need **transient user activation**, and that expires about
five seconds after the click that granted it. `saveDocument()` routinely outlasts
that: the op queue may still be finishing an edit's save→reload on a large
document. Ask afterwards and the picker throws `NotAllowedError` / the download is
dropped with no event at all, while the status bar cheerfully says the PDF was
saved.

`saveFile` therefore calls `pickSaveTarget()` FIRST — spending the activation
while it is fresh — and only then runs the engine save and writes to the handle
it already holds. The handle does not expire. This is also the only path that can
report the truth: `await writable.close()` completing means the bytes are on
disk, whereas a download is fire-and-forget.

`offerDownload` remains the fallback for browsers without the File System Access
API (Firefox), and there three things still have to be right, all of which failed
silently at some point:
- the anchor must be IN the document before `click()` (Firefox ignores a
  detached one);
- the object URL must outlive the click — `URL.revokeObjectURL` on the next
  line cancels the transfer, worst on the multi-megabyte files this app makes;
- the anchor must not be removed in the same tick as the click (Chromium has
  been seen to cancel the transfer).

On that path the status says "Download started", not "saved": nothing comes back
from the browser to justify a stronger claim. Never mark the document saved on a
path where the bytes did not verifiably leave.

### Printing goes through the engine bytes, in a hidden iframe
`printFile` saves the document and prints THAT, not the on-screen canvas —
printing the canvas would emit a screen-resolution bitmap of a vector document.

The bytes go into a hidden same-origin iframe because
`iframe.contentWindow.print()` needs **no user activation**, which `window.open`
does; after a multi-second save there is no activation left to spend. Some
COEP/plugin configurations refuse to embed a PDF and the iframe then neither
loads nor fires `error`, so a watchdog timer is the only signal — on timeout the
user is offered an "Open in new tab" BUTTON, whose click supplies its own fresh
activation for the popup.

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

### A rebuilt block keeps EVERY operator that placed the pen
`rebuildBtContent` re-emits the block from scratch, so whatever positioned the
original has to be carried over — `leadingPositionOps()` collects the Tm, Td,
TD, TL and T\* that run before the block's first show op and re-emits them in
order. Keeping only `Tm`, as it used to, draws at the text-space origin; and
because these blocks are almost always inside a clip, the text does not land in
the wrong place, it lands **nowhere**. It disappears from the render and from
every extractor, so the edit reads as having deleted the line — reported as
"after I write José Luis B it disappears".

Two separate defects produced that, and either alone is enough:

- **`TD` was not matched, only `Td`.** They differ solely in that TD also sets
  the leading, which has nothing to do with where the pen is. Word re-saved
  through iLovePDF positions every block with `1 0 0 1 0 0 Tm` + `TD`, so the
  whole document rebuilt at the page origin.
- **The pre-show slice was cut at the first `(`, `<` or `[`.** Word writes
  `0 J [] 0 d 0 j 1 w 10 M` ahead of its positioning, so the slice stopped at
  the empty dash array and never reached the operator that mattered — which
  breaks lowercase-`Td` generators just as thoroughly. The cut-off is now the
  first show op, located on the LITERAL-MASKED content, the same rule
  `scanBtBlocks` and `getBlockOrigin` already follow.

The operators are re-emitted verbatim rather than folded into one `Tm`: Td
operands are multiplied by the text matrix, so a block whose Tm carries a scale
cannot have its offsets added into the matrix. Re-emitting a duplicate (iText
writes the same `Tm` twice) or a `TL` that nothing then consumes is harmless —
dropping one is not.

Only the rebuild path was affected, which is why this survived so long: the
surgical `replaceTjInBlock` path leaves the positioning alone, and a rebuild
only happens on a font substitution or a wrapped multi-line replacement. On the
corpus it changes 403 of 2912 blocks across 5 producers and flips no sweep
result except the one it fixes.

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

### A fontless block inherits its Tf — and a substitution must give it back
Font is graphics state, so a BT block need not set one: PDF24 draws each form
field's VALUE as `BT x y Td [(…)]TJ ET` with no `Tf` at all, inheriting the
`/TT1 11.04 Tf` set by the block that drew the LABELS. `scanBtBlocks` already
resolved that (`fontAt`), but `rebuildBtContent` read the font to restore out of
the block's OWN content:

    const restoreTf = (newFontRef && tfMatch) ? `\n${tfMatch[0]}` : ''

`tfMatch` is null for such a block, so nothing was put back and the SUBSTITUTED
face stayed in force past `ET`. Every later fontless block then inherited it,
`fontAt` reported it as their font, and the font filter (`blockUsesFont`)
rejected the very block holding the target. The symptom is that editing one
field breaks the NEXT one: on a six-page report, changing "Área" made "Técnico"
fail with *"Could not find matching text in content stream … font TT1"*, while
each field edited fine in isolation. The comment above that line already
described the hazard — the guard just never covered the case that needed it
most, because it asked the block for state the block had inherited.

`BtInfo.inheritedTf` carries the operator VERBATIM (`fontOpAt`, recorded only
when the block sets no `Tf` of its own) and is threaded to every substitution
call site. The same null `tfMatch` also made `tfSize` fall back to a flat `12`,
so this document's 11.04pt fields were redrawn half a point too large; the
inherited size fixes that in the same expression. `applyPartialBlockReplacement`
had the identical guard on its op-window restore, and `replaceInsideTjArray` the
identical `12` default — both take the inherited value now.

Every branch short-circuits to the old expression whenever the block HAS its own
`Tf`, so the only behaviour that changes is a substitution on a fontless block.

A q/Q wrapper around the rebuild was considered and rejected: `Q` would RESET
the colour, `Tc`/`Tw`/`Tz`/`Tr` that the original block deliberately left in
force for the blocks after it, which is the same class of silent damage in the
other direction. Restoring beats resetting — the stream after the edit should
behave like the stream before it.

`fontAt`/`fontOpAt` REPLAY q/Q (a stack over the literal-masked stream). They
used to be textual, and a `Tf` set inside a `q…Q` before the block yielded a
stale font: Word draws a bullet's tick in its own `q … BT /C2_0 Tf … ET Q` and
the sentence after it as a fontless block inheriting the `/TT0` set before the
`q` — read textually the sentence "inherited" the tick's font, decoded as
`????????`, and every bullet of every technical report was uneditable.
**Known limitation:** a fontless block inside a Form XObject that inherits from
the invoking stream still gets no `inheritedTf`, and no restore is emitted.

### Don't re-encode the characters the edit didn't touch
A replacement is encoded in ONE font, and a line is under no obligation to be
drawable in one. These technical reports start every bullet with a `✓` that its
own font draws — a CJK subset (`/C0_0` KozMinPr6N, `<3F8E>`) or Wingdings — and
set the sentence after it in Calibri. Re-encoding the whole line therefore had
to find a single face holding both the tick and the Latin text, found none, fell
through to the WinAnsi substitute, and WinAnsi has no U+2713:

    Cannot encode characters: ✓ (not supported by fallback font)

Every bullet on every page was uneditable — the entire body of the document,
since the findings and conclusions are all bulleted. The tell in the report was
that **erasing the line and retyping it worked while editing it did not**: an
erase-and-retype drops the `✓`, an edit keeps it.

`narrowToChangedOps` drops LEADING show ops whose glyphs the new text still
begins with, and only the remainder is re-encoded. Leaving the tick's operator
alone is not a workaround for the encoder, it is the more faithful edit — the
character did not change, so the operator that drew it should not either, and it
keeps its own font instead of being approximated by a substitute.

It runs ONLY as a rescue, after the whole-run encode has already failed. Trimming
unconditionally would be worse: where a run does encode today, the untouched head
would stay in the original face while the changed tail became Helvetica, putting
two faces inside one line. Measured on the 52-file corpus the rescue changes
nothing — 262 experiments, 227 successes, identical before and after.

**Trimming the TAIL is the obvious symmetry and it is wrong.** A run's later ops
are placed by their own `Td`, an offset computed for the width of the text that
USED to precede them; `Td` translates the LINE matrix, so it does not follow the
glyphs actually drawn. Leaving those ops untouched while the text before them
changes length strands them at the old offset — a gap when the replacement is
shorter, and the two printed through each other when it is longer. That shipped
briefly and turned "✓Fecha de garantía: … (Según fabricante)." into a line drawn
over the one beneath it, extracted as the interleaved
`✓✓/FFeecchhaa …` shuffle. A LEADING op has no such dependency: it is drawn
before the replacement, so its position cannot depend on the replacement's width.

Whole ops only: an op is the smallest unit whose font is known, so a symbol in
the MIDDLE of an edited run still has to be re-encoded with everything around
it, and typing a genuinely new `✓` into a block whose fonts cannot draw it still
fails — correctly, with the message above, and without touching the page.

`applyBlockReplacement` falls back to the partial path when its own whole-block
encode fails, because a bullet that is a block of ITSELF never reached the
narrowing otherwise (the delegation is otherwise gated on the block holding much
more than the target). Document-wide that took the bullets from 0 to 23 of 24.

**Known limitation:** the last one is a bullet whose `✓` is a BT block of its own,
so it is matched as a LINE GROUP; `applyLineReplacement` picks the leftmost block
as primary — the tick — and encodes the whole line for the tick's font. The same
narrowing one level up (drop a leading BLOCK the edit did not change) would fix
it and is not implemented.

### A matched op that CONTAINS the target is a table row, not the target
Ghostscript draws a whole table row as ONE TJ array, the columns separated by
kern jumps rather than by separate ops. A memo's addressee line is therefore a
single op reading `A :  Ing. Matías Miguel Mamani Cabrera` — the label, the
colon and the name together — and the op-level matcher in
`applyPartialBlockReplacement` fuzzy-matched it against the target
`:  Ing. Matías Miguel Mamani Cabrera` at 0.95 and picked it. The op-level
replacement then writes the new text into the op and blanks the rest of the
window, so the replacement was drawn at the START of the row and every other
cell was deleted: **the "A" label vanished and the name moved into its column.**

`replaceInsideTjArray` exists for exactly this and was never reached — it was
gated on `if (!best)`, i.e. only when NOTHING matched at op level. Here
something does match, *because* the row contains the target.

Two things had to change:

- **The gate is a containment test, not a length ratio.** The row is only two
  characters longer than the target and those two characters are the label, so
  any "materially bigger" threshold waves it through (`× 1.25 + 2` did). The
  test is: the op's text is not the target, CONTAINS it, and what is left over
  after removing it still has a visible glyph. Then the array must be edited
  from the inside.
- **The search inside the array is whitespace-COLLAPSED.** `full` is the array's
  literal items concatenated, and the gap between two cells is a kern, not a
  space glyph — so the run's own spacing need not match the spacing MuPDF
  reported for the block. An exact `indexOf` missed the very rows the function
  exists for. The projection is matched and mapped back to raw item positions,
  so the boundary-alignment guard still applies.

If the surgical path cannot be taken the edit is REFUSED rather than applied at
op level: this array holds cells the edit never named, and losing an edit is
recoverable where silently deleting the rest of the row is not. Likewise an
unencodable cell is only fatal when the array was the only candidate — with an
op window still in hand it just means this route is not the one.

**Known limitation:** a replacement needing glyphs the embedded subset lacks is
refused here, because in-array substitution is deliberately gated on a known
byte encoding and plausible widths (see the in-array gate commit) and a
Ghostscript subset has neither. Editing such a row to text it can already draw
works; typing a name with new letters reports that it could not be matched.
Measured: same-glyph, shorter and longer replacements all keep the "A" label and
land in the right column; the corpus is unchanged, 262 experiments, 227
successes, no regressions. The same gate is why `N°` accepts `Nro`, `No`, `N`
and `De` but not `zzz` — that font has no `z` — which reads as "some edits work
and some don't" unless you know what to look at.

### A big annotation is a click SHIELD — the smaller target takes the click, again
Inserting one screenshot-sized image (~470x300pt) made everything under its
rectangle dead: the annotation hit-target sits at z 16, text at 4, content
images at 3, so every click inside its footprint selected the stamp — no
text edit, no image move, reported as "after I insert an image I can't do
anything, maybe performance". Nothing was slow (a 12MB document commits a
move in ~1.1s); the clicks simply never arrived.

Same rule the content images already follow, extended to annotations:

- An annotation over 40,000 pt² (200x200pt — several times any signature,
  note or patch) drops to z 3: text and everything else win their clicks
  over it, and it stays above the content images.
- Among annotations, `scaledAnnots` sorts BIGGEST FIRST, so a signature
  sitting on an inserted screenshot still wins its own click — the same
  ordering the content images use for a frame around a photograph.
- While SELECTED it comes back to z 16 so it can be dragged from anywhere —
  and a plain click (no drag) on an already-selected annotation DESELECTS
  it, or the text underneath would stay shielded with no way through: click
  once to pick the image up, click again to put it down.

Verified in the browser on the reported document: text under the inserted
image opens its editor, the image itself moves, the second click releases
it, and the signature widgets still take their own clicks.

### A space-padded table strip splits at its padding — but only a proven strip
The fund-request form pads its amount row with literal SPACE GLYPHS —
"S/    1,170.00S/    210.60S/ …" — so `splitBlocksAtGaps`, which only split
at GEOMETRIC gaps, saw none: the gap is paved. Four columns arrived as ONE
block and clicking one amount opened an editor spanning all of them. A run
of ≥3 whitespace glyphs wider than the gap threshold now acts as a column
separator (excluded from both segments — it belongs to neither cell), and
once a line shows **two or more** such separators it is a padded strip, which
also unlocks a tighter geometric threshold for that line — the cell border
between a right-aligned amount and the next column's "S/" is 5.7pt at this
5pt font, just under the prose threshold of 7.4.

The ≥2-separator gate is not decoration. Applied to every line, the split
took apart single-gap "label:   value" pairs across the corpus — three files
churned (Corel datasheet, a timesheet, a valorización) for no user-facing
gain, since the merged pair was already editable. Gated, the corpus is
byte-identical to before the change; ungated it was −5.

Two matcher guards were exposed by the finer targets and are now in:
- **Step-3 exact matching compares space-free too.** Extraction invents
  spaces the stream does not draw ("2 3.059,52" for a block reading
  "23.059,52"), and collapse-only equality failed the very block the click
  meant — leaving a sloppy fuzzy line-run 50pt away as the best offer.
- **`applyLineReplacement`'s PRIMARY must also carry only target glyphs**
  (when the run has other members): the primary is rewritten, so its own
  foreign glyphs are deleted as surely as a blanked neighbour's — a currency
  "$" led a fuzzy run for the amount beside it, took the replacement, and
  vanished. Single-block runs are exempt; '?' placeholders are exempt.

### Td lives in the space the Tm MATRIX defines — compose it, or positions lie
`scanShowOps` used to add Td operands straight onto the Tm translation, which
is only right while the Tm matrix is the identity. The bilingual form's table
blocks set `0 1.00124 -1 0 e f Tm` (a quarter turn) and step between rows
with `-713 -20.76 Td`: every op's tracked position lived in a frame nothing
else uses, so the clicked cell could not be compared against anything.
Positions are now accumulated in line space and pushed through the matrix —
for an identity Tm the arithmetic is unchanged, and the sweep gained two
MOVE experiments on the SUNAT guía that had never passed.

Three consumers were fixed with it, all found through one report — "I edited
the second row and the THIRD changed":

- **`blockLocalPoint` maps ALL FOUR corners.** Probing only y-varied points
  at bbox[0] collapses the local box to a single point under an axis-swapping
  CTM (xEnd === x, yLo === yHi) — every overlap test then compared against
  nothing. It also returns `unitScale` (√|det CTM|) so local-frame distances
  can be stated in page points before being ranked against page-frame ones.
- **Containment candidates rank by where the target is DRAWN, not where the
  block starts** (`opRunDistanceToTarget`). One BT straddles table rows on
  this producer, every row repeats "MSP-SIST-CS-2024-003-002", and the
  block-origin ranking routinely picked the block drawing the NEXT row's copy
  — the edit landed one row down while reporting success. The admission test
  ALSO waves garbled blocks through: block-level decode does not follow
  mid-block Tf switches, those cells decode as '?', and `wildcardIncludes`
  treats '?' as a wildcard — so position is the only honest signal here. A
  block whose ops decode to nothing keeps its origin distance rather than
  being dropped.
- The op-window and in-array choosers inside `applyPartialBlockReplacement`
  compare the same corrected positions automatically.

Measured: all eight rows' code cells edit their OWN row (was: off by one),
every earlier page-2 case still lands with char_delta 0, and the sweep is
262/228 — two experiments BETTER than baseline, none worse.

### Arriving on a page adopts BOTH its geometries, or the overlays lie
`adoptCurrentGeometry` runs only when a page is RENDERED, and a page already
painted is not re-rendered on arrival — so `pdfPageWidth/Height` kept the
PREVIOUS page's paper while `pageWidth/Height` took the new page's canvas.
Every overlay scales `bbox × pageWidth/pdfWidth`, so on a document whose page
1 is portrait 595x842 and page 2 landscape 842x595 the two are exactly
swapped: measured, x scaled by 1263/595 = 2.12 and y by 892/842 = 1.06 where
both should be 1.5. Every clickable text box on page 2 sat somewhere else,
so clicking a line opened the editor on a DIFFERENT line — which reads as
"I still can't edit this page" no matter how well the engine matches, and is
invisible on any document of one paper size.

The `currentPage` watcher now adopts both. The pdf-space sizes are kept in
their OWN map (`pdfSizes`, points, rotation already applied by PDF.js's
viewport) rather than derived from the CSS-pixel `sizes` map: that one is
measured at whatever scale the page was painted at, so dividing it by the
CURRENT scale is wrong for exactly as long as a zoom change takes to repaint.

**Test at the DOM level, not just the engine.** Every engine-level probe of
this page passed while the app was unusable, because the failure was in the
mapping between the two. `elementFromPoint` at a block's centre returning
that block's own overlay is the check that proves it — the same rule already
recorded for the file-input overlay.

### A /Rotate page's LINES run along the other axis — the frames were already right
A landscape fund-request form (/Rotate 90, one glyph per BT, 485 blocks a
page) read as almost entirely uneditable. Not because of coordinates:
`getContentSources` already composes `pageRotationCtm` into every source's
invocation CTM, so `getFullCtmAtOffset` maps a block straight into the
rotated (visible) frame — the SAME frame extraction reports the target bbox
in, with getBounds()'s post-rotation height as the flip. Converting the bbox
again "to be safe" rotates the target twice: measured, the one exact-match
candidate scored 372.8pt of distance while sitting dead on the click. Do NOT
add frame conversions at the entry points; the geometry is handled below.

What was actually wrong: the LINE GROUPING. A visual line on a /Rotate 90|270
page is constant text-space X with Y advancing, and grouping by Y put every
glyph of "税号 RUC: 20606091380" in its own group — no multi-block line could
ever assemble. Grouping, reading order, and the line-start choice all follow
the rotation now (ascending Y for 90, descending for 270, reversed X for 180).

### A glyph the NEIGHBOUR draws is still part of the line
The same form fuses boundary glyphs across cells: "暂扣款（质保金" is seven
one-glyph blocks and the closing "）" is the first character of the
"）Importe Pagado …" block beside it. Three consequences, each shipped as its
own guard:

- **A prefix run with a provable fused tail is a first-class candidate.** No
  contiguous run equals the target, and the only textual match left was a
  sloppy fuzzy 90pt away that edited the WRONG copy of the label and clipped
  a glyph off its neighbour. When a run reads as a strict prefix of the
  target AND the next block provably starts with the missing remainder, it is
  ranked just under an exact match (1.9 — above every fuzzy, which also
  claims prefix windows and then draws the fused tail a SECOND time). The
  remainder stays on the page, so it is trimmed off the replacement at apply
  time (`consumeSuffixFree`); an edit that CHANGED the fused tail skips the
  candidate rather than half-applying.
- **A line group provably far from the click is never applied.** Distance was
  only a ranking term, so a garbage fuzzy run with no competition simply won.
  Line candidates with a KNOWN distance over 48pt are skipped; Infinity means
  "position unknown", and the no-position fallback some generators need keeps
  working.
- **A lone block holding more than the target is the containment shape at
  EVERY level.** The line scorer skips such windows (the partial path edits
  inside the block); `applyBlockReplacement` delegates to the partial path on
  provable containment even when the excess is ONE glyph — "）Importe Pagado"
  is only a bracket bigger than its target, far under the 1.4× glyph-count
  slack, and the whole-block rewrite deleted a bracket that belongs to the
  cell before. And `applyLineReplacement` refuses to BLANK a block whose
  folded, space-free text does not appear in the target ('?' placeholders
  exempt — unreadable is not foreign).

### A substituted window restores the font at its END, not the block's first Tf
A three-line cell — two Latin lines under a font inherited from BEFORE the
BT, then a CJK line set by the block's only in-content Tf — corrupted its
untouched lines the moment line one was edited with a substitution: the
restore grabbed "the block's first Tf", which is the CJK one, and the Latin
lines after the window rendered as garbage and extracted as U+FFFD. The ops
after a window inherit the font in force at the window's END: `op.fontRef`
(the last in-block Tf before the op), or — when null, meaning no Tf preceded
it inside the block — the block's ENTERING font, `inheritedTf` verbatim or
the resolved name in `block.fontRef`. Sizes come from `textStateAtOp` at the
window, not from whatever Tf happens to appear first in the content.

### A line no single font can draw narrows at BLOCK level — both ends
Bilingual lines ("申请部门 Area solicitante: Sistemas") mix a CJK font and a
Latin one; re-encoding the whole run needs a face holding both, there is
none, and WinAnsi has no 申. `narrowLineAndRetry` in `applyLineReplacement`
is `narrowToChangedOps` one level up: drop the blocks the edit did not
change and re-run on the middle. One difference makes BOTH ends safe here
where the op-level trim may only touch the head: each BT block carries its
own absolute position (BT resets the line matrix), so an untouched TRAILING
block keeps its place however the text before it changed — the Td-offset
hazard is between ops, not between blocks. Strictly a rescue: it runs only
after the whole-run encode has failed.

**Known limitations on this producer:** a cell whose extraction block spans
TWO visual lines (Latin row + CJK row, "COSTO CONTRATO + ADENDAS 合同+…")
matches nothing — the halves live in different line groups and the Latin half
is fused behind a stray bracket; the edit refuses cleanly. Cells whose font
decodes to garbage (the E001-* invoice numbers) refuse for the
incomplete-decode reasons already documented. Sweep: 262 experiments, 226
successes, totals identical to baseline; one experiment that used to corrupt
4 characters now passes clean.

### The SECOND edit of a row must survive the first one's artifacts
Editing the memo's addressee twice — "Ing." → "Ingeniero.", then "Ingeniero."
→ "Gerente." — destroyed the row on the second pass: the "A" label vanished
and the name redrew starting in the label's column, the exact failure the
containment gate exists to stop, on the exact row it was built for. Two
artifacts of the FIRST edit disabled it:

- **Extraction and the stream disagree on spaces after a re-encode.** The
  first edit's wider replacement leaves the row's original trailing SPACE
  glyph at its old pen position — the compensation kern deliberately keeps
  every later item where it was, and that position is now inside the new run.
  MuPDF orders extracted glyphs by position, so the invisible space
  interleaves as a phantom: "Cabrera" reads back "Cab rera" (measured: space
  at x=358.9 between the b at 353.6 and the r at 360.3). The second edit's
  target then carries a space the stream does not draw.
- **Every comparison on the containment path was space-SENSITIVE.** The gate
  (`does the op hold more than the target`), the candidate filter, and
  `replaceInsideTjArray`'s projection search all used collapsed-whitespace
  `includes`/`indexOf` — and "…Cabrera…" does not contain "…Cab rera". The
  gate answered no, the edit fell through to the op-level rewrite of the
  whole array, and the op-level rewrite is ALWAYS wrong for a row that holds
  more than the target.

Both ends are fixed. Matching is space-FREE (spaces removed, not collapsed)
in all three places — spaces identify nothing in a TJ array, where cell gaps
are kerns and extraction invents its own — with occurrence bounds re-absorbed
over boundary-literal spaces so the alignment guards still see literal edges.
And `replaceInsideTjArray` now ABSORBS the space-only literals immediately
following the replaced range into the splice: a space is the one glyph safe
to move (nothing visible marks where it was, and the replacement carries its
own), and with no glyph stranded mid-run the phantom never forms — three
consecutive edits of the row read back clean. Absorption requires known
widths for what it absorbs, or the row's other cells would shift; unknown
widths just leave the space where it was.

The `spanText` for a tagged span's /ActualText goes through `looseReplace`
for the same reason — a plain `.replace` silently no-ops on the spacing
mismatch and the span keeps claiming the old words.

Measured: baseline and fixed sweeps are experiment-identical (262 runs, 226
successes, 0 diffs) — the change only alters behaviour where extraction
spacing disagrees with the stream, which a first edit never hits.

### A ONE-character label needs a per-RUN position, and now has one
The same memo labels its addressee row `A`, against `De`, `Asunto` and `N°`
below it. It was unreachable, and the note that stood here said so: containment
is the only pass that can find it inside the single BT that draws the whole
header, containment demanded two characters, and lowering that to one put the
replacement in the wrong place — asked to change the label, the engine rewrote
the signature line 500pt away and interleaved "PARA" into "Alberto" as
`PAlbReArto`. The reason was that a block containing a lone letter is ranked by
distance from that BLOCK'S ORIGIN, and the origin of a BT drawing an entire
header is nowhere near the clicked row. The note ended: *a fix needs per-RUN
positions at selection time, not per-block.* That is now what exists, built for
moving a run inside a TJ array (below), and three things use it:

- **`runDistanceToTarget`** — where inside a block the target is actually drawn,
  measured on real glyph advances. A one-character target is admitted to the
  containment pass only when a run carrying it SITS on the click, and the
  candidate is then ranked by that distance instead of the block's. Nothing
  changes for targets of two characters or more.
- **`runGapToTarget`** — the same measurement for a chosen op window. The op
  scan's own distance is only a TIE-BREAK, so a stray match can win on score
  outright: against the one-character target it found a lone-glyph `a` at the
  end of "Tecnología" — a perfect ratio — 350pt away and a line down, while the
  label itself lives inside a big TJ array and is never scored at op level at
  all, because the array breaks the length guard immediately. The replacement
  went there: "Tecnología" came back "Tecnologírrrr" and the label was
  untouched. A window that does not sit on the click is now dropped, which lets
  the in-array path run and find the label. Restricted to targets of three
  characters or fewer — below that length the text carries almost no
  identification, and above it the op scan has a corpus behind it.
- **`replaceInsideTjArray` filters occurrences to literal boundaries BEFORE
  choosing**, not after. Every `A` inside "Alberto" and "Activos" sits
  mid-literal and would be rejected by the guard at the end anyway; dropping
  them first leaves the standalone `(A)` the click actually meant, where
  choosing first and rejecting afterwards gave up on the whole array.

The vertical term is measured to the BOX, not to its centre. A baseline sits a
few points below the middle of the box it draws, and counting that as
displacement rejected the very run that drew the text — measured, 3.2pt of
ordinary descender slack became 13 against a 10pt budget, so `blockLocalPoint`
returns the box's full local span and the gap is zero anywhere inside it.

Verified in the browser on the reported memo: `A` → `rrrr` rewrites the label,
the colon stays in its column, "Tecnología" is untouched, and the ink in the
label cell goes from 63 dark pixels spanning 90.7–98pt to 107 spanning
91.3–107.3. `De` → `XY` (two characters, the neighbouring case) picks
`De :   Ing. Juan Alb` at the clicked x. A long value on the same row still
takes the untouched op-level path.

### A run inside a TJ array can be MOVED as well as edited
The same shape one level over: Word draws the three rules above a signature
block as ONE array whose columns are kern jumps —
`[(__)-3 … (__)-4  ( )-1796  ( )(_)9 …]TJ` — inside a BT that also holds the
names and the job titles. Every matcher in the move path works at show-OPERATOR
granularity, so the smallest thing it could address was that whole array: 68
characters against a 20-character target, which `findTargetRun` rejects on
length before it ever looks at the text. `findGoverningTm` returns nothing
because the block has no `Tm` at all (it positions with `Td`), so
`transformInSource` refused. Selecting the three rules and dragging them
reported *"Could not be moved — no matching text found in the content stream"*
while the names on the lines either side moved perfectly well.

`findTargetSegment` + `shiftInsideTjArray` address the run itself. **`Td` cannot
be used here** — it moves the LINE matrix, so a `Td` in front of a mid-line run
resets the pen to the start of the line and scrambles everything after it. The
two displacements that are safe mid-line are:

- **x — a kern**, `k = −tdx·1000/Tfs`, with its exact negation after the run so
  the pen lands where it always did for everything that follows;
- **y — `Ts`** (text rise), restored afterwards to whatever was in force. `Ts`
  is in unscaled text-space units, the same space `Td` operands live in.

The array is split into up to three ops around the run, the shape
`replaceInsideTjArray`'s substitution branch already emits. Splitting does not
change the block's decoded text: `BtInfo.decodedText` is decoded over the whole
block in one pass, so the separating kern still yields its synthesised space.

It is consulted ONLY where every other strategy has already given up, so no move
that worked before can change. Three things had to be right, and each was wrong
first:

- **The `Tf` scan cannot ask for the font's NAME.** `textStateAtOp` reads the
  size in force from the LITERAL-MASKED content, where `/TT1 11.04 Tf` reads
  `/    11.04 Tf` — the name is blanked. A pattern requiring the name matches
  nothing at all, which read back as "no font size" and refused every block that
  has one. The operand is all there is to match on.
- **An empty array advances by nothing; that is not the same as unknown.**
  Splitting a run off the FRONT of an array leaves `[] TJ`, and calling its
  advance unknown made the whole line's pen position unknowable with it — which
  silently disabled the position guard below.
- **A run that does not sit on the clicked text is not the run.** A row of
  underscores fuzzy-matches any other row of underscores, so once the first rule
  had been split out, `findTargetRun` matched THAT for the second and third and
  stacked all three on top of each other. `findTargetRun` now takes the target's
  span in block-local space and refuses a winning run whose real pen span does
  not overlap it — measured on actual advances, and skipped entirely when any
  width is unknown, so where it cannot be answered the run stands exactly as
  before. This is the same rule `findBtBlocksByPosition` follows one level up:
  text alone never identifies anything here.

Measured on the reported document, in the browser, at pixel level: the three
rules' ink runs move from `[128,292] [337,534] [575,756]` to
`[152,316] [361,558] [599,780]` — **+24 x, +40 y on every one, widths
unchanged** — for a drag asking exactly that. The extraction BOX moves by a
different amount because a split re-attributes the leading spaces between the
runs; the box is not the ink and must not be what such a change is judged on.

**Not in scope:** resize (scaling a run inside a shared array needs every glyph
advance rebuilt, so `pureTranslate` stays a precondition), and taking precedence
over a shared `Tm` — moving one cell of a Ghostscript table row still drags the
row, and changing that needs the sweep re-run.

### Object operations never edit the matrix that placed the image
Acrobat's "Objetos" panel — flip, rotate, crop, align, arrange, replace — for
the pictures the CONTENT STREAM draws. `orientContentImage`, `cropContentImage`,
`alignContentImage`, `reorderContentImage` and `replaceContentImage` all follow
the rule `transformContentImage` established: the CTM chain placing an image can
be arbitrarily deep and is shared with everything else inside that `q`, so it is
never rewritten. A correction is INJECTED around the `Do` — `q M cm /Name Do Q`
with **M = F·T·F⁻¹**, F being the full CTM at the Do and T the change stated in
plain user space. The q/Q keeps it off everything drawn after, and because each
call re-reads F the operations COMPOSE: two quarter turns measure back to the
original footprint, to the point.

- **Flip vs rotate and the clip.** A mirror keeps the axis-aligned footprint, so
  no clip can start cutting the picture and none is touched. A quarter turn
  SWAPS width and height — and a photo in a Word table cell is bounded by that
  cell's `re W* n`, so turning a wide picture upright inside a wide band would
  push its ends outside the clip, where they are not misplaced but invisible.
  Clips in force are therefore grown, and only ever grown.
- **Crop CLIPS, it does not resample.** The image data is untouched, so nothing
  is lost, Ctrl+Z restores it, and a second crop intersects the first — which is
  what clips do and what cropping twice should mean. The rectangle cannot simply
  be written at the Do: `re` would be read in F, an arbitrary and possibly
  rotated space. The injection switches to user space (`Finv cm` makes the CTM
  the identity), states the rectangle there, and switches back (`F cm`) for the
  Do. Note `listContentImages` still reports the full PLACEMENT rect, not the
  cropped one.
- **Arrange is a move, because paint order IS document order.** The old
  invocation is BLANKED where it stands — not cut — so the offsets of every
  other image the caller listed stay valid, and a fresh one carrying the
  absolute placement is written at the top or bottom of the page stream. Page
  images only: an XObject's `/Name` resolves against that form's resources, so
  hoisting one into the page stream would name a picture the page has never
  heard of and draw nothing.
- **Replace adds a NEW XObject, never overwrites the old one.** The same image
  is routinely drawn more than once — a logo in a header, a rule repeated down a
  table — and replacing the resource in place would change every one of them at
  once. Only the one invocation is repointed.

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

### The decode must agree with EXTRACTION — right or wrong
A signed order (Intellisign over a Chinese generator, fonts named
`*Verdana-14399` etc., one CID subset per style run) exposed four defects at
once; the reported symptom was one uneditable date line, and the real scope was
every line of every such document. Matching compares the extracted target
against this engine's own stream decode, so what matters is that the two AGREE
— even when the CMap is lying. That document's ToUnicode maps CJK glyphs to
Latin junk ("fHi :lEl M:" for 开始日期), and the junk is fine as long as both
sides read the same junk:

- **A ToUnicode destination is a UTF-16BE STRING, not one code point.**
  `<003E> <0045006C>` maps ONE glyph to "El"; `parseInt` on the whole hex made
  a number past 0x10FFFF and the glyph decoded '?', while MuPDF's extraction
  expanded it. Two '?' against extraction's five junk chars can never align,
  so the line matched nothing. `glyphToText` carries multi-char destinations
  (single code points, surrogate pairs included, stay in `glyphToUnicode`).
- **A block whose first show op precedes its first Tf decodes its head with
  the ENTERING font.** This producer opens a BT, draws "Plazo de ejecución"
  under the `/C0_1` still in force from the previous block, and only then
  switches to `/C0_7` — labelled C0_7, the head decoded as
  "7ECIFNDDNDEDCICEMFN" and the whole 20-line block was unmatchable.
  `fontRef`/`inheritedTf` now come from `fontAt(start)` in that case; the
  decoder follows every in-block Tf, so only the head runs change.
- **A SUBSTITUTION is as much a reason to narrow as an error.**
  `narrowToChangedOps` only rescued a failed encode; a successful substitute
  encode re-encoded the whole window — and the garbled label's junk is
  encodable Latin, so the CJK glyphs were REPLACED by literal "fHi :lEl M:"
  drawn in Times-Bold. Narrowing now also runs before accepting a substitute,
  and its comparison is space-FREE (`consumePrefixFree`) because extraction
  and the stream disagree on spaces inside exactly these garbled runs. With
  the unchanged label ops dropped, the date run re-encodes in its own font.
- **The reverse CMap needs a WITNESS, not a guess.** Several glyphs claim the
  same character in these subsets, and one of C0_1's glyphs claims 'l' but
  draws '1' — re-encoding "al" rendered "a1". `preferredGlyphCodes` collects
  the codes the block itself uses per character (in the font in force at the
  window) and `encodeTextForFont` consults them ahead of `unicodeToGlyph`: a
  code that provably drew the character on this page beats whichever claimant
  the map happened to keep.

Measured: the reported line edits cleanly (dates change, 开始日期 stays, no
substitution), a second edit of the same line works, the head line edits too,
and the sweep is experiment-identical to baseline (262 experiments, 228
successes, zero gained/lost/changed).

### Replacement text has to be given room
Longer text is silently truncated by whatever bounds it, and the characters are
then in the file but invisible and unfindable. `replaceTextInStream` widens two
things: every clip rectangle in force at the match (clips INTERSECT — Word
nests the same rect twice around a table cell, so widening only the innermost
achieves nothing) and, for a Form XObject source, the form's own `/BBox`.

Both are sized generously: the width estimate averages the ORIGINAL glyphs and
a substituted base-14 face is usually wider. Over-widening only reveals more of
the group being bounded, so erring high is free.

**Known limitation:** a form invoked by another form is also clipped by the
PARENT's clip rectangle. Widening the whole invocation chain is not implemented,
so deeply nested text (Canva) can still lose its last character or two.

### Size guards must count glyphs, not decoded characters
Rewriting a block that holds far more than the target destroys the rest of it —
Ghostscript draws a whole table column as one BT, and one edit wiped 29 other
blocks. Both `applyBlockReplacement` and `applyLineReplacement` refuse in that
case rather than fall through to a whole-block rewrite: losing the edit is
recoverable, silently deleting the column is not.

The size must come from `estimateGlyphCount()`, which counts show-op literals in
the STREAM. Measuring decoded text instead makes the guard blind exactly where
it is needed most: when a font's ToUnicode is incomplete the decoded text is
empty or `????` while the block still holds an entire table row.

Font state also survives ET, so `rebuildBtContent` restores the original `Tf`
after a substitution — otherwise every later block that inherited that font gets
silently re-fonted.

**Partly fixed.** On a Corel datasheet (`/Corel_OTF … DP` marked content, CID
font with a 29-entry ToUnicode), replacing `3/4''` used to rewrite a whole row —
702 characters across 36 blocks. Corel is the generator that sets `Tf` BEFORE
the `BT` and leaves the block itself fontless, so it was hit by the leaked-Tf
bug above: a substitution re-fonted its neighbours and the line-group run
selection then spanned them. With the inherited `Tf` restored the collateral
damage is gone — measured on the sweep, `char_delta` 690 → 0 and
`blocks_touched` 36 → 2.

What remains is the run selection itself: the replacement still does not land in
the clicked cell (the sweep reads `1/2''` where it asked for its marker), so the
experiment is still not scored a success. The changed region begins mid-block at
a `TD`, and that is the part that is wrong — not the size test, and no longer
the font.

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
`selectionAnchors` list (text + centre, one per selected block) and re-resolves
`selectedIds` after each `loadBlocks()`. Never persist a raw block id across a
reload — before this, the selection either vanished on every move (the
`renderVersion` watcher cleared it) or, worse, stayed pointing at whatever
paragraph inherited the index.

`findByAnchor` takes a `taken` set, because a multi-block selection routinely
contains repeated text (a column of identical table values); without it every
one of those anchors resolves to the same block and the rest of the selection
silently evaporates.

### The selection is a set — one block is never "the field"
Extraction splits a paragraph into one block per line, and splits each line
again at every wide gap, so "Label:" and its value are two blocks and a
four-line address is at least four. Selecting one and moving it moves one line
out of a field, which is not an operation anyone wants.

`TextBlockOverlay` therefore selects a SET: a rubber band over empty page area
(`.marquee-target`, z-index 0, deliberately UNDER `.text-block` so a click on
text still selects that text), Shift/Ctrl+click to toggle one, Ctrl+A for the
page. The band selects anything it TOUCHES, not what it fully contains —
stopping a point short of a descender would silently drop that line with no way
to tell why.

Dragging any member of a selection drags the whole selection; re-selecting just
the block under the cursor would discard the group the user just built. Resize
scales every block about the SAME anchor (the union bbox's opposite corner), so
the group keeps its shape instead of each line growing in place.

### Moving text has to push what it lands on out of the way
A content stream has no flow: text is drawn at absolute coordinates, so dropping
a paragraph on another one paints them on top of each other. `layoutCollision.ts`
resolves this as a **displacement**, not a reflow — reflow would have to re-break
and re-justify lines, which cannot be done safely to a table or a form.

Three things the implementation depends on:
- The unit of displacement is a **row**, not a block (`groupIntoRows`). A visual
  line is several blocks; moving only the half that overlapped tears it apart.
- Overlap pads on **Y only** (`overlaps`). Padding X as well makes the two
  columns of a two-column layout — or a label and its value across a narrow
  gutter — read as a collision, and one drag shoves half the page around.
- Direction is decided by which side of the incoming text a row's centre sits
  on, and a row NEVER reverses: the cascade only ever pushes further in the
  direction a row started, which is what makes it terminate. A row caught
  between two pushes is left alone and counted in `blocked` rather than
  oscillated.

A push that would leave the page is refused and reported. Text overlapping is
visible and fixable by hand; text shoved off the page edge is destroyed silently.

### A multi-block move is ONE engine call
`transformTextBlocks` (worker) extracts the page ONCE and resolves every op
against that single snapshot. Looping `transformTextBlock` instead does not
work: each call re-extracts, ids are extraction indices, and moving a block
changes where it sorts — so op #2 addresses a page that op #1 already
renumbered, and the wrong paragraph gets dragged.

Ops are sent as `[displacements…, selection…]`, in that order, so obstacles have
vacated their old coordinates before the dragged text is matched — two runs with
the same text sitting on top of each other is precisely what defeats the
position-based matching in `findBtBlocksByPosition`.

The consequence of that order is that a move which fails to match leaves the
page rearranged around text that never moved. `describeTransform` reads the
SELECTION's slice of the results (not the whole batch) and says so explicitly,
pointing at Ctrl+Z — reporting on the whole batch would call a failed move a
partial success just because the displacements landed.

### An action you cannot see is an action you do not have
The selection's delete button used to hang off the block's right edge, which put
it past the canvas for anything in the right margin and under the toolbar for
anything on the first line. `actionBarStyle` floats it above the selection, flips
it below when there is no room, clamps it to the page on both axes, and paints it
on a solid dark chip — a bare icon button over white paper is invisible.

### Restyling text: the Tf operand is NOT the visible size
`restyleTextBlocks` changes font family, size and fill colour of text already on
the page. Two things about it are counter-intuitive and both were bugs first:

- Quartz and Distiller draw with `/F3.0 1 Tf` and keep the scale in the text
  matrix (`12 0 0 -12 … Tm`). Writing the requested size into `Tf` renders at
  size × matrix — 24pt came out at 288pt. What is well defined is the RATIO of
  the requested size to the size MuPDF reports (the product of both), so the
  ratio is what multiplies whatever operand is there.
- Font, size AND fill colour are graphics state that outlives `ET`. Every
  rewritten block is therefore wrapped in `q`/`Q`; without it, restyling one
  line restyles every later line that inherited its state — the same trap
  `rebuildBtContent` documents for `Tf`, colour included.

Size and colour are applied surgically (rewrite the operand, leave every show
op, TJ kern array and Td offset alone), so justified text stays justified. A
family change cannot be: the string bytes are codes into the OLD font's
encoding, so the run is decoded, re-encoded as WinAnsi and the BT block rebuilt
around a registered base-14 face — which costs the original kerning. It is
refused outright when the BT block holds materially more than the target, the
same guard the replacement path uses.

A rewrite that leaves the stream byte-identical returns FAILURE. Reporting it as
applied is worse than reporting the error: the status bar claims the style
landed and the page plainly disagrees.

### A block's colour is its FIRST CHARACTER's, not its paragraph's
MuPDF merges a whole paragraph into one structured-text block, and
`splitBlocksAtGaps` used to copy the parent's colour onto every line it split
out. Recolouring one line then reported the paragraph's colour back, so the
toolbar showed a black swatch over text the user had just turned blue — and the
next edit looked like it had silently failed. `TextChar` carries its own
`color`; a split block takes its first char's, falling back to the parent's.

(`toStructuredText('preserve-whitespace,collect-styles')` is NOT the fix and was
tried — the argb is already populated without it.)

### Text that grows has to be GIVEN the room, in points
A content stream has no flow. Text drawn at absolute coordinates does not push
anything aside, so every edit that changes how tall a run is has to move the
rest of the page itself — `planPushDown` (down) and `planReflow` (up) in
`layoutCollision.ts`, applied through `planRowShift` in `TextBlockOverlay`.

Three things this got wrong before they were fixed:

- **The amount is points, not lines.** Sizing the gap as `lines × OLD fontSize`
  left a wrapped 22pt line sitting on top of the paragraph under it. Room needed
  is one `lineStep(newSize)` per line GAINED plus `(newSize − oldSize) × 1.2` for
  the first line growing taller.
- **The engine decides the line count, not the caller.** `replaceText` and
  `restyleTextBlocks` return `lines`, because the user's own breaks are only
  half of it — the right margin can force more. The plan is remade when the
  count disagrees with the guess.
- **The plan is built BEFORE the edit**, and carried as anchors. Every
  replacement re-extracts the page and renumbers the blocks after the one it
  rewrote.

### A line break the user typed must survive being read back
`onBlur` read the editor with `textContent`, which concatenates the div-per-line
a contenteditable produces with nothing between them: "one
two" came back as
"onetwo" and the break was destroyed before the engine ever saw it. `readEditor`
uses `innerText` and drops only trailing blanks.

In the worker, `layoutReplacementLines` splits on explicit newlines FIRST and
word-wraps each paragraph to the room between the block's left edge and
`PAGE_RIGHT_MARGIN`. That makes "typed a break" and "outgrew the page" one code
path; they used to be two that disagreed. Anything over one line goes down the
rebuild path — the surgical replacement cannot emit a second line at all.

### A multi-line selection edits as ONE piece of text
All of it goes back into the FIRST block and the others are emptied; the engine
re-wraps and the page reflows to whatever line count comes out. Mapping line N
onto block N falls apart the moment a line is added or removed in the middle.
The cost is that the group takes the first block's font, size and colour — for
the lines of one paragraph, which is what a multi-line selection nearly always
is, they were already the same.

It needs its own button on the selection action bar: in edit mode a plain click
opens the editor for the one block under the cursor, which collapses the very
selection the user just built.

### Wrapping is MEASURED, never counted
`layoutReplacementLines` wraps on real glyph advances — `measureEm` walks a
base-14 `mupdf.Font` and sums `advanceGlyph`. The old estimate divided the
block's width by its character count and wrapped on that many characters, which
holds only while the replacement is as wide as what it replaced: "MMMM WWWW" is
nearly twice the width of the same number of lowercase letters, so three
"wrapped" lines each ran off the right edge of the paper, where the text is
neither visible nor recoverable.

The measuring face is a stand-in for whatever the page really uses, so it is
calibrated against the one width known for certain — what the block ACTUALLY
occupies today — and the ratio is clamped to [0.5, 2].

`LINE_LEADING` is 1.4, not 1.2: the base-14 faces this path substitutes to have
an ink box about 1.37em tall, and lines set at 1.2 overlapped the one beneath by
~2pt. `lineStep` in `TextBlockOverlay` mirrors it — the engine decides how much
room each emitted line takes and the client decides how much room to make; they
have to agree.

### A resized run must DESCEND, not just push
A bigger font grows upward from the baseline as well as down, so a resized run
climbs into the line above it — at 30pt over a 12pt page the two were fully
interleaved. `restyleInSource` drops the block's own Tm by the whole em gained
(`baselineDrop`), through the inverse CTM the same way `transformInSource` does
its moves. It has to happen in that same rewrite: wrapping changes the block's
text, so it could not be re-found and moved afterwards.

The caller then makes `baselineDrop × 1.4 + gained × lineStep` of room below —
the run's line box grew as well as multiplied.

### The editor's backdrop is chosen against the text, not fixed
The inline editor shows the line in ITS OWN colour — that is what makes it read
as editing the text in place rather than in a dialog — so its panel cannot be a
constant. It was `rgba(255,255,255,0.97)`, and a table header is white on dark
blue: opening one showed an EMPTY box. The line was still there and still
white, and simply could not be read while it was being typed. Any light colour
does it — a yellow highlight, a pale grey caption — which is why `editorBackdrop`
tests Rec. 709 LUMINANCE rather than "is it white", with the threshold above
mid-grey so anything hard to read on white gets the dark panel instead.

The colour goes on as an INLINE style, which outranks any selector, `:focus`
included — the stylesheet still sets the light panel and would otherwise win
back the moment the editor took focus. `caretColor` follows the text for the
same reason the panel does.

Measured on a Word table header: `getComputedStyle` reported
`color: rgb(255,255,255)` on `background: rgba(255,255,255,0.97)` before, and on
`rgba(32,33,36,0.97)` after; a body paragraph at `rgb(34,34,34)` still gets the
light panel. The content-stream side was never at fault — the same edit measured
2919→2857 dark and 961→999 white pixels in the cell, i.e. the replacement kept
both the dark fill and the white glyphs.

**The FreeText editor in `AnnotationLayer` has the same trap** — `.ft-editor`
puts `editorStore.textColor` on a fixed near-white panel, so choosing white text
there is invisible in the same way. Not fixed here.

### Reading a contenteditable: neither property will do
`textContent` concatenates the div-per-line with nothing between them and
destroys the break. `innerText` keeps the break but applies CSS rendering rules
— it collapses runs of spaces and TRIMS the trailing one, which most PDF lines
have. That made merely clicking into a line and out again read as a change and
rewrite the content stream for an edit nobody made. `readEditor` walks the nodes
instead, and `sameText` compares whitespace-insensitively so a stray space can
never cost a rewrite.

### `loadBlocks` only announces when it has nothing better to say
Every edit ends with a reload, and the "Edit mode: N text blocks found" status
was overwriting the line that had just explained what the edit did — the wrap,
the blocks moved, the foot of the page that could not move. It announces only on
entering the tool and on opening a document.

### A blur must never commit an editor that was never filled
`openInlineEditor` fills the contenteditable a tick after it opens. A blur that
lands in that window reads an EMPTY editor, and committing that empties the
block — clicking through several lines quickly silently deleted one of them.
`editorPopulated` gates the commit, and the nextTick callback CANCELS the edit
when the element never mounted rather than leaving a blank editor open.

For the same reason `commitEdit` ends with `closeEditorIfStill(block)`: a commit
takes a save→reload, and by the time it finishes the user may have opened
another line. Clearing `editingBlock` unconditionally shut THAT editor, leaving
it unpopulated and one blur away from writing a blank over the text under it.

### Room for a replacement is measured, not counted
The rows being replaced sit at the DOCUMENT's leading (15pt for 12pt text in a
typical file); the lines this engine emits sit at `LINE_LEADING`. Counting rows
gained and multiplying by the step ignores the difference and it compounds — a
two-row group edit came up 3pt short, a five-row one would be nearly 10.
`planReplacementShift` takes `drawnLines × lineStep` minus the span those rows
occupy today, and anchors the push on the LAST row replaced.

### The file input sits ON the button — styled INLINE, with a click fallback
Open and Insert-another-PDF are `<input type="file">` elements laid over their
buttons, transparent and filling them, so the click lands on the input and the
browser opens the chooser itself.

Two things make that survive a dev session:

- **The overlay is styled inline, not through a scoped class.** A scoped
  stylesheet can go out of sync with its template across a hot reload; when it
  did, the input stopped covering the button, the button had nothing behind it,
  and it went dead until a full page reload. That is precisely the "it breaks
  every time you make a change" report.
- **The button keeps an `@click` that clicks the input.** The two can never both
  fire: either the overlay covers the button, so the click never reaches it, or
  it does not, and the handler is the only thing that opens the chooser.

Verified by removing the overlay's style at runtime and confirming the button
still opens a document.
Open and Insert-another-PDF are `<input type="file">` elements laid over their
buttons, transparent and filling them (`.file-pick`). The user's click therefore
lands on the input and the browser opens the chooser itself. Nothing has to
reach an element, keep user activation alive across a handler chain, or have
provide/inject wired in time.

Two earlier designs failed for the user while passing every test here:

- **Created per click.** An element inserted microseconds before the click, a
  listener whose only reference is the closure that made it, one orphan left per
  cancelled dialog.
- **A `<label for>` around the button.** The HTML spec SUPPRESSES label
  activation when the click falls on interactive content, and these controls are
  buttons — the chooser never opened. Verified, not assumed.

The tests here could not tell those failures apart, because the automation
intercepts the chooser REQUEST: a chooser that the browser requests but refuses
to display looks identical to one that opened. `document.elementFromPoint` at
the button's centre returning the file input is the check that actually proves
it.

The value is cleared as soon as the File is captured, so the same document can
be opened twice in a row — a file input fires `change` only when the selection
changes.

### Superseded: permanent inputs reached by `.click()`
`openFile` and `insertFile` click `<input>` elements that the layout renders and
that live for the whole session, off-screen. The previous design created one per
click, appended it, and removed it on `change`/`cancel`.

That version passed every test here and still failed for the user — the chooser
simply never appeared. Created-per-click is the part with failure modes that
cannot be ruled out from outside: an element inserted microseconds before the
click, a listener whose only reference is the closure that made it, and one
orphan left behind per cancelled dialog. A permanent element has none of them,
it survives hot reloads, and its handler is bound by the framework.

The value is cleared BEFORE opening: a file input fires `change` only when the
selection changes, so on a persistent element re-opening the same document twice
in a row would otherwise be silently ignored.

(The note below is what the per-click version had to get right, kept because
`triggerDownload` still creates its anchor that way.)

### A temporary input or anchor must be IN the document before `click()`
`offerDownload` learned this for its anchor; `openFile` had not. The file input
was created detached and clicked, which LOOKS like it works — the chooser opens
— but nothing holds a reference to the element once the function returns, so it
and the `change` listener that was going to read the file can be collected while
the OS dialog is still up. The user picks a PDF and the app does nothing, with
no error anywhere.

The input is appended off-screen (`left:-9999px`, NOT `display:none`, which some
browsers refuse to click), removed on `change` and on `cancel`, and a file that
cannot be read now reports instead of failing silently.

### An image goes IN the flow, not on top of it
The image tool used to stamp at a fixed 10% inset regardless of what was there.
It now takes the line you click, asks `TextBlockOverlay.makeRoomAt()` to open
`height + 2 × gap` of space above or below it, and centres itself on the TEXT
COLUMN — an image centred on the paper reads as off-centre on any document whose
margins are not symmetric.

Room is made BEFORE the image is stamped. The other order puts the picture down
and then slides the text out from under it, which flickers and, if the reflow
fails, leaves the image on top of the text with nothing to say so.

`PDFViewer` provides `makeRoomInText` because the two layers are siblings — the
annotation layer cannot reach the text layer any other way.

### A full page spills onto the next one — and keeps going
`planPushDown` refuses to push a row past `pdfHeight - PAGE_BOTTOM_MARGIN`,
which used to leave the foot of the page overlapping. Those rows are REDRAWN on
the next page (creating it if needed) at the top margin.

`spillChain` is a chain, not a hop. The first version pushed the target page's
content down blindly and stopped: on a document whose next page already had
text, its last lines were shoved past the bottom of the paper — still in the
file, drawn off the page, gone as far as any reader is concerned. That is the
"the text disappears and the pages end up blank" report. Text displaced off a
page has to keep going, bounded by MAX_SPILL_PAGES.

The margins matter for the same reason: with the limit at the paper edge, text
ended at 788 of 792 points — unreadable, and one point from being lost.

### Old spill notes
`planPushDown` refuses to push a row off the paper, which used to leave the foot
of the page overlapping. Those rows are now REDRAWN on the next page (creating
it if needed) at the top margin, and whatever was already there is pushed down
by the height arriving.

Redrawn, not moved: a content-stream run cannot be relocated to another page
without carrying its font resources with it, so spilled lines come back in
base-14 Helvetica at their original size, colour and left edge. That is a real
loss of fidelity, and the status bar says how many lines it happened to.

Three things this got wrong first, all silent:
- `block.color` is a Vue reactive proxy and cannot be structured-cloned to the
  worker — `DataCloneError` mid-spill, the same trap the ink tool documents.
- A page created by `insertBlankPage` has `/Contents` set to MuPDF's NULL
  object, not JS null. `readChunk` called `resolve()` on it while BUILDING its
  candidate array — outside every try — so the read threw and `addText` returned
  a bare `success: false`.
- The lines were deleted from the old page BEFORE being drawn on the new one, so
  those two failures destroyed the text outright. Draw first, delete only what
  landed.

The whole insertion is ONE undo point: the caller snapshots before making room
and passes `pushSnapshot: false` to `annotOp`, or one action would take two
Ctrl+Z — the first leaving the page rearranged around an image no longer there.

### A blank field has no text — position is not a fallback, it is the signal
Every matching step needs characters to work with: the line runs skip an empty
normalized target, single-block matching demands two characters, containment
demands two. A form's blank fields extract as whitespace-only blocks — the gap
between "Andahuaylas," and "de" where the day goes — so they produced ZERO
candidates, and typing into one reported "Could not find matching text in
content stream" while the page sat unchanged. Filling in a blank is the edit a
form most obviously needs, and it was the one edit that could never work.

Step 5 of `replaceTextInContentStreamFontAware` collects candidates by position
alone when `matchLength(normalizedTarget)` is zero. Two guards keep it honest:
the block must SIT on the clicked bbox (`dist <= max(6, targetBlock.height)`,
the same test `findBtBlocksByPosition` uses), and only blocks that are
THEMSELVES blank are eligible — so a near miss can never overwrite the label
beside it. It is inert wherever the text steps already produce something: on the
52-file corpus it changes not one result.

### Overlapping text extracts as a SHUFFLE, not as two blocks
MuPDF orders extracted glyphs by position, so two runs drawn over each other
come back as one block whose text INTERLEAVES them. Two copies of
"Correo Electrónico: barbozagonzalesjose@gmail.com" 39pt apart read as

    "Correo E Cleocrtrreóon iEcole: cbt arróbnoizcaog:o bnazarbleoszjoasgeo@…"

Neither the exact test nor `fuzzyTextMatch` can see through that, so the line
matched nothing at all: it could not be edited, and it could not even be
DELETED — "Could not find matching text in content stream", with the wrong text
still on the page and no way to remove it. Any page with overlapping text lands
here: double-struck fake bold, a watermark crossing a line, a stamped value over
a form field — or a document this editor damaged itself before the two fixes
above.

A shuffle preserves the character multiset exactly, and the run loop already
holds the run's concatenation, so `sameCharacters()` compares sorted characters
— one sort, no order-aware DP. It is a NECESSARY condition and not a sufficient
one (anagrams exist), so it is tried only after exact and fuzzy have both
failed, is refused below `SHUFFLE_MIN_CHARS`, scores 1.5 (above any fragment,
below anything that reads in order), and still has to win the distance ranking
like every other candidate.

The repair follows from the match: the run covers BOTH copies, so
`applyLineReplacement` writes the new text into the leftmost and blanks the
other — one edit turns the doubled line back into a single clean one, and an
empty replacement removes it outright.

### A run is anchored on its first block — so a blank block must not lead it
`dist` is measured from `blocks[0]`, and bucketed distance is the PRIMARY sort
key over every candidate. A block with no visible glyph adds nothing to the text
that matched, but it drags that anchor with it — and one cell's trailing space
sits, in stream order, immediately before the run that starts in the NEXT cell.

Word draws every word as its own BT, so `Telf. Fijo/Móvil: | Correo
Electrónico:` is eight blocks sharing one Tm y. The run matching "Correo
Electrónico:" **exactly** was found starting at the space that ends
"Fijo/Móvil:", 82pt to the left, so it ranked below a single-block match on
"Electrónico:" alone — which sits on the click and carries two thirds of the
target:

    single score=0.63 dist=0.0  ["Electrónico:"]          <- won
    line   score=2.00 dist=81.6 [" " + "Correo" + " " + "Electrónico:"]

The partial match won, the whole new text went into the "Electrónico:" block,
and the "Correo" block went on drawing beside it: the cell rendered the label
twice, overlapping, in two different faces. `trimBlankEnds()` drops
non-contributing blocks from both ends of a matched run before it is scored.
Nothing else about the edit changes — `applyLineReplacement` neither writes into
nor blanks a block with no visible glyph — only where the run is measured from.
It never trims to empty: a run of nothing but spaces is a legitimate target (an
empty form field being filled in).

This is the same failure family as the note below, one level up: there a
fragment outranked the covering run on SCORE, here it outranked it on DISTANCE.

### A partial run must not outrank the line group that covers it
A form draws "Código de Postulante" and its value "70492487" as two runs that
extraction reports as ONE line. The label alone fuzzy-matches the whole line, and
it scored a flat 1 while the line group covering both scored its similarity
ratio (~0.97) — so the label won, was rewritten, and the value was left stranded
beside the new text while the edit reported success. Single-block candidates are
now scored by `matchRatio`, i.e. by how much of the target they actually carry.

### Reflow is OFF by default — and OFF, a drag moves only what was dragged
`editorStore.reflowOnEdit` gates the line-count reflow, the page spill, the
image room-making, the resize room-making AND the move collision.

The toggle is off by default because most documents people edit are not flowing
prose. On a form or a table — labels and values drawn at fixed coordinates in
columns — "push everything below down" tears labels away from their values: on a
real inscription form one Enter turned 55 blocks into 68 and left "Teléfono 2"
printed over "Teléfono". With the toggle off an edit changes only what was
edited (measured: 55 → 56 blocks, 2 moved).

The move collision was for a while exempt from the toggle, on the argument
that dropping a paragraph onto another leaves the two unreadable and the
user plainly meant to put it there. That decision has been reversed by the
same shape of evidence that set the default: on a Word pivot table whose
rows sit 15pt apart, nudging the "0" in the first row a few points
overlapped the row beneath, that row was pushed, it overlapped the next, and
the cascade ran through all twelve rows to the foot of the page while every
rule and coloured fill stayed put — "when I move it, it makes a disorder in
its neighbourhood; in Adobe it works". Acrobat moves the block and nothing
else. An overlap is visible and one Ctrl+Z (or one more drag) from fixed; a
table torn off its borders is not. The collision plan is still built so the
status line can say how many lines the drop landed on and that Reflow would
push them aside; ON, the old behaviour stands for prose.

### Paging keys, and finding the element that actually scrolls
Up and Down scroll the page they are on first and turn the page only once there
is nowhere left to scroll — what every PDF reader does, and necessary because on
a document zoomed past the height of the window, turning on the first press
skips most of what is being read. PageUp/PageDown and the horizontal arrows
always turn; Home and End go to the ends.

Which element is scrolling has to be FOUND, not named. `.pdf-viewer-container`
declares `overflow: auto`, but the Quasar layout above it lets the window scroll
instead, so the container's `scrollHeight` equals its `clientHeight` and it
always reports that there is nowhere to go — measured on a page with 1712px of
scroll left in it. `pageScroller()` walks up from the canvas to the first
ancestor that both allows overflow and has room in it, and falls back to
`document.scrollingElement`.

### The page you are on has to be visible in the page list
`PageThumbnails` scrolls the active thumbnail into view whenever the current
page changes. Without it the panel never moves: on a document of any length the
highlighted thumbnail is below the fold, and the only way to see where you are
is to scroll the list by hand every time — which is what the panel exists to
save you. It does nothing when the thumbnail is already visible, because
scrolling the list under someone who is browsing it is its own annoyance.

### Merging another PDF grafts, it does not append
`mergePages` uses MuPDF's `graftPage(to, srcDoc, srcPage)`, which copies the
page together with the objects it depends on — fonts, images, colour spaces —
into this document's object graph. Appending the raw bytes, or copying the page
dictionary alone, produces a page whose resources point at objects that do not
exist here: a blank sheet, or a viewer error.

Each grafted page keeps its OWN size, so merging an A4 form into a Letter
document leaves both correct instead of cropping one to the other (measured:
612x792 and 596x842 side by side in the saved file).

Pages land after the one being viewed, and the thumbnail panel's existing
drag-to-reorder (`movePage`) is what organises them afterwards.

### An annotation is ALWAYS above page content
The patch that hides replaced text on a scan was drawn with `addShape('Square')`,
i.e. as an annotation, and the replacement text with `addText`, i.e. into the
content stream. Annotations are painted after all page content whatever order
they were created in, so the patch covered the very text it existed to sit
behind: "TITULO EDITADO" exported as "TADO", with the first half hidden under
its own white box.

`fillRect` writes the rectangle into the CONTENT STREAM instead (`re f` wrapped
in `q`/`Q`, y flipped from the UI's top-left space), so the two are in the same
paint order and appending the text after the patch puts it on top. It also keeps
the export free of annotations, which matters when the file is printed or
flattened elsewhere.

Ordering the two calls differently cannot fix this. Nothing drawn into a content
stream can ever be above an annotation.

### A recognised LINE is not a unit of text
Tesseract groups by visual row, so five column headings printed side by side
come back as one line. Editing that rewrote all five: the user changed one
heading and the whole row was redrawn as a single run, in one font, on one
baseline. `splitRuns` cuts a line back into the pieces it is really made of,
judging each gap between words three ways:

- **wider than 2.5 em** — unmistakable on its own, no word space is that wide;
- **wider than an em AND several times this line's median gap** — the relative
  test, which protects letter-spaced text from being shredded into words;
- **every gap on the line is wider than 1.2 em** — then the line contains no
  word space at all, so every gap separates two pieces of text.

The first version required the absolute AND the relative test together, which
fails on precisely the case it exists for: when every gap is a column gap, they
ARE the median, the relative threshold climbs above all of them and the row
stays whole. The relative test can only ever ADD splits.

The third rule is what catches a row of ONE-word headings, where no single gap
is wide enough to be obvious. Prose can never trigger it — a line of prose
always contains a real word space, and a word space is about a third of an em.

A run split out of a line takes `align: 'left'`: it IS its own box now, so there
is nothing left for it to be aligned within.

### What a typeface can be read from ink, and what cannot
`ocrFontDetect` measures the face from the pixels, because the LSTM engine
reports no font attributes at all and the `font_name` it occasionally carries
names a face that is not in the document and could not be embedded anyway.
Every threshold comes from `tools/ocr-calibrate`, which renders the base-14
faces at 12pt and 24pt at OCR resolution and prints the cues.

Measurable, with clean separation:
- **Weight** — median horizontal ink run over the em. Regular 0.055–0.095, bold
  0.136–0.150 across Helvetica, Times and Courier at both sizes. Threshold 0.115.
- **Slant** — the shear that packs the column histogram tightest. Upright
  −0.02..0.00, oblique and italic 0.22..0.26. Threshold 0.10.

NOT measurable, and therefore not guessed:
- **Serif against sans.** Three cues were calibrated and all three fail: stroke
  contrast (Helvetica 1.60–1.70, Times 1.30–1.50 — a 0.1 gap, inverted from
  theory), the flare at the foot of a stem (1.00–1.33 for BOTH), and ink density
  on the baseline (Helvetica 1.11–1.39, Times 0.90–1.41 — total overlap). Sans
  is the default and OCR's `font_name` is consulted only when it says something.
  A coin flip that changes the typeface of a document is worse than a consistent
  default the user can change in one click.

Two cues that measure something real but must NOT decide:
- Slant by centroids — where the ink sits high against where it sits low reads
  which LETTERS are in the run, not how they lean: upright "Hamburgefonstiv"
  scored 0.165 that way, well into italic territory. Hence the shear search.
- Stroke contrast for monospace — it separates Courier cleanly on a clean render
  (2.50–3.25 against 1.30–1.70) and not at all on a scan, where blurred bold
  capitals read high because the crossbars fall inside the stem window. It set a
  row of Helvetica-Bold headings in Courier at half again their size. It is
  reported for inspection and nothing else.

Monospace is decided ONLY by `advancesAreUniform`, measured between glyph
CENTRES — a recognition box hugs the ink, and in a monospaced face a narrow
glyph sits centred in a wide cell, so left edges look irregular where the cells
are identical. It is undecidable, and returns `null`, unless the run holds both
a narrow glyph and a wide one: every face sets capitals at almost the same
width, so "PROCESS" reads as uniform in any of them.

### Point size depends on whether anything descends
The em is derived from the tallest glyph box, and how much of an em that box is
depends on the run. A line WITH descenders gives 0.95 (measured: a 12pt line at
220 DPI has a 36.7px em and a 35.1px tallest box). A line with none — a row of
capitals — gives its cap height instead, and dividing that by 0.95 came out a
fifth short: an 11pt row of headings read as 9pt, and the replacement was
visibly smaller than the untouched headings either side of it. `DESCENDERS`
picks 0.76 for those (measured: 11pt "DATA" and "DETAIL" gave 0.74 and 0.78).

J is deliberately left out of `DESCENDERS`: it descends in some faces and not
others, and guessing high here shrinks text, which is the failure being fixed.

The em comes from a TRIMMED maximum, not the plain one. A scan hands back the
odd swollen box — a smear joining two letters, a speck under a stem, an edge of
the row beneath — and the plain maximum believes it. One of those on a row of
11pt capitals reported 18.9pt, and the size was the smaller half of the damage:
`lineEm` is what `splitRuns` measures its column gaps against, so an em inflated
by 70% pushed the "unmistakable gap" threshold above three real column gaps and
three separate headings came back as ONE editable run — the very failure
`splitRuns` exists to prevent. The tallest box is dropped only when it stands
apart from the next (a quarter taller again), never more than twice, and never
on a run of fewer than four glyphs.

A percentile will NOT do this job, and trying p80 first proved it: in prose the
tall boxes are the minority — ascenders and descenders against a page of
x-height — so p80 lands in the x-height band and reads a 12pt line as 9pt. What
is wanted is not a lower rank, it is the outlier gone.

### Monospace is ONE grid, not a string of advances
`advancesAreUniform` used to score the pairwise gaps between glyph centres.
Pair by pair, every box's own error lands in two advances and nothing cancels:
on a 220 DPI scan real Courier scored 0.244 and Helvetica prose 0.284. No
threshold separates those, so monospaced text was never recognised — which is
what left a 12pt Courier line reading 8.3pt.

Fitted instead as one least-squares grid over the whole run, the same two score
**0.019 and 0.333**: a constant pitch is exactly what the fit is looking for, and
box noise averages out instead of accumulating. Italic prose scores 0.445 and a
page of OCR rubbish 0.4–0.8, so `MONO_GRID_RESIDUAL = 0.08` sits a factor of
four clear on both sides. Verified both ways: the Courier line now reads Courier
at 12.6pt, and a scan of 35 lines of Helvetica prose yields no Courier at all.

Spaces take a cell of their own — a monospaced face sets the blank to a letter's
width, so the grid only lines up when the gaps are counted, and counting them is
what lets one fit span a whole line instead of restarting at every word. The
NARROW/WIDE gate stays: all-caps text fits a grid in any face ("PROCESS" scores
0.04) and must never be decidable on advances alone.

A monospaced face has shorter ascenders again (Courier 0.63 em against
Helvetica 0.72), so `GLYPH_BOX_PER_EM_MONO` corrects for it — but only once the
face is known to be Courier, which needs `advancesAreUniform` to fire. It did
not, and the line came back as Helvetica at three quarters of its size: a real
12pt Courier line read 8.3pt. See the grid fit below for why, and what it reads
now (12.6pt, and 35 lines of Helvetica prose in the same test still read as
Helvetica).

### On a TAGGED page the words live outside the BT block too
In a tagged PDF every run sits inside `/Span <</MCID n …>> BDC … EMC`, and a
reader takes the text from the structure element that MCID points at, NOT from
the glyphs. Rewriting the glyphs therefore changes what is PRINTED and nothing
else. A SAP deck drew "TB1100 financial" while every extractor still read
"TB1100  Accounting" out of the tag — copy, search and a screen reader all
reporting a sentence the page no longer said. This engine's own extraction read
it too, so the block came back with its OLD text and a second edit had nothing
to match: *"I can't edit any more once I have edited."*

`retagSpanActualText` writes `/ActualText` onto the span, UTF-16BE. It is the
standard override and the least invasive fix available: the tag, its /MCID and
the structure tree are all left alone, so the document stays tagged and
accessible, and only what that one span claims to say is corrected. A blanked
span gets `/ActualText()` — it says nothing now.

Two limits, both learned from the corpus:
- **Only a span holding ONE BT block.** `/ActualText` speaks for everything
  inside its span, so putting one line's words on a span that also wraps the
  next two replaces all three with the one. The sweep caught it immediately: a
  span lost 103 characters to a shorter override.
- **Only the inline dictionary form.** A named property list (`/P1 BDC`) lives
  in the page's /Properties, and rewriting a shared resource would retag every
  other span pointing at it.

### Offsets below a rewrite are only valid if nothing below them moved
The clip window that bounds a block and the marked-content dictionary that tags
it both sit at LOWER offsets than the block, and are spliced afterwards off
offsets read from the ORIGINAL stream. That holds while nothing below them has
moved — and in a line group it does not: the primary block is rewritten in the
MIDDLE of the run, so every span after it shifts by the length it gained. The
first attempt spliced a widened clip rectangle straight through an `/ActualText`
and the page's title vanished from every extractor, with `unknown keyword: 'ng'`
as the only clue.

`applyLineReplacement` therefore returns its `applied` edits — where each rewrite
landed and how many bytes it moved — and both the clips and the tags are pushed
through `shiftOffset` before being applied, all of them together, highest offset
first.

### A patch belongs to the INK, not to the run
`OcrTextItem` carries two boxes. `rect` is where the run is now and follows a
drag; `inkRect` is where the scan's own words are and never moves. They were one
field, and the patch was drawn as a child of the run's box, so dragging a run
painted over the paper it had moved ONTO and left its photographed words
uncovered — the same sentence appeared twice, once in the scan and once as the
replacement, on screen and in the exported PDF. The patch is now its own element
in the layer, positioned from `inkRect`, and `patchRect` in `ocrExport` reads the
same field. Only the text follows the box.

`revertItem` puts `rect` back to `inkRect` for the same reason, and an explicit
`edited: false` in an `updateItem` patch now wins over the "was it edited before"
term — without that, reverting restored the words but left the run marked
changed, so export still painted over it.

A drag also refuses a non-finite delta. A page not yet measured gives a zero
scale, and writing the resulting `NaN` into the rect loses the run for good: it
then has no position to draw at, to patch out, or to drag back.

### The box OCR measured is the right PLACE to edit, not the right SIZE
A recognition box hugs the ink, so a short cell is a few pixels high: a run set
at 17px arrived in a 13px editor with its own text clipped top and bottom and
nowhere to put another word. The editor keeps its origin, type and colours — it
still reads as editing in place — but takes a minimum along the reading
direction and across it. The element's `width` is always the reading direction,
sideways runs included, so one pair of minimums covers both.

Editing also opens on the SECOND single click, not only on a double click.
Double-click still works, but requiring it means hitting a target a few pixels
high twice inside the system's double-click time, and that wait is felt as the
editor being slow to open. It is not: measured, it appears about ten
milliseconds after it is asked. A drag still moves the run, because the editor
only opens when the button came back up without the mouse having moved.

### Reading text that is set on its side
Tesseract reads a line left to right. A label printed up the side of a chart is
not a line to it: it comes back as nothing, or as a column of unrelated single
letters. The only way to read it is to turn the page — `addVerticalRuns` rotates
the raster a quarter turn clockwise, which stands bottom-to-top text up
horizontally, and recognises it again. `OcrTextItem.vertical` carries the result,
as its own flag rather than as `rotation: -90`, because the two mean different
things: rotation is a scan's few degrees of skew, and every consumer has to lay
a vertical run out differently rather than just tilting it.

Everything that pass finds is speculative, so three tests gate it. Two are
obvious — confidence, and being taller than it is wide once mapped back. The
third is the one that matters:

**The overlap test is CUMULATIVE, over every upright run at once.** Comparing
against one at a time let THIRTEEN false runs through on a page with one real
one: a tall narrow box laid over a paragraph crosses six lines and covers barely
a sixth of each, so no single comparison ever looks like a clash while the box
is plainly sitting on top of the paragraph. Summing the intersections double-
counts overlapping boxes, which can only make the answer larger — and the answer
is used to REJECT, so the error costs a doubtful run rather than admitting a
wrong one.

Only SUBSTANTIAL upright runs count towards it (4+ characters, 60%+ confidence).
The upright pass reads a sideways label as a column of single letters, and
letting those count would have the misreading of a label veto the correct
reading of it. Once a vertical run is accepted those misreadings are DROPPED —
they are the same ink read the wrong way round, and leaving them puts a dozen
meaningless boxes over the one box that says what the label is.

On export the rotation goes in the TEXT MATRIX (`0 1 -1 0 e f`), not anywhere
else, so vertical text is the same code path as horizontal with a different pair
of cosines. Turned a quarter turn anti-clockwise the glyphs' own "up" points
LEFT across the page, so the ascenders sit at the box's left edge, the baseline
runs down its right-hand side at 0.8 of the width, and the run starts at the
FOOT of the box because reading goes upwards. The patch's padding has to swap
axes with it, or a tall narrow run gets a wide band across the page with the old
ink still showing at the ends.

### Opening an editor must not move the page under the user
A selection is scrolled to its FOCUS end, and `range.selectNodeContents` puts
that end after the last character. Opening a line wider than the window
therefore threw the view to the right — the start of the line, which is where
anyone begins reading and editing, went off-screen, and the user was left
looking at its last word.

The line is still selected in full, so typing still replaces it. The selection
is just made BACKWARDS (`setBaseAndExtent(end, …, start, …)`), which puts the
focus on the first character. `focus({ preventScroll: true })` stops the focus
itself from scrolling, and `scrollAncestor()`'s position is restored afterwards
for anything that slips past both. The OCR editor does the same with
`setSelectionRange(0, len, 'backward')`.

Verified at 350% zoom on a 2005px-wide line: the viewer's `scrollLeft` stays at
0, the whole 111-character line is selected, and the selection focus is at
offset 0.

### An image can go in front of the text, behind it, or in the flow
`editorStore.imageWrap` picks one of three, and the third could not exist while
the picture was an annotation: annotations paint above ALL page content whatever
order they were created in, so a Stamp can only ever be in FRONT. That is the
same rule the OCR patch ran into.

- `inline` — a Stamp annotation, with the text pushed aside to make room. Word
  calls this "top and bottom". Selectable and resizable afterwards.
- `front` — a Stamp annotation and nothing moves. Selectable and resizable.
- `behind` — drawn into the CONTENT STREAM, prepended, so everything already on
  the page paints over it. The cost is that it is then part of the page: there
  is no annotation left to select or resize, and the status line says so rather
  than leaving the user hunting for handles. Ctrl+Z is how you change it.

Word's "square" and "tight" — text flowing around the SIDES of a picture — are
deliberately absent. A content stream has no flow: every line is drawn at an
absolute position, so wrapping text around a shape means re-breaking and
re-justifying every affected paragraph, which cannot be done to a table or a
form without destroying it.

`drawImageInContent` picks an XObject name nothing else on the page is using.
Reusing one would silently replace whatever it pointed at — a logo, or the scan
behind an OCR page.

Only an in-flow image asks the text to move. Over or under it the picture is
MEANT to overlap what is there, so making room would defeat the mode.

**`setTool` writes its own status line**, so any message about what an insertion
did has to be set AFTER it. Every account of what the image did to the page was
being replaced by "Tool: select" before the user could read it.

### Why a LaTeX PDF could not be edited
pdfTeX output has two traits that no other generator combines, and each on its
own was enough to make every such document read as uneditable.

**Its spaces are not characters.** TeX sets inter-word space as a KERN inside a
TJ array — `[(This)-333(is)]TJ` — so the engine's own decode of the stream came
back "Thisis…" while MuPDF's extraction, which turns wide gaps into spaces,
reported "This is…". The two disagreed and nothing could be matched against
anything. `decodeBtBlockText` now consumes TJ arrays WHOLE, ahead of the
bare-literal alternatives, and emits a space for any kern past `KERN_SPACE`
(180 thousandths of an em — ordinary kerning pairs are well under a tenth of an
em, so the threshold sits between the two rather than near either).

**Its fonts name their glyphs.** LaTeX ships an /Encoding dictionary with a
/Differences array that remaps the low codes: byte 12 is the "fi" ligature, not
a form feed, and the Greek capitals sit where control characters would be. Three
things had to change for that to be read at all:

- `/StandardEncoding` was not accepted as a /BaseEncoding, only MacRoman and
  WinAnsi, so the font stayed 'Unknown' and its bytes were passed through raw;
- /Differences was never parsed. It is now, into `SimpleFontInfo.differences`,
  and `mapPlainBytes` consults it FIRST — overriding the base table code by code
  is the entire point of it;
- a named encoding now survives the symbolic flag. LaTeX marks its fonts
  symbolic and still names every glyph it draws, and the flag was demoting them
  back to 'Unknown'.

`glyphNames.ts` maps those names to Unicode. It is not the full Adobe Glyph
List — it covers Latin text plus the ligatures, accents and Greek capitals that
make LaTeX different, and handles `uniXXXX`/`uXXXX` by rule. OT1 puts
`/suppress` where a space would be; it draws nothing and a gap is what it means,
so it reads back as a space rather than as an unknown glyph.

Measured on a page built to pdfTeX's shape: all four blocks edit, including the
line carrying an "fi" ligature that used to fail outright with "Could not find
matching text in content stream". Plain and clipped documents were re-checked
for regressions, since the kern rule changes how EVERY stream decodes.

### The whole document scrolls; the tools follow the page you are on
`docStore.continuousScroll` (on by default) renders every page as its own canvas
in one column. Having to click the next thumbnail to see what comes after the
line you are reading is not how anyone reads a PDF.

**The editing layers still live on ONE page** — the current one. They are
written against "the current page" throughout, the overlay alone being some 1800
lines of it, and giving every page its own set would mean N text extractions, N
annotation loads and N sets of selection state for no gain: a person edits one
page at a time. What changed is that the current page now follows the SCROLL, so
the tools appear on the page being looked at without the reader having to select
it. Clicking a page also claims it, for the moment before the scroll detector
catches up.

Three things this has to get right:

- **Rendering is sequential.** `renderPage` supersedes any render already
  running — it must, or a stale page paints over the latest — so firing one per
  page paints only the last. Pages are queued, current page first, and drawn one
  at a time, one screen either side of the viewport.
- **Sizes are guessed, then corrected.** A page that has not been painted still
  has to occupy the right amount of the scroll bar. Measuring every page up
  front is one `getPage` per page before anything appears; page 1 is measured
  and stands in for the rest, and each page corrects its own entry as it is
  painted, so a merged A4-into-Letter document settles as the reader reaches it.
- **The two directions must not fight.** A page reached by scrolling is already
  where it should be; one chosen from the thumbnails or the keyboard has to be
  scrolled to. `syncingFromScroll` and `scrollingToPage` keep each from
  re-triggering the other — without them the view snaps back the moment it moves.

Single-page mode is kept because it renders exactly one page: on a very long
document that is the difference between paging instantly and waiting for a
rasteriser.

### A `ref="name"` inside a `v-for` is an ARRAY
Even when the loop renders exactly one of them. Moving the editing layers inside
the per-page loop for continuous scrolling turned `textBlockOverlayRef` into a
one-element array, so `makeRoomInText` called `makeRoomAt` on an array and threw
— and because it threw inside an ASYNC EVENT HANDLER, the rejection had no
owner: inserting an image did nothing at all, with no error, no status line and
nothing in the console. The overlays are addressed by function refs
(`setTextOverlay`, `setAnnotLayer`) for that reason.

The silence is the part worth remembering. `onImagePicked` now wraps its work
and reports whatever goes wrong, because a feature that fails without saying so
is indistinguishable from one that was never wired up — and that is exactly how
it was reported: "I insert an image and nothing shows".

### The layout control belongs ON the picture
How an image sits with the text is a property OF THAT IMAGE, so the control is a
button beside it, the way Word does it — not a toggle in the toolbar, where it
applies to the NEXT insertion rather than to the thing being looked at. The
toolbar keeps only what genuinely concerns the next one: where to place it and
how wide.

Switching an existing picture to "behind" is `flattenAnnotationBehind`. It
cannot be done by reordering anything, because an annotation is painted above
all page content whatever order it was made in — the only way under the text is
to stop being an annotation. The annotation's own /AP /N appearance stream is
invoked with `Do` rather than the original image being hunted down and
re-embedded: the form already draws the thing correctly inside its own BBox, so
what lands is exactly what was on screen, and it works for any annotation.

The matrix is the one PDF 32000-1 12.5.5 specifies: transform the BBox by the
form's /Matrix, then map that box onto the annotation's /Rect. Getting it wrong
does not fail loudly; it puts the picture somewhere else at the wrong size.
Verified by pixel count — 6618 before and after the switch, and 6464 in the
exported file at a different rasterisation.

**`isStream()` must be asked of the INDIRECT reference.** Asked of the resolved
object MuPDF answers false, so every appearance stream was reported as "more
than one appearance" and nothing could be moved. This is the same quirk already
recorded for ToUnicode streams, met in a second place.

### The document scrolls inside the page, not by growing the window
The obvious way to make a continuous document is to let the WINDOW scroll, and
it breaks the shell around it: the left drawer sizes itself to the layout, so on
a forty-page document it became forty pages TALL — its thumbnails scrolled away
with the paper and the panel could no longer show where you were. `q-page` is
bounded with a `style-fn` and the viewer scrolls inside it.

Two things follow from that:

- **`flex: 0 0 auto` on the page wrappers.** A flex item shrinks to fit by
  default, and the container is now a bounded height, so forty pages were
  squeezed between them into one screen's worth. The height on each wrapper is
  the page's real size and has to be kept.
- **Measure against the VIEWER's box, not the window's.** It sits under a header
  and over a footer, so the middle of "the screen" is a good sixty pixels off —
  enough to hand the current page to the wrong one when two meet near the centre.

### Paint what can be seen, and only repaint what changed
Three pieces of work that scaled with the length of the document rather than
with what was on screen:

- **Thumbnails were all redrawn on every edit.** Forty rasterisations per
  keystroke-level edit, all but two of them for pictures nobody was looking at,
  and the byte array COPIED for the parse each time. Now an edit only
  invalidates; what is visible is redrawn at once and the rest as they are
  scrolled to. Measured: 9 of 40 drawn on load instead of 40.
- **Every painted page was repainted after every edit.** An edit rewrites ONE
  page's content stream; the other pages' pixels are still correct.
  `repaintAround` does the edited page and its neighbours — neighbours because
  text pushed off the foot of a page is redrawn on the next one.
- **The scroll handler measured every page, every frame.** It now measures the
  current page's neighbourhood, so the per-frame cost stops depending on the
  length of the document.

That last one needs an escape hatch. The neighbourhood is centred on the current
page and the current page is decided by what is on screen, so after a JUMP —
dragging the scrollbar — each waits for the other and the panel sticks on page 1
however far you scroll. When nothing nearby is on screen, one full scan
re-anchors it; a jump is not something that happens every frame.

### An overlay that can be REMOUNTED must load on mount
`TextBlockOverlay` and `AnnotationLayer` fetched their data only from watchers —
tool changed, page changed, document loaded, renderVersion bumped. That was
sufficient while each was created once and lived for the session.

Continuous scrolling moves them. They are destroyed on the page being left and
built again on the page arrived at, and a fresh instance has missed every change
that ever happened: no watcher fires, nothing loads. The editing layer was empty
on every page except the one that happened to be current when the tool was
picked — the text was on the paper, the thumbnails showed it, printing showed
it, and it simply could not be touched. That is the "the text disappears on the
editing sheet" report.

Both now load in `onMounted`. The rule generalises: a component whose data is
fetched by a watcher is making an assumption about its own lifetime, and any
change that moves it inside a `v-if` or a `v-for` breaks that assumption
silently. `OcrTextLayer` and `SearchHighlights` are safe because they read their
state from stores through computeds, which do not care when they were created.

### The queue serialises steps; a TRANSACTION holds a sequence
Inserting an image is not one queued operation but three or four: make room in
the text, the save-and-reload that follows, then stamp the picture. The queue
keeps each of those from interleaving with anything else and does nothing about
the GAPS between them — and an undo landing in a gap replaces the whole document
underneath an operation that is still running. On a page-filling image over a
dense document, where making room takes half a minute, that is an easy thing to
do: it left page 1 blank and the file at a third of its bytes.

`beginTransaction()` in `opQueue` is held across the whole sequence and released
in a `finally`. It does not block the queue — the operation's own steps still go
through it — it only lets anything that would REPLACE the document wait. Undo
and redo call `settleTransactions()` first and say "waiting for the current
operation to finish" if they have to, because a Ctrl+Z that appears to do
nothing is its own kind of wrong.

Measured: four undo presses spread across a 17-second insertion, and the
document comes back byte-identical (16176) with both pages intact. Before, one
was enough to blank a page and lose 10,000 bytes.

### Deleting many blocks: one extraction, back to front
A block id is its index in the page's extraction, so emptying one either leaves
it there or removes it and shifts every LATER index down. Deleting from the LAST
block to the FIRST therefore keeps every id still to be used valid — they are
all lower than the one just removed — and one extraction serves the whole set.

Re-extracting before each delete cost 112ms a time on a full page (measured
against 326ms for a complete edit including the save and reload), and a
page-filling image spills thirty lines that all have to be cleared. Making room
for one went from 37 seconds to 17.

Long runs now report progress. A minute of silence is indistinguishable from a
hang, and the user's response to a hang is Ctrl+Z — which was the very thing
corrupting the document.

### Render OFF-SCREEN, then copy — never clear a canvas you cannot refill
Painting straight onto the visible canvas means clearing it first: setting
`width` is what resizes it, and that wipes it. From that moment until the render
finishes the page on screen is blank, and a render that never finishes leaves it
blank for good — cancelled by the next one, or thrown out because the document
was reloaded under it. The page then shows white while the thumbnails, which
read the bytes independently, show the document perfectly well.

`renderPage` draws into a detached canvas and copies the result over only once
the render has completed. A failed render now costs nothing: the visible canvas
still holds the last good picture of that page, which for an untouched page is
still correct and for an edited one is at worst one revision stale. The cost is
one full-page bitmap copy per render.

Two things go with it:

- **A render that returns nothing is retried**, up to `MAX_RENDER_ATTEMPTS`, at
  the back of the queue. Superseded and reloaded-under are both ordinary events
  during editing and neither means the page cannot be drawn; dropping it left a
  page unpainted with nothing scheduled to try again.
- **`repaintAround` is awaited**, so the queue slot it runs in is held until the
  page is actually on screen. Returning early let the next operation reload the
  document while the render was still going, which cancelled it.

Verified under a storm of twelve overlapping repaints with scale changes every
90ms — shorter than a single render — with no page left blank and no stale
scale afterwards.

### An inserted image is fitted to the paper
The width comes from a percentage the user sets; the HEIGHT follows from the
picture's own shape, and nothing was checking it against the page. A portrait
photograph — a phone snap of a document, which is the common case — is two or
three times taller than it is wide, so 60% of the text column came out taller
than the sheet: measured at 1375 points on a page of 1188, running 462 past the
bottom edge, where it cannot be seen, printed, or dragged back.

`insertImage` now scales the picture down, aspect intact, when it is taller than
the page allows, and slides it back onto the page when the point it was asked
for would hang it over an edge. Moving beats shrinking where both would work:
the size chosen is respected wherever there is room for it on the sheet. Either
adjustment is reported, because a picture that is not the size you asked for
without explanation reads as a bug.

An image that already fits is not touched — verified alongside, since a fit rule
that quietly rescales everything would be its own defect.

### Spilled text is pushed clear of what arrives, not merely by its height
`spillChain` draws the arriving lines from `SPILL_TOP_MARGIN` downwards, so they
end at `SPILL_TOP_MARGIN + arriving`. The page's own text was then pushed down by
`arriving` alone — which leaves text that began at the top of the page ending up
at `itsTop + arriving`, a whole top margin short of clear. The two sets printed
through each other for exactly that many points: "when it has to go to another
page the letters all mix together".

The shift is now whatever it takes to put the FIRST existing row below the
arriving block plus `SPILL_GAP`, measured from where that row actually starts,
and zero when the page already begins low enough to have room. The same figure
decides which rows will not survive the push, or the partition is made against a
distance that is not the one applied.

### `makeRoomAt` takes a SIGNED amount
Positive opens a gap, negative gives one back. Only opening existed, so an image
made smaller left the space it no longer needed sitting empty, and one dragged
elsewhere left its old gap behind AND landed on whatever was at the new place —
"once I shrink the image or move it, the text no longer adjusts". Closing a gap
can never run text off the paper, so it has no bottom limit and never spills.

`commitRectChange` in the annotation layer is the single path for both a move
and a resize. A change of height IN PLACE is one operation for the difference,
which is cheaper and steadier than closing the old gap and opening a new one —
every reflow is a chance to match the wrong paragraph, so the fewer the better.
A move has to be the two, in that order: the rows must be where they belong
before the second plan is built against them.

### The rules move with the text, and a clip never does
Reflow used to move text and nothing else, which is fine until the page has a
table: every cell's words slid down and the box around them did not, so a
document that needed one longer sentence came back with its header printed
across its own borders and its data row outside the frame. Acrobat does not move
them either — it declines to reflow at all. `shiftGraphicsBelow` in the worker
moves them, and `applyReflow` calls it with the top of the highest row that
moved and the distance every row travelled.

Three rules keep it from doing harm, and each of them was a failure first:

- **A path moves whole or not at all.** Points are collected until the path is
  painted and the shift applied only if EVERY one is below the line the text
  grew at. Judging points one at a time shears a vertical rule that straddles
  it, and a sheared table is worse than an unmoved one. What is left behind is
  counted and said in the status bar.
- **A CLIP is never moved.** One corpus file builds 477 `re W* n` boxes around
  its paragraphs; sliding those down clipped three quarters of the words off the
  page — silently, because the text objects were untouched and still there.
  Extracted text fell from 1915 characters to 532. The text mover already widens
  the clip around anything IT moves (`expandClipForTransform`), so the window is
  looked after, just not from here.
- **Only under an upright CTM**, and never inside BT/ET or an inline image. A
  rotated transform has no single "down", and an inline image's bytes are not
  operators however much a run of them may look like one.

Only when every row moves by the SAME distance, which is what a push down or a
pull up produces. A plan with mixed shifts has no single distance for the rules
BETWEEN those rows to travel.

### A line of a many-line block is reachable by position, not by length alone
`findBtBlocksByPosition` asks whether a block's WHOLE text reads as the target,
so a single line of a block that draws several was only reachable through the
containment test — which demanded more than five characters on both sides. Table
cells are mostly shorter: `N°`, `GTIN`, `Bien`, `1`, `NO`. They matched nothing,
and a move that cannot find its text does not fail loudly; it just does not
happen. That is how a reflowed table came apart with its long cells moved and
its short ones left behind on the rules.

The last-resort pass admits them at two characters because the text is not
carrying the identification alone: the block has to SIT on the target
(`distOf <= onTarget * 2`) and `findGoverningTm` has to find a run inside it
that reads as the target. It runs only when every other pass came up empty, so
no match that already worked can change.

### A line group is read BOTH ways round
The target text is in reading order; a content stream is under no obligation to
be. One producer emits a field's value before its label, so the group read back
as `NO` + `Indicador de retorno de vehículo vacío:` and matched nothing at all.
Only the label's own block matched, so a reflow moved the label down the page
and left the `NO` behind on the old line, beside somebody else's answer.

Sorting by `xPos` fixes that — but sorting INSTEAD OF the stream order is not
safe: the sweep caught one corpus file where stream order was the one that
matched, and x order alone turned a working drag into "could not find matching
text". Both joins are tried. Trying both can only ever add a match, which is why
the sweep then showed 192 unchanged results, one gained and none lost.

**The sweep's `results.json` is gitignored and does NOT track the branch.** It
was a snapshot from `421ac5d` while `main` had moved seventeen commits past it,
so diffing against it reported three regressions that were already there. Always
regenerate the baseline from a clean tree (`git stash`) before blaming a change
for anything it shows.

### Making room for a picture already in place is a different sum
Inserting one opens a gap at the foot of a line and drops the picture INTO it,
so the picture's own height is exactly the room wanted. `applyWrap('inline')`
and a move/resize face the opposite case: the picture is fixed and the first
line that has to move starts wherever it starts, usually some way above the
picture's top edge. Pushing it down by the height alone left it printed across
the bottom of the image, half a line inside the ink. `pushTextClearOf` probes
for the top of the first row that would move and asks for
`bottom + IMAGE_GAP - thatTop` instead.

Related: `makeRoomAt` resolves its anchor row differently per direction. Space
opened BELOW a point belongs to the line above it; space opened ABOVE a point
belongs to the line below. Both used to resolve to the line above, so an image
dropped into the gap between two lines pushed the line ABOVE it down onto the
picture while the lines actually in the way never moved.

### `annot.getRect()` is not PDF user space
MuPDF answers it in its own page space, which counts DOWN from the top, while a
`cm` written into a content stream counts UP from the bottom.
`flattenAnnotationBehind` used it raw, so "Behind the text" put the picture at
`pageHeight - top`: on a Letter page an image sitting under the first line of
text landed 390 points lower, at the foot of the sheet. Read the annotation's
own `/Rect` instead — it is already in the space `Do` is invoked in, so no page
height and no `/Rotate` guesswork is needed. `drawImageInContent` converts
explicitly (`y = pageHeight - top - h`) and is the model for anything else that
has to cross between the two.

### Editing a page means text AND pictures, in one tool
Acrobat's "Editar PDF" is a single mode: a click on a line edits the line, a
click on a picture picks the picture up. Here the annotation layer — which owns
both the annotations and the images the CONTENT draws — rendered only for the
`select` tool, so in the tool people actually work in every image on the page
was inert. `objectsSelectable` covers `select` and `edit` alike, and the resize
handles, the delete button, the band sweep and the Del key follow it.

Two selections are now live at once, so whichever layer takes the click clears
the other's (`objectPicked` / `blocksPicked`, forwarded through `PDFViewer` the
same way the rubber band already was). Otherwise the page wears two sets of
handles and Delete has two answers to what it is about to remove.

**The smaller target takes the click.** A Word export draws its table borders
and cell backgrounds as IMAGES: on the reported document 25 of a page's 34 text
blocks sit inside one, and the image hit-targets sat at z-index 15 over text
blocks at 1 — so most of the page's text could not be clicked at all in `select`
mode, and turning the layer on in `edit` would have taken the rest with it.
Measured, on `main`: `elementFromPoint` over the paragraph "Se observa ambas
partes del equipo…" returned `cimg-hit`. Content images are now z-index 3 under
text at 4 (annotations stay above both — one stamped over a scan must still win
its own click), and `scaledContentImgs` sorts BIGGEST FIRST so that among the
images themselves the frame never covers the photograph inside it.

### A digitally signed signature is a WIDGET, and widgets are not annotations
MuPDF's `getAnnotations()` deliberately excludes `/Widget` annotations — form
fields — and a signing service (Intellisign) stamps each signature image
through exactly that: a `/FT /Sig` widget whose appearance form draws the
scribble. On a signed memo the three signatures therefore existed in no list
this editor kept: not content images (no `Do` in any content source), not
annotations (`getAnnotations()` answers 0 on a page whose `/Annots` holds
three), so they had no hit target and could not be selected, moved, resized or
deleted — while the page's logo, an ordinary content-stream image, dragged
fine. Reported as "I can move the logo but not the signatures".

`getAnnotsAndWidgets()` is the one list everybody uses — the listing AND every
index resolver (update, delete, rotate, flatten, move-to-page), since the UI
addresses annotations by list position and the two sides must agree. Widgets
append AFTER the plain annotations so no index that worked before changes, and
hidden/no-view widgets are filtered on both sides for the same reason. Three
things widgets need done differently:

- **Never call `annot.update()` on one.** MuPDF regenerating a form field's
  appearance replaces the signing service's image with MuPDF's own idea of the
  field. The viewer maps the appearance BBox onto `/Rect` (PDF 32000 12.5.5),
  so `setRect` alone IS a complete move or resize.
- **`/Annots` position must be SEARCHED, not indexed.** The combined list puts
  widgets last; `/Annots` interleaves them in producer order. `moveAnnotationToPage`
  finds its entry by `/Rect` + `/Subtype` and picks the arrival from the right
  sub-list (`getWidgets()` vs `getAnnotations()`, each in `/Annots` order).
- The widgets' `/F` is 132 — Print + **Locked**. Locked is advisory
  (viewer-level), and honouring it would defeat the point of an editor whose
  whole purpose is editing signed documents; edits break the cryptographic
  signature anyway, exactly as text edits already do.

Verified engine-level (rect moved, AP stream byte-identical, ink pixels moved
by exactly the delta) and in the browser (drag commits, undo restores).

### The overlays learn of a reload from ONE bump — so it must come LAST
Undo was `pdfViewer.reloadDocument(snapshot)` then `pdfEngine.loadDocument(snapshot)`.
The viewer reload bumps `renderVersion` (via `reloadBytes`), and that bump is
the only signal the overlay watchers get — undo has no explicit re-fetch the
way `annotOp` has. Every overlay therefore fetched from a worker still holding
the PRE-undo document and kept the stale answer forever: after undoing a
signature move the canvas showed it back in place while its hit target stayed
where the undone move had put it, one whole operation behind, permanently.
Engine first, viewer second — the bump then describes a document both engines
agree on. Same fix in redo.

Opening a file has the same shape with a different guard: the bump inside
`pdfViewer.loadDocument` fires while `pdfEngine.docLoaded` is still false, the
overlays' fetch guard answers "no document", and nothing ever asks again — a
freshly opened file had no clickable objects until the tool was toggled. There
the order cannot swap (the viewer load is what validates the file), so
`loadBytes` bumps AGAIN once the engine is ready.

### An image drags out of its own clip
`transformContentImage` splices a widened `re` for every clip in force at the
`Do`, exactly as `transformTextBlock` does for text. A picture in a table cell
is bounded by that cell, barely bigger than the picture: dragging it 120pt right
came back with two thirds of it cut off — in the file, drawn, and invisible.
Splices go on back-to-front, since a clip sits at a LOWER offset than the `Do`
it bounds.

`deleteContentImage` BLANKS the `/Name Do` with spaces rather than cutting it
out. Every other image on the page was listed against offsets into the same
stream, so shortening it would move all of them and a multi-image delete would
address the wrong `Do` from the second one on. The XObject stays in
/Resources — the same image is often drawn several times, and an unreferenced
one costs bytes, not correctness.

### A glyph the font cannot NAME is shown, never retyped
The signed order's CFF subsets map CJK glyphs to Latin junk (`<0005>` →
"i:l", `<003E>` → "El", `<0004>` → "f"), and CFF carries no Unicode of its own,
so the real characters are unrecoverable and the editor showed "Fecha de inicio
fHi :lEl M:" for 开始日期. Matching MUST go on comparing that junk against the
stream's decode of the same junk (see "The decode must agree with EXTRACTION"),
so `TextBlock.text` is untouched. What changed is that the glyphs are FLAGGED
(`TextChar.unreadable`, set by `markUnreadableGlyphs` in `extractPageText`) and
the inline editor shows each flagged run as a `glyph-chip`: a crop of the
rendered canvas, `contenteditable=false`, whose `data-text` is the junk the
engine expects. `readEditor` emits that junk, so an unchanged chip is a no-op
and a deleted chip deletes its glyphs.

Two tells, and a rule that catches what the tells cannot:
- **A multi-char destination shows up as zero-width continuation chars.**
  MuPDF gives the first character the glyph's advance and every further one a
  zero-width quad at its right edge (`"i"(adv) ":"(0) "l"(0)`). A ligature does
  the same, so `LIGATURE_TEXT` is checked first. U+FFFD is the other tell.
- **A single-letter lie is indistinguishable on its own** — `<0004>` → "f" is a
  perfectly good "f". It is caught at FONT level: a font already caught lying
  whose ToUnicode has ≤ `TINY_SUBSET_CODES` printable codes is a CJK subset in
  disguise and everything it draws is flagged. `*Verdana-14399` (170 codes, one
  "El") keeps per-glyph flagging, which is what leaves the date it also draws
  editable. Fonts inside Form XObjects are not looked up — a miss, never a
  false positive.

Chips are DOM-built, so the overlay's scoped stylesheet needs `:deep()` to
reach them; without it the span stays inline, ignores its size and shows
nothing. The crop is a band around the baseline (0.95em up, 0.25em down), not
the quad — this producer's quads are three times the em and a chip that tall
made a one-line editor two lines high.

### The inline editor opens where you clicked, on the page's baseline, in the page's face
Acrobat places a caret; the editor used to select the whole line. `openInlineEditor`
takes the click and `placeCaret` finds the offset on the block's own glyph
quads (`charOffsetAt`) — exact, where asking the browser where the click fell
in the editor is only as good as the editor's face. `cssFontStack` puts the
PDF's own family first (`*Microsoft Sans Serif-Bold-1440` → "Microsoft Sans
Serif"), so on a machine that has it the editor lines up with the glyphs.

Vertical placement is MEASURED, not derived: a zero-size inline-block sits
exactly on the baseline, so its bottom is the editor's baseline in client
pixels, and `alignToBaseline` nudges the box until that meets the block's
`chars[0].origin[1]`. Guessing the ascent was off by a few pixels for every
face and by more once a chip raised the line box; anchoring on the bbox TOP put
the text a whole line above the glyphs on this producer, with the original
showing through underneath.

**A blur caused by the editor leaving the document is not a commit.** Chrome
fires blur on a focused element that is removed, and this overlay is removed
whenever its page stops being current — scrolling on mid-edit, or a hot
reload. The ref is null or detached by then, the read came back empty, and the
empty commit DELETED the line (measured: "Text replaced in block 0:26" right
after a hot update, and the line gone). `onBlur` now cancels when the element
is not connected.

### A scanned page recognises itself on the first click
In the edit tool, a page with no text blocks asks `ocrController.isScanLike`
(no text AND an image covering half the paper — a blank page is not a scan and
recognising it wastes five seconds; verdicts are cached in `ocrStore.scanVerdicts`).
The status says so, and a click on the paper emits `scanClicked`; `PDFViewer`
recognises the page and hands the point to `OcrTextLayer.editAt`, which opens
the run under it with the caret at the click's share of the run. Three things
had to give way:
- **The scan's own image took the click.** The page-filling image is a content
  image with a hit target at z 3, above the overlay's marquee surface at z 0.
  On a scan page, in the edit tool, an image covering half the paper is marked
  `paper` and made transparent to the pointer; in the select tool it is still
  an object.
- **OCR read page 1 whatever page was current.** `runOcrNow` grabbed
  `document.querySelector('canvas.pdf-canvas')` — the FIRST canvas in the
  document. It now renders the page itself at 220 DPI through
  `renderPageToCanvas`, with its own task so it neither cancels nor is
  cancelled by the visible pages.
- **`useOCR()` built fresh state per caller**, so the toolbar's spinner watched
  a `busy` the layout never set. It is a singleton now, and the status bar
  shows the recogniser's own progress.
`editorStore.ocrMode` is keyed on the CURRENT page having results, not on the
layer being visible — the OCR row used to hijack the properties bar on every
page of the document once any page had been recognised.

Default language is `spa+chi_sim` (`OCR_DEFAULT_LANG`); Tesseract's Chinese
model puts a word space between adjacent characters, which `buildItems` closes
up. A page of both takes ~45 s including the sideways pass.

### OCR on a ruled form: sparse segmentation, borders are not glyphs, a tiled scan is still a scan
A Chinese supplier survey — one scan cut into NINE tiles, a table with ruled
cells, a red stamp over the top right — "could not be edited": the edit tool
said "0 text blocks found" and the OCR button returned half the cells. Four
causes, each measured with `tools`-style node harnesses (tesseract.js runs in
node against `public/tessdata`, MuPDF renders the page at 220 DPI):

- **tesseract.js's default page segmentation is ONE uniform block** (mode 6),
  and a form is a grid of short cells. On this page mode 6 finds 15 of 30
  expected cells, automatic (3) 26, **sparse text (11) 28** with the fewest
  borders read as glyphs. On a prose scan sparse still finds every expected
  phrase at 94% against 95%, at about twice the time. `ensureWorker` sets it.
- **A table's vertical rules come back as "|"**, on their own or stuck to the
  word beside them, and glued two cells into one run. `buildItems` cuts the
  line at a border-only word and shaves borders off word edges.
- **A scan is detected by SUMMED image coverage** (`isScanLikePage`), not by
  any one image covering half the page; and on a scan page every content image
  of a twentieth of the paper or more is `paper` in the edit tool — transparent
  to the pointer, so the click reaches the text overlay.
- **CJK sideways is still CJK to the model.** The quarter-turn pass returned
  seven confident sideways runs ("总 | E") on a page with none; sideways CJK
  needs 78% and three real characters with no border in them. The pass also
  reads a 0.7-scaled raster: a sideways label is never six-point body text,
  and this halved a 45-second recognition to 17.

Two sizing facts for CJK runs: an ideograph fills its em, so the Latin
"no descender → box is 0.76 em" rule sized 10pt cells at 13pt
(`GLYPH_BOX_PER_EM_CJK` = 0.92); and on a ruled form the WORD box swallows the
cell border (a 6.5pt label in a 10.8pt box), so `cjkEm` takes the median GLYPH
box instead. Runs the model hardly believes — the stamp read as "ci Y", "ee",
"N" at 0–40% — are dropped by `isJunkRun`; two-character Chinese cells and
numbers are kept whatever their confidence above 30.

### Three OCR engines behind one contract; PaddleOCR reads first
`src/utils/ocr/ocrEngine.ts` is what every recogniser answers to — lines with
a box, text and confidence, and OPTIONAL words, glyph boxes, baseline and
paragraph — and `buildItems` degrades honestly when the optional parts are
missing. `TesseractEngine` is the old path unchanged (sparse segmentation,
words, symbols). `PaddleEngine` runs PP-OCRv6 small (`public/paddle/`, 31 MB,
Chinese + Latin in one model) on ONNX Runtime Web inside
`paddle.worker.ts`, WebGPU when the browser has it. `MistralEngine` posts the
page image to the cloud, opt-in, key in localStorage, one consent per session.
`editorStore.ocrEngine` (persisted through `persistedRef`, the app's first
persisted setting) picks; Paddle falls back to Tesseract ON ITS OWN when it
cannot start, and the status line says which engine read the page and why.

Measured on the supplier survey: Paddle 50–53 runs at 99% in 11–14 s (Tesseract
sparse: 57 at 91% in 17 s) and it reads the e-mail, phone and SWIFT cells
Tesseract missed; on the Spanish prose scan 43 runs at 93% with bold headings
detected. Three things the worker had to get right:

- **ORT's WASM cannot be a package subpath** — `onnxruntime-web`'s `exports`
  map hides `dist/*.wasm`, so `import … from 'onnxruntime-web/dist/x.wasm?url'`
  fails to resolve. `new URL('../../../../node_modules/…', import.meta.url)`
  works in dev and build. The SDK sets `ort.env.wasm.wasmPaths` to a CDN on
  import when it is empty, so the env is set BEFORE the SDK is imported.
- **Models are fetched through the Cache Storage API** and handed over as
  ArrayBuffers: a second visit costs no download, and nothing reaches out to
  Hugging Face (COEP would refuse it anyway).
- **The SDK's `processing.engine` is `canvas-native`**: no OpenCV WASM to load.

An engine without word boxes is measured on its INK (`inkMeasure.ts`):
Paddle's detector pads its boxes — a 6.5pt label arrived in an 11.5pt box —
so the tight ink box is the glyph height, with table rules excluded from the
profile on the axis they cross (a 3px vertical rule put ink on every row of a
blank box, so no row ever read as empty). A box the detector read across two
cells is cut at an INTERIOR vertical rule, looked for on a box stretched half
its height up and down — in the tight glyph box every stem of a 司 spans most
of the height and read as a rule, shredding the page into 276 pieces. A cut
piece is then RECOGNISED AGAIN as its own crop: sharing the text out by width
or by ink kept landing one ideograph off. Plain gaps cut only at 2.5 em, the
bar `splitRuns` sets; at 1.2 em justified prose was cut mid-line and the
re-read pieces came back with a space inside a word.

### A baked replacement is fitted to the page; a run narrower than tall is not a run
`planOcrExport` brings a replacement's size down (never below half) when a
base-14 face would carry it past the paper: Helvetica-Bold's "=" is 0.58 em
where a typewriter's is a third of that, and appending to a line of them
ended 80pt past the page edge and read back truncated. And a horizontal run
of three or more characters cannot be narrower than it is tall — a 26×81pt
box reading "O pa: F 是一 053" is a stamp or a sideways column read the wrong
way, baked as an 85pt line it left the page; `buildItems` drops it.

**Sweep (110 PDFs from Downloads, `ocr-driver.js`, run 2):** 172 pages, 24
scans, 0 page errors, 63 of 69 scan edits read back (the six: two junk runs
now dropped, two runs that left the page now fitted, one non-edit, one
transient), 30 traced, 139 of 145 text edits (the rest: a `????` font, a
`✓` line, re-grouped readbacks).

### The engine worker comes back from a crash with its document
MuPDF's WASM corrupted its heap on the 42nd document of a sweep — "table
index is out of bounds", then "memory access out of bounds" from
`getPageText` — and the same file opens cleanly in a fresh worker. Before,
every later call answered "Worker not initialized" and 68 files failed until
a reload. `MuPDFBridge` keeps the last document's bytes; on a crash it
respawns the worker, reloads them and retries the call once (`recover`), and
`onCrash` puts a line in the status bar. A document that kills the worker on
reload is forgotten rather than reloaded again.

### A dense scanned page in twenty seconds, not four minutes
A slide deck's page took 226 s. Measured (`window.__prof` in the dev tab):
the page itself was 5–12 s (the first WebGPU inference compiles shaders —
the worker now warms on a tiny canvas at init), but cut pieces were re-read
ONE CROP EACH (190 calls, 13 s) and the sideways pass re-read its huge
rotated pieces (25 s). Now every cut piece on the page goes into one stacked
sheet (chunked at 1800px so the detector does not shrink it), the sideways
pass never re-reads, and the sheet's crops have almost no horizontal padding
— at 60% of the height a 41pt title's pieces read back "SIL CAPACI" with a
letter of the piece next door. Light-on-dark boxes are INVERTED before any
profile (`inkMeasure`, `glyphCut`): read as ink, a title's letters were the
"gaps" and its background the "rules", and it was cut between letters into
190 fragments. Same page after: 27 clean runs in 19 s.

### The scan face: edited runs drawn with the scan's own glyphs
Acrobat's "Editable text and images" traces the page into a font; here a face
is built per page, lazily, from the runs the user edits (`scanFace.ts`). On
commit, `useOCR.traceItem` cuts the run's ORIGINAL ink into one cell per
character (`glyphCut.ts`: Tesseract's glyph boxes when they agree with the
text, else the column profile merged or split to the character count, refusing
when that takes more than a third of the count in edits), binarises each cell,
traces it with Potrace (`esm-potrace-wasm`, GPL-2 like MuPDF's AGPL) and
scales the outline onto a 1000-unit em with the baseline at the mode of the
cell bottoms. opentype.js compiles the library into an OpenType font; the same
bytes register as a `FontFace` for the preview (`faceStack` puts the face
first, the base family behind it) and go to the worker through `registerFace`
before a bake. `addTextToPage` lays a run out as SEGMENTS inside one BT — a
stretch the face can encode gets `/FSCNn Tf <gids> Tj`, a stretch it cannot
goes to WinAnsi or the CJK fallback — and the text matrix carries the pen, so
no advances are computed. Measured: 营业执照 edited to 营业执照编号 renders the
four traced glyphs, 编号 from a 2 KB Noto subset and "Nro 5" in Helvetica on
one baseline, extracts back as written, and grows the file by 5 KB.

**MuPDF's CFF subsetter is not to be trusted with the Noto face.** For some
runs it fails ("Insufficient operators on the stack", "Index bounds") and the
document then carries the whole 8 MB font; the run 编号 also drew as ONE wrong
glyph. The fallback face is now parsed by opentype.js once and a tiny font is
built per run from the glyph outlines (`miniCjkFontFor`), the same route the
traced face takes — MuPDF embeds a few KB it can handle.

**Only glyphs the engine and the user AGREE on enter the face.** A scanned
letter's "Atentamente," reads "Atentarhente," in BOTH engines at 99% — the m
is broken in the ink — and tracing on the engine's text stored the two halves
of the m as the face's "r" and "h", so every later r and h on the page would
have drawn as half an m. `trustedCells` keeps the common prefix and suffix of
the engine's text and the user's; the changed stretch is trusted by neither
side and falls back to the base font. Cells are assigned to ink runs by
WIDTH (`assignByWidth`, least-squares DP over expected advances), never by
splitting the widest run — the widest run in that word is the m itself.

**`fillRect` undoes the CTM the stream leaves in force**, as `addTextToPage`
does. The letter's stream opens with an unbracketed `0.36 0 0 0.36 0 0 cm` for
its scan and never restores it; a patch written in page units landed at a
third of its size in the corner, and the replacement text sat over the old
ink — "the text is like this after I remove a character".

**A face must carry a space glyph.** The engine encodes a whole segment in
one face, and a face that could not encode the space between two traced
words made "N° 377-3000888581" fall back to Helvetica entirely while single
words traced fine. Faces are keyed by weight, slant and point size
(`styleKeyOf`), one font each: a 9pt italic footer never shares glyphs with a
12pt body line, and the bake registers every face of the page.

**The cut refuses what it cannot vouch for.** A run with fewer ink runs than
60% of its characters is letters that touch (the italic serif footer) and is
not cut at all — sharing 69 characters across its runs put the wrong letter in
every second cell with plausible widths, and "República" came back
"Rpúbbiica". Cells are assigned to runs by WIDTH (`assignByWidth`, least
squares over expected advances), never by splitting the widest run (the widest
run in "Atentamente" is the m); each cell's width is checked against its
letter and its SHAPE against its class (`flagByShape`: an x-height letter must
neither rise nor descend, a descender must descend, an ascender or capital
must rise, measured on the run's own baseline and x-height); more than a
tenth suspect refuses the run. What is refused draws in the base font — a
visible seam, never a wrong glyph.

`public/_sweep/ocr-driver.js` edits scanned pages the way a person would
(delete a character, reverse a word, append) across `public/_sweep/dl/*.pdf`
(gitignored, staged from Downloads) and judges recognition, the bake, the
scan face and the viewer; `scratchpad/analyze-ocr.mjs`-style summaries are
what to read after a run.

The binarisation threshold sits at 0.42 of the box's range, not the midpoint:
a scan's strokes are ringed with anti-aliased grey and the midpoint kept the
ring, so the traced glyphs came out visibly heavier than the page.

### A text edit that WinAnsi cannot hold substitutes the CJK face, not an error
The bilingual forms this editor lives on end half their lines in 不适用, and
appending a word to "NO APLICA 不适用" failed with "Cannot encode characters"
because the substitution fallback knew only WinAnsi and the base-14 faces
(and the tail cannot be narrowed away — see "Trimming the TAIL is wrong").
`planTextEncoding` now returns a HEX substitute plan (`hex`, `hexLines`)
drawn in a mini Noto font built for the run (`miniCjkFontFor`), registered
in the resources the block's Tf resolves against (`registerFontIn`, page or
Form XObject), and every consumer emits `<hex>` through `substLines` /
`substLiteral`. `replaceText`'s message case awaits `ensureCjkFontFor`
because the writers are synchronous. Measured on the check-list form: the
line reads back "NO APLICA 不适用 X" in NotoSansSC, the file size unchanged.

### Writing text WinAnsi cannot hold: subset in a SCRATCH document, then graft
The WASM build has no built-in CJK face, so `addTextToPage` fetches
`public/fonts/NotoSansSC-Regular.otf` on the first run that needs it
(`ensureCjkFontFor`, awaited in the message handler — the writers are
synchronous). `registerCjkRun` draws the run in a scratch `PDFDocument`,
calls `subsetFonts()` THERE, and `graftObject`s the resulting font dictionary
into the page under a fresh `FCJKn`; the run is written as Identity-H hex of
the glyph ids. `addFont` alone embeds all 8 MB, and `subsetFonts()` on the
real document would subset the ORIGINAL fonts too — glyphs the page does not
currently draw would be gone and a later edit needing one would be pushed into
a substitute. Measured: 39 KB per run, 242 ms, extracts back as written. The
FreeType "invalid argument" warnings during subsetting are MuPDF's and harmless.

### A WASM trap reported as an error message is still a crash
MuPDF's "memory access out of bounds" (and "table index is out of bounds")
arrive through the worker's own try/catch as an ordinary `error` reply, NOT
through `worker.onerror`, so the crash recovery in `bridge.ts` never fired:
the worker stayed up on a corrupted heap and answered "No document loaded"
to everything after — in the OCR sweep one such file took the 83 after it.
The worker flags a `WebAssembly.RuntimeError` as `fatal`, the bridge also
recognises the runtime's messages (`isWasmFatal`), and both go through the
same `markCrashed()` teardown `onerror` uses, so the next call respawns the
worker and reloads the document. Recovery is only as good as `lastDoc`: an
engine-level test that never went through `loadDocument` has nothing to
come back to.

### pdfTeX's /Widths lists EVERY glyph, held or not
The glyph-availability test in `encodeForSimpleFont` reads a zero in
/Widths as "missing from the subset". pdfTeX writes the TFM width of the
whole encoding — `X` = 750 in a 94-glyph LMRoman10 subset with no X — so on
LaTeX output the test is blind: the typed letter went into the file, drew
NOTHING, and the sweep scored the edit as applied while the page showed the
line unchanged. `loadFontProgram` loads the embedded Type1/CFF program
(`FontFile`/`FontFile3`, `readStream()` on the indirect reference) into a
`mupdf.Font`, FreeType synthesises a Unicode charmap from the glyph names,
and `programHasGlyph` is asked per character. Never for TrueType: a
symbolic (3,0) cmap answers nothing about Unicode and every glyph would
read as missing. The sanity gate is "at least ONE single-letter name in
/Differences resolves" — "every named letter" was tried first and fails on
exactly this producer, because pdfTeX writes the whole encoding vector into
/Differences, unused names included. The space is exempt: LaTeX fonts have
no space glyph, it draws nothing either way, and its advance comes from
/Widths.

### What follows a rewritten window is placed by the PEN
Inside one BT, the ops after an edited run are positioned relative to the
pen unless a Td/TD/Tm/T* resets it. A LaTeX table of contents sets the
entry, its leader dots and its page number as one line of ops, the number
reached by a kern — widening the text pushed the "9" ten points right.
`applyPartialBlockReplacement` measures what the window drew (per-op
`showOpAdvance`) against what it draws now (the kept font's /Widths, or the
substitute base-14 face's advances) and appends `[k] TJ` after the window
to cancel the difference — only when every width is known and nothing in
between resets the line matrix. Same physics `replaceInsideTjArray` already
applies inside an array, one level out.

### A page operation forgets the OCR results
OCR results and scan verdicts are keyed by page index and measured on the
page's geometry. Insert, delete, duplicate, move, merge and rotate make
every index after the change describe a different page; `forgetOcr()` in
`EditorLayout` drops them after each such op, and says so when unbaked
edits went with them. Recognising again costs seconds; editing the wrong
page costs a document.

### An UNKNOWN encoding with single-byte codes can still take an in-array substitution
`replaceInsideTjArray`'s substitution branch refused every font whose
`encodingName` is `Unknown` — which is every symbolic TrueType subset with
no /Encoding, the commonest font Word and Ghostscript emit. The bilingual
form draws "Normal / Urgente / Urgente e Importante" as ONE such array
inside a SimSun block, so typing a letter the subset lacks reported "Could
not find matching text" after the block had in fact been found. /Widths is
indexed by CODE whatever the code means, so with one-byte codes
(`encoding.codeBytes === 1`) the old-run width the compensation kern needs
is exactly what the viewer advances by. Two-byte codes read as bytes index
garbage and stay refused, as does Type0. Measured: the caption edits to a
Times-Bold substitute with its neighbours untouched, and edits back.

### A clip grows toward wherever the text ENDS, on both axes
`widenClipForText` mapped the replacement's end point into the clip's own
space and compared only its x. On a /Rotate 90 page (the Ghostscript
fund-request forms) a line runs along the clip's HEIGHT: the end lands
outside in y with x untouched, so the cell clip stayed exactly as long as
the old text, the typed letter was drawn and clipped away, and the edit
reported success while the page showed nothing — MuPDF's extraction honours
the clip too, so nothing read it back either. Both coordinates are taken as
a union now; for an upright line the end point's y is already inside the
clip and only x can grow, so nothing changes there.

### Any character WinAnsi lacks takes the wide face, not only CJK
`planTextEncoding` routed only `hasCjk` text to the mini Noto font, so a
thesis line with a real MINUS SIGN (U+2212, "Q(s) − G") refused with
"Cannot encode characters: −". `needsWideFont` is CJK OR any code point
outside WinAnsi, and `ensureCjkFontFor` loads the face on the same test.
What the face lacks either still errors.

### An ActualText override never carries a no-break space
Word marks every nbsp with `/Span <</ActualText <FEFF00A0>>>`, so an
extracted line carries U+00A0 and a retyped line brings it back into the
span override — and MuPDF's extraction, given an ActualText holding U+00A0,
read "S.A.A. 0000" back as "S.A.A. 0 0000" (measured on the saved file:
the same override with U+0020 reads back clean; the ink was right all
along). `retagSpanActualText` writes U+00A0/U+202F/U+2007 as a plain space.

### Ligatures are folded before any comparison
A ToUnicode CMap maps an "fi" glyph to U+FB01 while MuPDF's extraction
expands it to "fi", so the stream decode of "perfil" read "perﬁl" and never
equalled the extracted target. On the Intellisign manual that made the line
group ("perﬁl”" + "选项") lose to a fuzzy single-block match on the Latin
half alone, which took the whole replacement and left the CJK block on the
page — the ideographs drew TWICE, offset by a few points. `foldForMatch`
expands U+FB00–FB06 first; the sweep is unchanged.

### Known limitations found by the overnight sweep (2026-09-02)
- **A fully justified line has no room.** Appending to a line that already
  touches the right margin draws the new word past the page edge (the
  op-level rescue paths draw in place and do not wrap). Only the rebuild
  path wraps, and it is not reached when the edit is narrowed to one op.
- **Identical text drawn twice in the same place** (Intellisign stamps its
  ID strip once per signing pass, in separate content chunks) extracts as
  ONE line; an edit rewrites one copy and the other still shows the old
  text. The shuffle matcher only sees interleaved overlaps.
- A faint watermark-grey logo recognised by OCR ("MOUXIN") is redrawn in
  its sampled colour, i.e. nearly invisible — faithful, but reads as lost.
- MuPDF's WASM traps ("memory access out of bounds") on one Ghostscript
  order form in a long sweep and not in a fresh worker; recovery reloads
  the document and the rest of the run is unaffected.

### An untouched end of a line set in ANOTHER font is not the edit's to rewrite
Word draws a bullet as its own SymbolMT block in front of one Arial block
per word, and `applyLineReplacement` takes the leftmost block as primary —
so the whole sentence was re-encoded for the BULLET's font. The Symbol
subset's ToUnicode claims Latin letters for its Greek glyphs, the encode
"succeeded" (keep-hex), and "Backups automatizados" rendered as
"Βαχκυπσ αυτοματιζαδοσ": page 8 of the VEEAM order, reported as "rare
symbols". `narrowLineAndRetry(true)` now runs BEFORE the plan: a leading or
trailing run of blocks the edit did not change is dropped when its font
differs from the block where the change begins, and the middle is edited
on its own. Same-font ends are left alone, so a single-face line is
rewritten exactly as before; a differing end keeps its own face either way,
so the "two faces in one line" objection to unconditional narrowing does
not apply.

### An op window is scored by CONTENT, and a foreign glyph inside it is stepped over
Microsoft Print to PDF (the RNP constancia) draws "RUC N° 10706691184" as six
ops: "R", "UC ", "N", a superscript "º " in another font, ten digits, and the
last "4" in a third font. Extraction puts the superscript in its own block,
so the target is "RUC N10706691184". Two things went wrong at once:

- **`matchRatio` is a LENGTH ratio.** The window that drops the first "R" and
  the last "4" but picks up "º " has exactly the target's length and scored
  1.0, beating the window holding all the text — the replacement was drawn
  from the second op with the stray "R" and "4" left standing ("RRUC N10 4…").
  `subsequenceSimilarity` (longest common subsequence over folded,
  space-free text) scores the glyphs that are actually the target's. Inside
  the tie band, equal distance now falls back to the better score.
- **`narrowToChangedOps` stopped at the "º".** A glyph the target never had
  at all is not a change: it stays where it is, drawn by its own op, and the
  walk goes on. Blanking it with the window deleted the "º"; stopping there
  re-encoded the digits from the "º"'s position, one glyph to the left.

Measured: the RUC edits to "RUC N° 1070669118455" entirely in Verdana-Bold,
the "º" kept; the two year edits substitute only their changed tail.

### The op-window path wraps too
`applyPartialBlockReplacement` drew in place only, so appending a few words
to a heading ran them off the right edge of the paper — in the file,
invisible, and unrecoverable except by undo ("why doesn't the text wrap
here?"). `wrapWindowText` measures the window's text the way
`layoutReplacementLines` does (a base-14 stand-in calibrated against the
width the block occupies today): the first line gets the room from where
the window STARTS on the page to the right margin, every further line the
full room from the block's left edge. Continuation lines are emitted inside
the same op as `dx −lead Td (line) Tj`, starting at the visual line's left
edge (the smallest x among the ops on the same y), and the line matrix is
put back with the inverse `Td` so every later line of the block lands where
it did. `lines` is returned so the client can make room. Three gates: the
window must be the last pen-relative thing on its line (a Td/TD/Tm/T* or
nothing follows), the block's Tm must carry no scale (Td operands live in
that space; the print-to-PDF `0.24 cm` generators are gated out rather than
mis-scaled), and the wrapped lines must still encode. The trailing-kern
compensation is skipped for a wrapped window — the pen is not where a kern
could reason about.

With the Reflow toggle OFF the continuation line overlaps the line below,
exactly as the rebuild path's wrapped lines do; ON, the rows below are
pushed by the extra lines.

### A bracketed run carries its own Tm operators with it
The td_bracket move (one line out of a shared block) wraps the run in a
`Td` and its inverse. Microsoft Print to PDF draws one visual line as
"PAR" + `1 0 0 1 132 667 Tm` + "A SER PARTICIPANTE…": the absolute Tm
inside the run reset the line matrix, only "PAR" moved, and the inverse
Td then shoved the NEXT line the other way — every reflow on that
producer tore words apart ("PAR" / "A SER…", "JOSÉ" / "LUIS…"). Every Tm
inside the run is now shifted by the same delta (in the CTM's space, as the
whole-block Tm rewrite does); the inverse Td still cancels the shift for
whatever follows.

### Lines are clustered by baseline PROXIMITY, never by a grid
`splitBlocksAtGaps` grouped glyphs into lines by rounding the baseline to a
0.5pt grid. A grid has boundaries, and a baseline that sits on one (250.25)
had its glyphs land on either side by floating-point noise: "ANDAHUAYLAS"
became "A" + "NDAHUAYLAS", a one-letter block no move could address, so
reflows left the "A" behind. Glyphs are sorted by baseline and a new line
starts only where it steps by more than max(0.5pt, 8% of the size).

### A Td-positioned line is admitted to a move by where its run is DRAWN
The move matcher's last-resort pass required `findGoverningTm` and ranked
by the block's origin. "Nota:" is the last line of a BT that opens with a
Td and steps between rows with Td — no Tm governs it and the origin is
120pt away — so it was refused and a reflow moved the note but not its
label. `runDistanceToTarget` (real advances) now counts as the distance
and a line-leading run from `findTargetRun` as the admission: exactly what
the td_bracket move goes on to use.

### The middle of a narrowed line keeps its space blocks; trailing blanks stay in a run
Word draws every word AND every space as its own BT. `narrowLineAndRetry`
retried on the contributing blocks only, and `trimBlankEnds` dropped the
run's trailing blank, so after a longer rewrite the old space glyphs stood
inside the new words at their old positions: nothing visible, but every
readback (extraction, the inline editor, copy) said "eficie nte  de  los
backu ps" and the next edit matched a target full of phantom spaces. The
middle takes the whitespace blocks between its first block and the
dropped tail; a run keeps its trailing blanks (only leading ones move the
anchor); and `applyLineReplacement` blanks a whitespace block that sits
after the primary.

### Never patch this file through a shell heredoc
Two regexes lost their backslashes on the way through `node - <<'EOF'`
(`[\d.]` became `[d.]`, `\s` became `s`) — one made the Tm shift a no-op,
the other made `subsequenceSimilarity` strip the letter "s" instead of
whitespace. Write the patch script to a file and run it.

### The inline editor is set in the font of the block's TEXT, never a symbol face
`cssFontStack` put the PDF's own family first — from `block.fontName`,
which is the FIRST character's font. Word draws a bullet in SymbolMT and
the sentence in Arial, so the editor opened in "Symbol MT" and the browser
drew every Latin letter as the Greek glyph at that code: "Βαχκυπσ
αυτοματιζαδοσ" in the editor while the page underneath was untouched. It
read as the edit having wrecked the line, and the second line of the same
bullet (no bullet glyph) "worked". `textFaceOf` takes the first letter or
digit's face and never uses a symbol face (Symbol, Wingdings, Webdings,
Dingbats, Marlett, MT Extra) as a family; the bucket fallback stands in.

### A one-character block is matched by position, and a missing digit is borrowed from a sibling subset
A pivot table exported from Word (the "COMPROBANTES EMITIDOS" count sheet,
signed through Intellisign) draws every count as its own BT — "    3",
"  9", "         7" — and reported *"Could not find matching text in content
stream"* for every single-digit cell while "2130" beside it edited fine.
Step 3 of `replaceTextInContentStreamFontAware` skipped any block whose
decoded text is under two characters, a floor meant to stop a lone letter
fuzzy-matching half the page; no other pass admits a whole-block exact
match, so the cell had zero candidates. A one-character block is now
admitted only as an EXACT match that SITS on the click (`dist <= max(6,
height)`), the same gate the blank-field and lone-label passes use.

The same sheet embeds one CID subset of MinionPro per cell: `/C0_2` holds
"3", "7" and a space, `/C0_1` every digit. Changing "33" to "34" could not
be encoded in `/C0_2`, and the base-14 fallback drew a Helvetica "4" beside
a Minion "3". `findSiblingSubset` in `planTextEncoding` now tries, before
any foreign face, every OTHER Type0 font in the active resources whose
/BaseFont matches with the subset prefix stripped, and returns a hex
`subst` plan on the first whose ToUnicode encodes every line. Helvetica is
only for what no subset on the page can draw ("2222" → "1884" in the Bold
subsets, which hold only 0, 2 and 6).

Measured with the node harness (below): all 14 numeric cells and the title
edit and read back; the corpus sweep is experiment-identical to baseline
(262 experiments, 229 successes, no strategy or substitution changed —
the sweep's markers are 4+ Latin capitals, so neither path is exercised
there).

### The engine runs in node — reproduce first, browser second
`tools/pdf-sweep/node-harness.mjs` loads the worker through Vite's SSR
loader with a fake `self`, so a report can be reproduced in seconds without
a browser (the chrome-devtools MCP profile is often locked by another
session), and `tools/pdf-sweep/sweep-node.mjs` runs the sweep driver on it
in under a minute against ~9 in the browser. To get a baseline, `git
worktree add` the last commit, junction `node_modules` and `public/_sweep`
into it (`cmd /c mklink /J`), run with `PDF_ROOT` pointing at it, and diff
with `compare-sweeps.mjs`. Unlink the junctions with `cmd /c rmdir` BEFORE
removing the worktree — `git worktree remove` fails on them, and `rm -rf`
would walk into the real `node_modules`.

### A clip may be closed with a fifth point, and a narrow right column never wraps
Round 2 of the sweep (80 never-swept Downloads PDFs, 38 producer families)
found three defects that no file in the original 52 exposed.

- **A path clip can carry FIVE points.** `getActiveClipsAtOffset` matched
  `m l l l h W* n`; Acrobat and InDesign close the rectangle with an explicit
  `x0 y0 l` back to the start instead of `h`, so every clip on such a page was
  invisible to the scanner and none was grown. Moving a title on a bilingual
  supplier form pushed its Chinese line outside the unexpanded clip and it
  vanished from the render AND from extraction — 16 characters gone from a
  MOVE, which must never change a character. The fifth point is accepted only
  when it really is the first one again.
- **A cell against the right edge must not wrap.** `wrapRoom` returns
  `Infinity` — meaning "do not wrap" — for a block within three em of the
  right margin. Such a block is the last column of a table, and a
  continuation line is one leading down, i.e. exactly the next row: the tail
  was drawn across the row beneath and extraction read the two interleaved
  ("R 0K.0600" on a bank statement, on a SUNAT guide the same). Two rows
  wrong, and the edit reported success. Drawn on one line the overflow can be
  clipped by the paper edge — the justified-line limitation already
  documented — but only the edited row is ever affected. Real edits to these
  cells fit either way.
- **A first line too narrow for the first WORD breaks that word.**
  `wrapWindowText` left the first line EMPTY and pushed the word down, so a
  73pt cover title was redrawn one whole line lower with a bare `() Tj` where
  it had been.

### A doubled-draw target states its text twice; the blank guard must halve it
Canva fakes bold by drawing the same run twice a fraction of a point apart, so
extraction reports "AUTO" as "AAUUTTOO" while each block still draws plain
"AUTO". The undouble matcher finds those blocks correctly (score 1.5, distance
0) — and `applyLineReplacement`'s guard, which refuses to blank a block whose
folded text does not appear in the target, compared "auto" against "aauuttoo",
found it foreign, and threw the match away. Every headline on every Canva
poster was uneditable while the matcher had the right answer in hand. The
guard now accepts the halved form as well; `undouble` requires EVERY character
to be paired, so it cannot fire on ordinary text.

The failure was invisible in the error message, because `lastMatchDiagnostic`
is shared and each content source overwrote it: the report described a button
two Form XObjects down while the failure was in the page stream. Diagnostics
are collected PER SOURCE now, and the candidates that were tried and refused
are listed with their kind, score, distance and text — the difference between
"nothing looked like it" and "something did, and the apply step declined" is
the whole triage.

### A visual line is constant PAGE y, never constant text-space y
`findBtBlocksByPosition` grouped blocks into lines by `yPos`, the origin
inside whatever `cm` is in force. A generator that wraps each region of the
page in its own transform reuses the same text-space y everywhere: on a Qt
service report the header title, the company name, the site URL and the page
number all sit at y = -17, so ONE group held nine unrelated runs, its join was
garbage, and no line ever matched. The heading is drawn as two blocks
("Reporte de Servicio Técnico " + "— N° 146711 - 1"); with no line match each
was moved on its own and a drag tore the title in half. Blocks are now
clustered by PAGE-space y (origin through `getFullCtmAtOffset`, flipped),
by PROXIMITY rather than onto a grid — a baseline exactly on a grid boundary
lands either side of it by floating-point noise — and `byX` sorts in page
space too. `LINE_CLUSTER_PT` is 3, half a line of body text.

This is what the 23 "moved but did not land" failures of round 2 had in
common across Qt, dompdf, tex, crystal, pdf24 and miktex.

**A blank block on the run travels with it, but only when the target says so.**
Word and iLovePDF draw a run's trailing space as its own BT, and every pass
that matches on TEXT keeps only the blocks whose text matches — so the space
stayed behind while its words moved 20pt away, stranding a glyph that later
readbacks report as a phantom space inside the words. Blanks are attached to
the WINNING candidate (an exact single-block match outranks the line group
carrying the same space, so doing it per candidate never reached the winner)
— and ONLY when `targetBlock.text` is not equal to its own trim. Extraction
merges a trailing space into the block it belongs to, so "BANCO DE CRÉDITO "
ends in one and its blank is part of the run, while "Sonido" does not and the
blank near it belongs to another cell: carrying that one appended a space to
a run the user never touched, which cost four experiments before the gate.

The REPLACE matcher grouped lines the same way and now shares the page-space
clustering. Page space also retires the `sideways` special-case there: the
invocation CTM already carries /Rotate, so a visual line is constant page y
whichever way the paper is turned. It moves eleven baseline experiments from
`single_block` to `line_group` with identical output (char_delta 0, same text)
and gains one.

Sweeps after all three changes: baseline 262/232 (was 229), round 2 439/392
(was 379 when the round was staged), zero lost on either.

### An ideograph is SEVERAL ink runs, so the glyph cut needs a bigger budget
`cutByProfile` merges adjacent ink runs until there is one per character and
refuses when that takes more than a third of the character count. A Chinese
line breaks that immediately: 报 is two radicals, 遗 two or three, and the
column profile reports each as its own run — a scanned memo's lines arrived
as 66 runs for 44 characters, 47 for 33, 72 for 43. Every Chinese line on the
page was refused, so an edited line could never be redrawn in the scan's own
face and always fell back to Noto. The budget is two merges per character for
a CJK run (one for Latin's third), which covers a three-part ideograph;
merging only ever joins ADJACENT pieces, smallest gap first, and a wrong
merge still shows up as a width outlier in the suspect check below. Measured
on the memo: the fragment refusals are gone and one more line traces.

**CJK punctuation was NOT given a narrower expectation, though it looks
right.** A "，" occupies a full em with the mark in one corner, so a third of
an em is the honest ink width — and setting it moved a line that traced back
to refused (7 of 33 cells suspect) while fixing none, because the profile
merges a comma into its neighbour's run about as often as it reports it
alone. Reverted; the uniform 0.95 is what the corpus supports.

**Known limitation:** two of the memo's Chinese lines still refuse at the
width fit ("widths do not fit the letters"), and one Latin line at the shape
check. They fall back to Noto or Helvetica, which is a visible seam but never
a wrong glyph.

### A move inside a Form XObject must grow that form's /BBox — and its ancestors'
A form is clipped to its own /BBox even with no `re W n` in sight. The REPLACE
path has walked the ancestor chain for a long time, widening each box and the
clips around every `Do`; the MOVE path did neither. Dragging a heading inside
an iLovePDF admission form therefore pushed it past the edge of the box, where
it vanished from the render AND from every extractor, while the operation
reported success with `clipAdjusted: false` — measured, "Académicas" moved
20pt and was gone, char_delta 10 on an operation that must change no
characters at all.

`growFormBBoxByDelta` extends the box ONLY in the direction of travel, and
only ever outward, so it can reveal more of the form's own content and never
hide anything. The delta is mapped into each source's own coordinates through
the inverse of its `invokeCtm` (`deltaInSourceSpace`), because a form's box
lives in the form's space, not the page's. The ancestor walk mirrors the
replace path's, expanding the clips in force at each nested `Do` with
`expandClipForTransform`.

Measured across three corpora: baseline 262/235 (was 232), round 2 439/392
unchanged, round 3 466/401 (was 398), zero lost anywhere.

### A CID font's widths live in /W, and without them a shared row is untouchable
`replaceInsideTjArray` refused every Type0 font outright. The comment said
why: substituting inside a shared array needs the OLD run's width, or the
compensating kern is wrong and every later cell of the row shifts. A simple
font's /Widths gives it; a CID font's does not exist, so the answer was "no".

Microsoft Print to PDF and Ghostscript draw a whole form row as ONE array in
a CID subset, so on those producers a label could only ever be edited to
letters its own subset already held — measured, "DPTO:" accepted "TOPD:" and
refused "AREA:" with "could not find matching text", which reads as the
editor simply not working on that document.

`readCidWidths` parses the descendant font's `/W` (both `c [w…]` and
`cFirst cLast w` forms) with `/DW` as the default, and ONLY for an Identity
CMap — there the show-op's two-byte code IS the CID, so /W can be indexed by
the code directly. Any other CMap needs a code→CID mapping this engine does
not read, and answering nothing keeps those fonts refused exactly as before.

**The occurrence chooser needed the same table, and finding that mattered
more than the fix itself.** With the widths added but the chooser still gated
on `simpleInfo.widths`, the edit succeeded and rewrote the WRONG cell: this
row draws two "DPTO:" labels in one array, and `occ[0]` is the left-hand one
while the click was on the right. An honest refusal had become a silent wrong
edit. `advanceOf` now answers from whichever table the font has.

Measured on the reported form: "DPTO:" → "AREA:" lands at x=329 where the
click was, the label at x=64 is untouched, the row's other cells keep their
positions, and the page's character multiset changes by exactly the eight
letters involved. Replacements up to about eight characters go through; a
longer one still meets the separate length guard, which is the right answer
for a fixed-width cell. All three corpora are byte-identical before and after
(262/235, 439/392, 466/401) — the sweep's markers never take this path, which
is why this class of defect needs a hand-built case.

### A Tm may be MEASURED in without being rewritable
Rewriting a Tm moves every show op it governs until the next Tm — a
`Td`-stepped line inherits the matrix it steps from. `findGoverningTm` walks
back to the last Tm before the target's run, and on a letter that draws its
whole body from ONE BT with a single Tm at the top that is the same matrix
positioning every line above it: dragging "De nuestra consideración:" 20pt
also moved the subject line, its value and the "Inmediata" beneath it — four
blocks for a one-block gesture, reported as success. `blocks_touched` of 3 is
inside the sweep's tolerance, which is why this survived so long.

`governingTmIsExclusive` scans the span from that Tm to the next one and
answers whether every show op in it lies inside the run being moved. When it
does not, the move falls to `findTargetSegment` (shift the run itself) or
refuses.

**The two roles of the matrix must not be conflated, and conflating them cost
four moves before the sweep caught it.** The governing Tm is also the frame
`inTmSpace` converts the page-space delta through, so nulling it for the
REWRITE decision silently changed the MEASUREMENT too: the Td bracket was fed
the block's first matrix instead, and four moves on other producers landed
about 10pt short while still reporting success and touching one block.
`tmSource`/`tmMatch` therefore always come from the governing Tm; a separate
`tmRewritable` gates the rewrite branch, and is simply true when the block
does not hold more than the target.

Two scanning mistakes inside the helper each made it silently pass, and both
are worth knowing: matching a show op by its closing delimiter finds nothing
because `maskStreamLiterals` blanks the brackets with the literal, and
searching for "the next Tm" from `tmIndex + 1` re-matches the tail of the
SAME operator, collapsing the span to one character so no op can fall outside
it. Measured after the fix: baseline 262/235, round 2 439/392, round 3
466/401 — the same totals as before the guard, with the four-block drag gone.

### The size restored after an in-array substitution is the size AT THE OP
Ghostscript draws a whole timesheet from one BT that switches font AND size
per cell — `/R7 6.42`, `/R13 4.98`, `/R9 5.7`. `replaceInsideTjArray`'s
substitution branch splits the array and writes the original font back after
the new run (`/R9 <size> Tf`), and that size was taken from the block's FIRST
`Tf`. Editing a 5.7pt cell therefore restored /R9 at 3.54, and every run after
it rendered at 62% and crept progressively left: measured, 21 blocks moved for
a five-character edit, with `char_delta` 0 and the edit reporting success — the
page visibly wrecked below the edit while every text-preservation check passed.

`textStateAtOp` is the reader for this and the op-window path already used it
for exactly this reason ("Sizes come from `textStateAtOp` at the window, not
from whatever Tf happens to appear first in the content"); the in-array path
simply never did. `sizeAtOp` now supplies both the substitute's size and the
restore's, with the block-level size as the fallback when the op cannot be
located. Measured: the edit touches ONE block instead of 21, round 3 gains 4
experiments (466/404), baseline and round 2 unchanged, nothing lost.

### A marked-content section can CLOSE while the BT is still open
`retagSpanActualText` refuses a span holding more than one `BT`, which is what
stops one line's words being written over three. The opposite shape was not
guarded: a section that closes INSIDE the block. A utility bill opens
`/Artifact <<>> BDC` before the BT and then closes and reopens a section
between every field while the text object stays open, so the section holding
the block's start contains exactly one `BT` — passing the count test — while
covering only its first few glyphs. The whole block's text was written as that
fragment's `/ActualText`, and since ActualText REPLACES the glyphs for every
extractor, the page's text was then read a second time out of the override:
721 characters became 973 for a ten-character edit, the marker appearing
twice and a neighbouring line reading back as the entire invoice.

The span must CONTAIN the block: `emc >= blockEnd`, passed at all four call
sites. Measured on the reported receipt: the page now loses exactly the old
field and gains exactly the new. Round 4 gains 4 experiments (294/…), the
other three corpora byte-identical.

### An injected operator needs whitespace on BOTH sides
The td_bracket move writes `dx dy Td` immediately before the run it shifts.
The run can begin straight after an operator that takes no operands — `T*` on
a PDF24 invoice — and concatenating produced the token `T*20.0115`, which is
not an operator at all. MuPDF reported "unknown keyword" and every line after
it drew shifted and short: " Sello de Detracción…" read back as
"o de Detracción…", 10 characters gone from a MOVE, which must change none.

A leading and trailing space costs nothing (a content stream ignores extra
whitespace) and the same hazard applies to any injected operator. Measured:
baseline 262/237 (was 235), round 2 439/394 (was 392), round 3 466/406 (was
404), zero lost — so the malformed token was silently damaging documents in
every corpus, not just the invoice it was found on.

### The nearest Form XObject is searched first — identical cells are told apart by POSITION
`replaceTextInStream` returns on the FIRST content source that matches, which
is arbitrary when the same words are drawn in two different forms. An Excel
export gives every cell its own Form XObject placed by its own /Matrix, so a
row reading "AREQUIPA … AREQUIPA" is two identical one-line forms: clicking
the right-hand cell edited the LEFT-hand one, silently and while reporting
success. `sourcesNearestFirst` ranks the forms by how far each placement sits
from the target bbox; the page stream keeps its place at the front, because a
page-level match already wins today and nothing that works can change.

**The "lost first letter" on this document is NOT data loss, and checking that
mattered.** The same edit read back as "ZZZ" for "ZZZZ", which looks exactly
like the truncation bugs above. The saved stream holds `(ZZZZ) Tj`, the form's
/BBox is untouched, and pdf.js reads "ZZZZ" at the right position out of the
saved file — only MuPDF's own re-extraction of the edited form drops the
leading glyph, the same class as the spurious spaces already documented after
a substitution. An independent reader is what settles this; the sweep's
`char_delta` cannot.

### The CTM is scanned ONCE per stream, not replayed per block
`getCtmAtOffset` masked the literals of the whole prefix and re-ran the q/Q/cm
regex from the start of the stream on every call. That is O(stream) per call,
and every matcher asks it once per BT block: on a Ghostscript scan that draws
one page as 1389 blocks a single `replaceText` took 78 seconds and 83% of the
profile sat inside that one regex. In the app that is not a slow edit, it is a
frozen tab — and the sweep appeared to hang on the file rather than merely
being slow.

`ctmScanOf` walks the stream once, recording the CTM after every q/Q/cm, and
`getCtmAtOffset` binary-searches it. Measured on the same file: 78 s to 2.7 s,
27x. The cache is keyed by stream IDENTITY (`===`), never by content — the
callers pass one string instance through an operation and a rewritten stream
is a new instance, so a stale entry cannot be returned for edited content.

All four corpora are experiment-identical after the change (262/237, 439/394,
466/406, 462/412) and the baseline sweep runs in 18 s.

**Profile before optimising.** The suspicion was the new source ordering; the
file has ONE content source, so that change could not be involved, and the
profiler named the real cost immediately.

### The segment MOVE reads /W too, or a CID cell cannot be shifted
`findTargetSegment` — the path that shifts a run inside a shared TJ array —
asked for `simpleInfo.widths` and gave up when it was missing. A Type0 font
has no /Widths, so the whole segment path was unavailable on every CID subset:
a cell EDITED fine (the edit path had already been taught to read the
descendant's /W) and the same cell reported "could not find matching text"
when dragged. Both now go through the same table behind the same
Identity-CMap gate. Measured: round 3 gains two moves that used to refuse
("72875047" on a Print-to-PDF form, "BXB-866" on another) with no strategy or
result changing anywhere else — baseline 262/237, round 2 439/394, round 3
466/408, round 4 462/412.

**It did NOT fix the case that prompted it**, and that is worth recording: a
Ghostscript timesheet still refuses to move "16:00". The refusal happens
earlier, in `findBtBlocksByPosition` — a mid-line cell of a shared-Tm block
has neither a governing Tm nor a line-leading run, so the last-resort pass
never admits the block and `findTargetSegment` is never reached. Admitting a
block on a segment hit would be the next step and is not implemented.

### A segment hit ADMITS a block for moving — and must sit on the clicked ROW
The move matcher's last-resort pass admitted a block only when
`findGoverningTm` or a line-leading run could be found. A Ghostscript
timesheet draws a whole row as one TJ array inside a block that shares its Tm
with every other row, so a mid-line cell like "16:00" has neither: the block
was never admitted, `findTargetSegment` was never reached, and dragging a cell
reported "could not find matching text" while EDITING the same cell worked.
A segment hit is now a third way in.

**On its own that change moved the WRONG ROW, and the sweep's totals hid it.**
It scored +1 with nothing lost — but four experiments went from refusing
(`blocks_touched` 0) to moving (`blocks_touched` 1) while still failing, and
those are the ones that mattered: asked to move the second row's "16:00" the
engine moved the FIRST row's, 17pt away, silently and reporting success.
`findTargetSegment` chooses its occurrence on `clickedRel` — HORIZONTAL
position only — and a timesheet repeats the same value in the same column down
every row, so x cannot tell the rows apart. Ops more than 6pt (in page units,
through `unitScale`) off the target's local y span are now skipped;
`scanShowOps` already tracks `op.y` in the block's own space.

The comment first written here claimed the segment search "carries its own
position check, so admitting on it cannot pick a copy the click did not mean".
That was false as implemented. A confident justification in a comment is how a
wrong assumption becomes permanent — check the claim before writing it.

Measured, both changes together: baseline 262/237 and round 2 439/394
unchanged, round 3 466/412 (+4), round 4 462/416 (+4), zero lost. Both cells
of the reported timesheet now move their OWN row by exactly the delta asked.

### The pen advances across a show op, and that position is tracked
`scanShowOps` used to derive every op's position from Tm/Td/TD/T* alone, so
consecutive show ops with no positioning operator between them all reported
the SAME x. That is exact for a generator's own output and wrong for the shape
this engine writes: an in-array substitution splits a row into
`(new) Tj … [rest] TJ` with nothing positional in between.

`pen` accumulates each op's own advance (`showOpAdvance`, which now reads a CID
font's /W as well as a simple font's /Widths) and is kept SEPARATE from `ux`,
the line matrix's translation — a Td or T* moves the line matrix and restarts
the pen, so folding the two together would make every later Td relative to the
wrong origin. When a width cannot be had the pen stops advancing rather than
guessing, and later ops then report the last known position exactly as they did
before.

Measured on all five corpora: 262/237, 439/394, 466/413 (+1), 462/416,
446/410 (+1) — two gained, none lost.

**It did not fix the case that prompted it**, which is worth knowing before
anyone tries again:

### KNOWN, REPRODUCIBLE: a second substitution lands on the first one's run
`scanShowOps` tracks the pen from Tm/Td/TD/T* only — never from the glyphs
actually drawn. That is exact for every generator's own output, where cells are
separated by kerns INSIDE one array or by an explicit Td, and it is wrong for
the shape THIS ENGINE writes: an in-array substitution splits the array into
`[] TJ /Fsub s Tf (new) Tj /Forig s Tf [rest] TJ`, and the ops on either side of
the split carry no positioning operator between them. Every one of them then
reports the SAME x/y — the Tm's — so the next edit cannot tell them apart.

Measured on a Ghostscript invoice (`r5/011.pdf`, one "120.00" per row):

    #62  "710.00"  -> partial_block, marker lands at (500, 186)   correct
    #117 "120.00"  -> partial_block, reports success, char_delta 5
                      the marker is NOWHERE on the page

The saved stream shows why:

    [] TJ /F1 8.04 Tf (SWEEPMARK62) Tj /R11 8.04 Tf /F1 8.04 Tf [(SWEEPMARK117)] TJ

and pdf.js reads "SWEEPMARK62SWEEPMARK" at (500, 597): the SECOND edit wrote at
the FIRST edit's pen position, on top of it, instead of at the cell it was given
(page y 348). Editing one cell alone is always correct; editing a second cell in
the same column after it is not. The user-visible report would be "I change one
amount, then the next one disappears".

**Pen tracking was implemented and did NOT fix this.** The cause is one level
deeper: on this page the engine's own decode yields no readable characters at
all (`debugBtBlocks` finds zero blocks containing "120.00" while extraction
reports it), so the match is made on '?' wildcards and no amount of positional
accuracy can pick the right one of many identical wildcard runs. This is the
"decode must agree with EXTRACTION" class, not a position bug. The remaining
half-measure still stands: `scanShowOps` would
have to advance x by each show op's own width (`showOpAdvance` already computes
one for the kern compensation) and mark the position UNKNOWN when a width cannot
be had, rather than silently reporting the last Tm for every op. That moves
every position-based decision in the matchers, so it needs the full five-corpus
measurement, not a spot check. Refusing when several candidates share one
position would be the cheaper half-measure: it turns a silent wrong edit into an
honest failure, which is the trade this codebase already prefers elsewhere.

### An op window BLANKS a foreign glyph inside it — and keeping it is worse
A LaTeX author line carries a superscript footnote mark between two names,
"Abel De la Cruz-Moran *, [1,] Hemerson Lizarbe-Alarcon", drawn by its own op
in the middle of the window. Editing the line DELETES it: char_delta 2 on an
edit that should change only its own text, and a citation silently gone.

Keeping such an op instead of blanking it — the rule `narrowToChangedOps`
already follows when it steps over a glyph the target never had — was
implemented and REVERTED. The "foreign" test (the op's folded, space-free
decode is not a substring of the target, '?' exempt) is far too loose on a
justified paragraph: TeX's kerned spaces and hyphenation mean many ops of the
very line being replaced fail the substring test, so they were kept and the
OLD line stayed drawn under the new one — measured on `r3/011.pdf`,
char_delta 0 → 59 and 0 → 24 on two paragraphs. Two experiments gained across
the corpora, one lost, and the loss leaves 59 characters of stale text on the
page where the bug it fixes loses 2.

A SIZE test was then tried — keep an op whose Tf size is two thirds of the
run's or less — and it does not fire at all here: the mark is drawn in the SAME
font at the SAME Tf size (FFMQYN+URWPalladioL-Bold), its smaller appearance
coming from the matrix, so `textStateAtOp` reports no difference. Both cheap
discriminators are therefore ruled out, measured. What is left is comparing the
op's rendered size through its own CTM, or its baseline offset (a superscript
sits above the run's baseline) — neither implemented, and the bug costs 2
characters, so weigh that before spending more on it.

### A misaligned glyph cut leaves a SLIVER at one end, and that is what refuses it
Editing one character of a scanned bilingual contract's title redrew the whole
line as "QRAI MIEJOR MNIIEIIC TAI DR IIIFORNAEDRUEROR". The edit itself was
right: extraction, copy and search all read "MEJORAMIENTO DE LA INFRAESTRUCTURA
DE RED LAN" back, which is what makes this so hard to report - the document
reads as correct and the page is unreadable.

The damage was in the FACE, not the edit. `cutByProfile` cut the run's ink into
one cell per character and an extra ink run at the left edge, a table rule, took
the first cell: every cell after it held the letter to its left, so the traced
face stored each glyph under its neighbour's name and every later line drawn in
that face was scrambled too. The cut read
`"M"[696-698] "E"[702-717] ... "M"[776-796]` - the same letter two pixels wide
at the start and twenty later on.

Neither existing guard could see it. `flagByShape` compares each cell against
its letter's class, and on an ALL-CAPS line every letter is a capital of the
same height, so a one-letter shift keeps every shape plausible: 6 of 39 cells
flagged, under the one-fifth bar. Width against the letter's own
`expectedAdvance` is the signal that survives, and it costs nothing on narrow
glyphs because i, l and the full stop are already expected to be a third of an
em.

**Only at an END.** A shift is caused by something extra at one EDGE claiming a
cell, so the sliver it leaves is the first cell or the last. A sliver in the
MIDDLE is a broken letter or a thin glyph the profile clipped, it costs one
glyph, and the suspect flag already keeps that glyph out of the face. Measured
on the 14-document OCR corpus (71 edits): refusing on ANY sliver, or on any
grossly wrong width in either direction, took tracing from 25 runs to 20 with 19
refusals - the wide half of that test fired on nothing the narrow half missed.
The end test alone keeps 24 traced runs with 7 refusals, the reported title
among them. All three variants read 69 of the 71 edits back, so what the wider
rules cost was fidelity only: a refused run still draws, in Helvetica, which is
a visible seam rather than a wrong glyph.

### A refused trace is the one OCR outcome the user has to be told about
The edit still lands - the run bakes either way - so nothing failed. What
changes is the FIDELITY: that one line comes out in Helvetica while every other
line on the page keeps the scan's own letterforms, and with no explanation that
reads as the editor having got the font wrong. `traceRunIntoFace` returns
`TraceResult { added, refused }` (the refusal is `lastCutReason()`), and
`commitEdit` in `OcrTextLayer` puts it in the status bar.

The alternative to refusing is tracing the wrong shapes, which renders the line
as nonsense while extraction still reads it correctly - the failure the sliver
note above describes. A visible seam that says why beats a silent one that
doesn't.

### The first SOURCE that answers wins - so a source must not answer badly
An order form draws the same "800.00" in three cells. The page stream holds ONE
of them; the other two are in a Form XObject. Editing any of the three rewrote
the page stream's copy - the wrong cell for two of them - reported success, and
truncated the replacement off the right edge of the paper. `char_delta` 5 on an
edit that should have changed nothing but its own cell.

Nothing was wrong with the block ranking: only one BT block on that source held
the value at all, so it won by having no competition. `replaceTextInStream`'s
source loop STOPS at the first source that returns an outcome, so the XObject
holding the clicked cell was never searched. A source that answers badly
therefore costs the answer entirely, and the only way through is for a source
with no plausible match to decline.

Two position bars do that, both inside `applyPartialBlockReplacement`:

- **The op-window guard covers every target length now**, not only three
  characters and under. A short target keeps the tight bar (it identifies
  nothing on its own, so position is all there is); a longer one gets
  `max(24pt, 3x the target's height)`, which is not a ranking term but a test
  for a window that is plainly somewhere else - another row, another column.
  The failing window measured 117pt from the click.
- **The in-array chooser REJECTS as well as sorts.** Distance only ordered the
  candidate TJ arrays; nothing dropped one, so once the op window was refused
  the array path applied the same wrong cell. `arrayTooFar` is one-sided in x
  on purpose: an array is wide and its ops are placed from its start, so one
  beginning to the LEFT of the target may well draw it further along, while one
  beginning to the RIGHT of where the target ENDS cannot. Vertically there is
  no such asymmetry - another baseline is another line.

Measured over three corpora, 1279 experiments (main 262, r3 466, r6 551): **0
gained, 0 lost, 3 changed**, and all three changed are the bug - `char_delta`
5 to 0 and 3 to 0 where a wrong cell was being rewritten. Each of the three
"800.00" cells now edits its own.

**Still not a sweep success**, and honestly so: the synthetic replacement
("SWEEPMARK47") is far wider than a numeric cell 90pt from the right edge, so it
runs off the page - the justified-line limitation already recorded above. What
changed is that the edit no longer damages a cell the user never named.

### The patch and the text must be placed in the SAME space
Editing a scanned line paints over the original ink (`fillRect`) and draws the
replacement on top (`addTextToPage`). `addTextToPage` has always mapped its text
matrix through the inverse of `pageRotationCtm`; the patch never did. On a
calibration certificate stored landscape and displayed portrait (/Rotate 90) the
text therefore landed correctly and the patch came out as a thin bar in a corner
of the page - so appending ONE character to "Within specifications (i)" left the
original line printed through the replacement, an unreadable doubled line whose
extracted text still read back perfectly. That combination - the page wrong, the
text right - is the signature of this whole family of bugs and the reason they
are so hard to report.

`fillRect` now composes both corrections: the /Rotate inverse, then the
inverse of the CTM the stream leaves in force (the pre-existing one, for the
unbracketed `0.36 0 0 0.36 0 0 cm` a scan's image is drawn under). A page with
no /Rotate produces exactly the matrix it produced before, so unrotated
documents are untouched.

**A baked replacement is also fitted to the run BESIDE it**, not only to the
paper. `fitSize` capped the size against the page edge; a base-14 face is wider
than most scanned ones, so a one-character append to a table cell drew straight
across the next cell on the same row and the two read back as one interleaved
run of nonsense. `nextRunRight` gives the nearer bound. It is deliberately
narrow: only a run whose left edge is past the MIDDLE of this one counts (the
detector's boxes touch and overlap a little) and only one sharing the line.

Measured with the OCR corpus' new ink re-read - the baked page is recognised
AGAIN and each edited run's ink compared with what was typed, because no
text-level assertion can see this class at all. Of the ten worst runs, the two
this fixes went from 0.23 and 0.00 similarity to 0.70 and clean; average over
34 edits 0.79; the seven still under 0.5 are separate leads on three other
documents.

### On a dark run the INK is the light side - both colours came out the same
`sampleLineColors` read the ink from the darkest fifth of a box and the paper
from the lightest. On a navy cover page, a slide's title bar or a table header
the glyphs are the LIGHT side, so the ink colour came back as the background's
own navy - and since the patch is painted in `background` and the replacement in
`color`, both were navy. Editing one character of a white logo made the line
DISAPPEAR: measured on an Ingenium cover page, the re-recognised bake read
nothing at all where the title had been (similarity 0.05 against what was
typed), and the page showed a navy rectangle.

The rule is the one `cutByProfile` already uses to decide whether to invert a
box before profiling it, at the same 0.42 threshold: text covers a MINORITY of
its box, so over half of it dark means the light side is the glyphs. Ink then
comes from the lightest fifth and paper from the darkest. Neither is ever read
from the middle of the distribution, inverted or not - those are anti-aliased
edge pixels, which are both.

The no-ink branch got the same treatment for the same reason: it returned black
whatever the paper was, so a colour picked there would have been invisible on a
dark band. It now returns whichever of black or white contrasts.

Measured: the reported logo edits to white-on-navy (colour sampled
0.87/0.86/0.83 against a 0.00/0.09/0.22 background) and renders legibly.

**Known limitation:** the detector's box for that 93pt logo is 88pt tall and
swallows the 28pt tagline beneath it, so patching the logo also paints over
"--Empresas y Gobierno". Splitting a patch around the runs it overlaps is not
implemented.

### Tried and dropped: choosing the binarisation threshold by piece count
A supplier form's "DOCUMENTOS ADJUNTO" traced as "DCCUMENTCS ADJUNTC": at the
0.42-of-range threshold the U's stems were severed from its bowl (four blank
rows across the cell, continuous at the midpoint). Three rules were tried in
turn and each is worth knowing about:

- **Midpoint when the biased cut keeps under 70% of the midpoint's ink** fired
  on nothing - a broken join is a negligible share of a box's pixels.
- **The same at 85%** fixed the U and broke a letterhead: on "AV. REPUBLICA DE
  CHILE" the midpoint FUSED "CA", "DE" and "LE" into single cells, the cut
  passed at exactly the 20% suspect bar, and the face drew a jumble.
- **Whichever threshold's count of connected pieces is nearer the character
  count** got both of those right and, applied to plain HEAD, RE-ADMITTED the
  misaligned title cut on the reported contract: the border fragment fused into
  the first letter, no sliver was left for the guard, and the title baked as
  "M EJIOR MMIEIR TM DR ..." - the original report, back.

The cause was upstream. `recognizePage` floored one canvas size and rounded
the other, so every page was resampled by one row and its whole raster
blurred by a half-pixel blend; the tracer read those pixels. With the 1:1
copy and the rule-span clearing in place, the piece-count rule changes
NOTHING on the three lines above (DOCUMENTOS traces at 1 of 17 suspect and
re-reads exactly, AV. REPUBLICA is refused at 10 of 50 and falls back, the
contract's title traces at 0 of 39 and re-reads exactly - identical with and
without it, measured on two isolated static builds). A second mechanism with
no measured gain and a demonstrated failure mode is not kept. The threshold
stays 0.42.

### Known limitation: a faint crossbar is lost at 220 DPI, so a traced "t" reads as "l"
Two unrelated forms both bake "Cta. Cte" as "Cla. Cle" in the scan face. The
cut is right - the "t" cell holds the stem - but at 220 DPI this blurred bold
face's crossbar is a ONE-pixel bump on either side of an 8px stem (measured on
the binarised cell, at the biased threshold and at the midpoint alike), and an
outline tracer smooths a bump that size away. Not a threshold problem: an
adaptive threshold (midpoint when the 0.42 cut discards over 30% of the ink)
was tried and did not fire, because a bar is a negligible fraction of a box's
pixels; reverted unmeasured. The "e" bar and "B" bars survive at both
thresholds. Fixing it means tracing from a raster at 2x the OCR resolution,
which the page rasters are not; not implemented.

The 110-document ink re-read (67 scanned-page edits, average similarity 0.94)
found no other class: the remaining sub-0.5 cases were the re-read matching a
neighbouring run, a miscount of "=" signs, and this one.

### A skewed table border is a rule for PART of a box, and the OCR raster was a blurred copy
The bilingual contract approval form (MSP-SIST-CS-2026-001, a scan signed
through Intellisign) edited its title into "MEJOR MIIIEI TAI DR IIIFORMAEDRUEROR"
and drew its amount line at 13.8pt where the neighbours are 10.3 - the edited
text then ran off the page in the inline editor. The sliver refusal above
turned the scramble into a Helvetica fallback, which is the honest failure;
this is what it took to make the line trace CORRECTLY, and there were six
defects in the way, each measured on the page.

- **The border is not level.** A scanned rule crosses a pixel row for 15-30%
  of the box's width and then leaves it, so the "inked across 80% of the row"
  test never saw it. Inside the box it did two things: it FUSED every letter
  column under it into one ink run (the title's first seven letters came out
  as one cell, and every cell after held the letter to its left), and it was
  counted as the top of the ink, so the box was ten rows too tall and the size
  followed (13.8pt for 9.6). What tells a rule from glyphs is not how much of
  the row it covers but how FAR it runs unbroken: `clearRuleSpans` blanks any
  contiguous span longer than two ems (2.5 in the glyph cut), and only the
  span, never the row. The em is GUESSED FROM THE TEXT - the box's width over
  the advances its characters are expected to take - because the height is
  the one thing the fragment inflates; a bar set from 1.5x the detector's
  padded height missed a 193px fragment on the very next line. A span cut off
  by the box's own edge gets 0.6 of the bar (46 columns of a 200-column rule
  showed).
- **The OCR raster was resampled.** `recognizePage` copied the 220 DPI render
  into a target sized by `Math.round` while the viewer sizes by
  `Math.floor`; one row of difference made `drawImage` blend every row with
  its neighbour across the whole page. That smeared the rule's fringe into
  crumbs no span test can see, and the tracer read the same blurred pixels.
  A canvas already within 2px of the OCR size is copied pixel for pixel.
- **A neighbouring line's tips inside the padded box** (the foot of the CJK
  line above, 18 px in the top row) made a 10pt line 15.8pt. `inkBounds`
  strips a band at either edge that is cut off from the body by three empty
  rows and holds under 1.5% of the ink, accumulating across smaller breaks
  (the crumbs a cleared rule leaves are several thin rows with single gaps).
  An accent band on a lowercase line is several percent and stays.
- **Two letters that touch are not split by their advances.** "EJ" was one
  20px run; the halfway cut fell three columns inside the E and the J cell
  carried the E's bar ends into the face - the J drew with a bar on top.
  `splitAt` takes the emptiest column within a fifth of an em of the
  proportional point.
- **The baseline is a LINE.** Letter bottoms drifted four rows across the
  677px title, so one median baseline set the left glyphs two pixels low and
  the right ones two high - a ragged line from good ink. `baselineOf` fits by
  least squares (outliers over 1.5px dropped once), `baselineAt(x)` places
  each glyph, and `flagByShape` de-tilts its extents with the same line: a
  capital "S" read as "s" at the low end of the amount line had passed the
  rise test by the tilt alone and every "s" on the line drew as "S".
- **The tracer takes its bitmaps from the cut's own cleaned `bin`**, never
  from the pixels again, so whatever the cutter removed stays removed.

Smaller things found on the same page: the end-sliver test skipped for thin
characters and CJK punctuation (a "." is a third of its advance, "。" a
tenth - every sentence on the page was being refused), thin cells suspect
only for being too WIDE (a 3px sans "I" against a want of 8 was never
traced), one-pixel column runs dropped (a border's fringe at the box edge
took the last cell), and a run 48pt or taller read under 70% confidence
dropped as junk (the red stamp came back as "maa b" at 116pt once the raster
was sharp).

Verified in the browser: the title edits to "…RED LAM" and bakes level in the
scan's own letterforms (15 glyphs traced, none refused), the amount line and a
prose line bake legibly, and the page's sizes agree with their neighbours
(9.5/9.6/11.4pt). Page-1 refusals are now all "N of M cells suspect" on the
bold touching lines, which fall back to Helvetica - a visible seam, never a
wrong glyph.

Measured on the 14-document OCR corpus (`public/_sweep/ocr`, 25 scanned
pages, 71 edits, HEAD baseline from a static build of `5da32a0`): edits read
back 69 → 70, runs traced in the scan face 24 → 27, cuts refused 40 → 36,
average ink re-read similarity 0.873 → 0.879. Two rows that were wrong at
HEAD are right now: a DNI's "REPÚBLICA DEL PERÚ" traced as nonsense
(similarity 0) now re-reads at 0.94, and a report's "Test Parameters at 1550
nm" that was refused AND not read back is traced at 0.94. The suspect bar is
now "a fifth or more": with one fewer suspect the RJ notice's address line
(10 of 50) was admitted and drew as half-height capitals; refused, it falls
back as it did at HEAD.

**Known limitation:** one 4-letter run ("Zone", 011.pdf page 3) went from
traced at 1.0 to refused at 0.2 in the sweep, with its box growing from 9 to
13.4pt; the page could not be re-inspected because pdf.js does not return a
render of that 79-page scan's page 3 within 90 s outside the sweep.

### A neighbour's letters behind a gap are dense; a cut border's edge column is one pixel
Second round on the same corpus, four measurement defects and one new cut:

- **The bold line above the RJ notice's address ends four rows inside the
  address's box** (200, 161, 112, 41 inked columns of 733), then three empty
  rows, then the address. The stray-band strip saw the gap and refused the
  band for being dense — it was written for crumbs. Density is exactly what
  tells a neighbour's letters (27% of the width in a row) from an accent or
  an "i" dot (2%): a short band (a quarter of the body at most) that is dense
  (a row over 15% of the width), on a box at least four ems wide, leaving a
  body half an em tall, is stripped. The address's box now starts 1.3pt
  BELOW the line above instead of inside it, its patch no longer shaves that
  line, and its em is no longer taken from a box four rows too tall.
- **Punctuation descends a tenth of an em, a "g" a quarter.** `DESCENDERS`
  put commas and semicolons with the letters, so an all-caps address with a
  comma in it ("262,08 (OCTAVO PISO)") was read as 0.95 of an em tall and
  sized 7.6pt beside a 10.3pt line in the same face. `boxPerEm` gives a
  punctuation-only line 0.85; the glyph cut's em uses the same three ratios.
- **A rule is THIN.** The span bar (two ems, from the text's expected
  advances) is small on a short bold word: "Detracción" at 19px per em has
  60-column spans in every row of its x-height band, and cleared row by row
  as "rules" the box had no ink left to measure — `inkBounds` returned the
  detector's box untouched, 15.1pt for a 6pt word. `clearRuleSpans` now
  measures a span's thickness (rows carrying ink over 70% of its columns) and
  keeps anything thicker than a quarter of the em; spans are judged on the
  original bitmap and blanked afterwards, or one row's clearing thins the
  band the next row is measured against.
- **A row with one pixel is not a glyph row.** The same box's left border is
  three columns wide and only two of them are inked down 80% of the box; the
  third left one pixel per row, and `trimProfile`'s floor of one pixel kept
  nine empty rows above the word. The floor is two.
- **Tesseract's glyph boxes as a second cut.** Half the corpus's refusals are
  "letters touch": PaddleOCR gives one box per line and the column profile
  cannot separate letters that share ink. When the profile cut refuses a run
  without glyph boxes, `traceItem` crops the run (0.6 of its height of margin)
  and reads it once more with Tesseract for its symbol boxes ALONE — its
  reading must have the same non-space count and agree on four letters in
  five, or the boxes describe another line — and cuts again on those. Engine
  boxes go through `vetCells`, the same width, shape and sliver checks a
  profile cut gets; the Tesseract-engine path was tracing its boxes unvetted
  before this.

Chasing the first run the fallback admitted — the 35pt underlined
"MINERA SHOUXIN PERU S.A." of a CamScanner PDF — found four more things, each
visible only in the traced OUTLINES (draw `face.glyphs.get(ch).path` on a
canvas; the baked render and the re-read both looked plausible):

- **A tilted rule is a CHAIN of short spans.** The underline crossed the box
  diagonally, 120 columns per row where the bar was 270, so no row on its own
  was a rule; it stayed, the baseline was fitted through it and every glyph
  hung above its own baseline with a piece of the underline for a foot.
  `clearRuleSpans` now takes every thin span of a third of the bar as a
  candidate, joins candidates in adjacent rows that overlap in x, and judges
  the chain's extent. Lowering the candidate length to an eighth (for a rule
  at 28 columns per row) chained the tops of the letters it crossed into it
  and shaved them — reverted; that rule stays, see the height guard.
- **Rule thickness needs 90% overlap, not 70%.** The bottoms of a heavy caps
  line sitting on its underline cover two thirds of the underline's columns
  and, counted as part of it, made the rule "thick".
- **A cell's bottom needs a few pixels, not one.** `cellExtent` counts a row
  only with two pixels and a sixth of the cell's densest row; the fringe of
  an underline put a pixel under most letters and each cell ended in it.
- **Nothing below the baseline belongs to a letter that does not descend.**
  `cellBitmap` cuts a non-descending character's bitmap at the fitted
  baseline; a descender keeps what hangs below. And the letters must FILL
  their box: when the second-tallest cell is under 55% of the box's height
  the box holds something else (a rule through its top) and the em from it
  is inflated — the run is refused rather than traced at half size beside a
  full-size fallback glyph.

`stripEdgeCrumbs` (specks under 3% of a cell's ink, thin pieces hugging a
cell's side) and a one-to-three-column erosion where two cells touch also
went in; neither was what this line needed, both are cheap and safe.

**The Tesseract fallback is gated hard, and the sweep is why.** Admitted at
the profile cut's bar it traced a 6-letter "MINERA" as nonsense (re-read
similarity 0 against 0.83 in Helvetica) and a 4.7pt "Escaneado con
CamScanner" watermark at 0.67, for one good line; the corpus average went
DOWN, 0.899 to 0.880. Engine boxes are now accepted only with NO suspect cell
(one box straddling a join means the engine misread the segmentation), for
runs of eight characters or more with 20px or more of ink, from a line
Tesseract read at 85% or better. Measured after the first two gates: 71/71
read back, 28 traced, 0.892; the watermark was the one fallback trace left,
hence the height gate.

Round by round on the 14-document corpus (71 edits): HEAD 69 found / 24
traced / 0.873 → round 1 (rule spans, 1:1 raster) 70 / 27 / 0.879 → round 2
(neighbour bands, em ratios, thickness, one-pixel floor) 70 / 27 / 0.899 (with
one transient page) → round 3 (chains, cell extents, loose fallback) 71 / 30
/ 0.880 → round 4 (gated fallback) 71 / 28 / 0.892 → round 5 (fallback
height gate) 71 / 27 / 0.896. In round 5 every row under 0.6 is a base-font
fallback except "15-09-2021" at 0.27, whose dashes the re-read miscounts; the
others are the known ones — the "EL EGO" 170pt cover title (2 of 5 cells
suspect), "Zone" on the 79-page calibration scan, "distance", "Detracción".
No traced row reads back under 0.85 apart from that date.

### Only the CHANGED stretch of a scanned run is redrawn; the rest keeps the scan's pixels
The export used to paint over a run's whole ink box and draw the whole new
text again, so every word the user never touched was replaced — by a traced
outline, or by Helvetica for the half of all runs whose cut refuses. A scan's
own pixels are the most faithful rendering of its words there is.
`partialRedraw.ts` keeps them:

- **The glyph cut is made at COMMIT time and kept** (`useOCR.spanCuts`, keyed
  by item id, in points so it outlives the raster LRU): where each letter of
  the ORIGINAL text sits, the fitted baseline, the median letter and word
  gaps. `traceItem` now always cuts, even when every glyph is already in the
  face, and hands the cut to `traceRunIntoFace` (new `precut` parameter).
- **What changed is the common prefix/suffix** (`commonAffix`, shared with the
  tracer's `trustedCells` so the two agree). `planPartial` places the new
  stretch at the old span's start (or after the head plus the measured gap),
  on the fitted baseline, at the em measured on the LETTERS — and decides:
  **fits** (the tail keeps at least 40% of the gap before it, or the gap opens
  by up to a space) → patch the old stretch only; **shift** → the untouched
  tail's pixels are transplanted (cropped from a fresh 300 DPI render of the
  pre-bake page in `bakeOcrEdits`, drawn with `drawImageInContent`) by exactly
  the width difference, when it will not run into the next run or the page
  edge; otherwise the whole-run redraw as before, with the reason in
  `plan.modes` / `window.__ocrBakeReport`.
- **Widths are measured in the engine with the fonts that will draw them**
  (`measureRuns` → `measureRunWidth`, sharing `segmentRun` with
  `addTextToPage`), never estimated: a 10% guess on a ten-letter stretch is
  several points, enough to call "fits" wrongly.
- **The em comes from the letters, not the box.** `cutGlyphs` now returns the
  median capital height / 0.72 (or x-height / 0.52) as `emPx` when it can: the
  box's height is what a crossing rule inflates, and an em from a box 82 rows
  tall around 46-row letters drew a fallback "C" beside them at 1.7× their
  size. Both the traced face's scale and the partial size use it, so traced
  and fallback glyphs agree.
- **The unchanged words go back into the page as INVISIBLE text** (`addText`
  `invisible` → `3 Tr`, in q/Q because render mode outlives ET) at their ink
  positions, or only the stretch would be text and the line would no longer
  extract, copy or search as one.
- **`drawImageInContent` now applies the same two corrections as `fillRect`**
  (the /Rotate inverse and the inverse of the CTM in force where it appends);
  written raw, the transplanted tail landed elsewhere than its patch on the
  MSP scan, whose stream leaves an unbracketed `cm` in force. Prepended images
  get only the /Rotate inverse: nothing has run yet where they are written.
- A drawn run is `baked`: its glyph cut is forgotten and neither a partial
  redraw nor a trace is made from it again until the page is recognised
  afresh — the raster under it is a patch and new text now. A run whose style
  or place the user changed is `restyled` and takes the whole-run redraw.

Verified in the browser: 005.pdf "PERU → PERO" patches only the U and draws
the traced O on the neighbours' baseline (bottoms at the same row, measured);
"S.A. → S.A.C." draws only "C."; "PERU → PERUANA" shifts "S.A." right as
pixels. MSP: "DE LA NUEVA INFRAESTRUCTURA" shifts the tail through the
stream's `cm`, "204,754.68 → 304,754.68" redraws the one digit. Corpus, fits
only (no shifting): 71/71 read back, average re-read similarity 0.896 → 0.902,
the dashed date 0.27 → 0.73 because its digits are now the scan's own pixels.
The sweep's `traced` count (font of the block holding the edited text) is no
longer meaningful — that block is the invisible head now.

Two smaller fidelity changes went in with it:

- **Letter spacing from the scan.** A traced glyph's side bearings were a
  fixed twentieth of an em; `traceRunIntoFace` now uses half the run's median
  inter-letter gap (adjacent trusted cells with no space between, clamped to
  0.02–0.12 em), so traced text sets at the scan's own spacing — the fixed
  value set a heavy 35pt title visibly looser than its neighbours.
- **Tracing from a 2× raster.** Recognition is happy at 220 DPI; Potrace is
  not — a bold face's crossbar is a one-pixel bump there. `useOCR` borrows the
  layout's renderer (`setPageRenderer`) and renders the page again at 440 DPI
  the first time a run on it is traced (`traceRasterFor`, one page kept, ~72 MB
  at Letter, capped so no canvas side passes 16 000 px); the cut, the face and
  the Tesseract glyph-box fallback read that raster, everything downstream
  being scale-relative. The raster is dropped when the page is recognised
  again, after a bake on it, and on reset. Where the layout lends no renderer
  the OCR raster stands in — and where the finer raster's cut REFUSES: the
  cut's pixel floors were calibrated at 220 DPI, and a 35pt line that cuts
  21/3 there came back 21/5 at 440; refusing it would have cost the partial
  redraw too, so the tracer falls back to the OCR raster for that run.

Corpus after all five steps: 70/71 read back, average re-read similarity
0.896 → 0.918; last-page bakes 28 whole / 13 partial / 1 shift. The one
text-layer miss ("CUMPLIÓ: (FINANZAS)") re-reads at 1.0 — MuPDF orders the
invisible head and tail and the visible stretch as separate blocks, so the
page's joined text can interleave; the page itself is right. Known: a wide
cell from a touching pair gives its traced glyph a wide advance ("AN A" on the
35pt title) — the gap is measured per run, not per glyph.

### Which ink runs make a letter is a question of WIDTH, not of gap
The glyph cut had too many ink runs for the title "CONTRATO DE PRESTACIÓN DE
SOLUCIÓN INTEGRAL" (a bold underlined scan: a broken T, a broken S) and merged
the pair with the smallest gap until the count matched. The tightest gap on
the line was the 3px between an intact "R" and an intact "A", not the 5px
inside the broken S — so RA took one cell and every cell after it held the
letter next door at a plausible width and, on a line of capitals, a plausible
shape. Seven cells flagged of 38, under the one-fifth bar; the face learned
"A" from a T, "D" from an E, "E" from a P, and the line rendered as
"CONTETTO EP REPSTTĆIÓNNN EP SOLUCIÓN INTPGETL" while extracting perfectly.
At 220 DPI the same cut happened to flag nine and was refused; at the 440 DPI
tracing raster it passed — which is why the finer raster made this WORSE.

`alignRunsToChars` replaces the gap merge for Latin runs: one least-squares
alignment over widths in which a run may take several letters (they touch)
and up to three adjacent runs may make one letter (it is broken), each merge
costing a little. R+A is 1.4 em against a want of 0.65, so the fit refuses
to join them whatever their gap. Ideographs keep the gap merge — their
radicals are separate runs by design and the corpus's Chinese lines trace
with it. Two guards were added alongside:

- **A fused cell and a sliver bracket a shift.** In `vetCells`, a cell over
  1.6× its letter's width paired with a sliver elsewhere on the run marks
  every cell BETWEEN them suspect, whichever order they come in. The two ends
  were each flagged already; the cells between are what the face learns wrong.
- **`debugCuts(item)`** on the OCR composable reports the cut on every
  raster — 220, 440 and Tesseract's boxes — with the raw ink runs
  (`lastCutDebug`), for the harness. The trace uses the 440 cut when it
  passes, so `cutFor` (220 only) cannot show what was traced.

**A merge must be between NEAR pieces.** Left free, the fit joined a 3px
speck 17px (a third of an em) from the next run and called the pair the
"M" of a logo — the run was the mark beside the word — then traced the
logo's shapes as letters (007.pdf "MINERA", re-read similarity 0.2 against
0.83 in Helvetica). No merge across more than 0.15 em; the speck then has to
be a letter on its own, is a sliver at the run's start, and the cut is
refused as misaligned, which is what it is.

Measured on the title: both rasters now cut 38 cells with 2 suspect (the two
accented Ó), the traced face reads C O N T R A D E P S I L U G correctly.
Corpus (now 15 documents — the INTEGRATEL order joined it — 26 scanned
pages, 74 edits): 71 read back, average re-read similarity 0.911. Over the
original 71 edits: 68 read back, 0.908, against 70 and 0.918 before. Every
row was inspected: the two newly not-found rows are "Test Parameters…" on
011/012, whose ink re-reads at 1.0 (the extraction-order limitation of the
invisible head/tail, moved by a slightly different cut); "ENEMIGO" 1.0 → 0.86
twice is the re-read dropping the last letter of a Helvetica-Bold whole-run
redraw on a navy cover (the bake was inspected and is right, as is the traced
"EL GO" beside it); "15-09-2021" 0.73 → 0.91 and "COMPROBANTE" 0.42 → 0.92
are gains. No traced run reads back wrong.

### The detector's box stops at the BASELINE, and everything downstream believed it
The same contract's body lines all fell back to Helvetica, and a quarter too
small. PaddleOCR boxes a line of small body text at its baseline, and
`inkBounds` only ever measures INTO the box it is given, so every p, q and g
had its descender outside the box: `boxPerEm` read the box as 0.95 em of a
7.6pt line where the letters were 10pt, the whole-run replacements were drawn
at 7.6, and `flagByShape` marked every descender as not descending — 18 to
29 of 80 cells on lines whose cut was right. `extendDescenders` walks DOWN
from the tight box through rows that hold a stem's worth of ink and stay
sparse (under 15% of the width), up to 0.35 of the height, and stops at the
first empty or dense row. Two things it must not do, both tried:

- **Pad the probe and let `inkBounds` trim.** On this leading a line's
  descenders touch the next line's ascenders, so a probe padded 0.4 of the
  height each way came back holding a line and a half: 7.2pt boxes became
  14.7, the title read 19.8pt. The walk must STOP at the gap, not cross it.
- **Ask for a share of the width per row.** Four descenders on an 81-letter
  line are six pixels at 220 DPI; one percent of that line's width is
  thirteen, and the walk stopped on its first row. A stem's worth is two.

Three more things stood between these lines and the face, each measured on
the same page:

- **`expectedAdvance` is a per-letter table now**, the mean of Helvetica's
  and Times-Roman's AFM widths in ems (`ADVANCE_TABLE`; accents folded onto
  the base letter). The four buckets it replaces put "p", "s" and "e" at one
  width, and on a Times-like scan whose letters touch, cells are cut and
  vetted BY these expectations — every "s" and "e" beside a "p" was the wrong
  width.
- **A dotted i and an accented vowel RISE.** They were in `X_HEIGHT_CHARS`,
  so on a Spanish line every i, í, á, é, ó, ú and ñ failed the shape test
  (rise 0.45–0.52 against a bar of 0.3) and pulled the x-height median up.
  `MARKED_X_HEIGHT_CHARS` may rise and must not descend.
- **The Latin fragment budget is half the characters**, not a third: at 440
  DPI a typewriter serif breaks at its hairlines (113 runs for 81 letters).
  Under the gap merge a bigger budget bought wrong merges; under the width
  fit a merge that does not improve the fit is not made.

Measured on the contract page: ten probed lines — the title, the code, eight
body lines of 75–89 letters — all cut cleanly on the tracing raster (0–4
suspects each, was 17–74) and size at 9.3–10.3pt. Corpus (15 documents, 26
scanned pages, 74 edits): 71 read back, average re-read similarity 0.918
(was 0.911 before this round), 38 of 74 cuts accepted against 27. Every row
under 1.0 was inspected or is a known one: the 009 cover's re-read noise, the
calibration scan's "distance"/"Zone" cells, "Fecha de transferencia",
"CUMPLIÓ" and "Test Parameters" (extraction order of the invisible head), the
dashed date. Two new rows are new picks on the Ingenium report's page 2 (the
items' sizes changed, so `pickRuns` chose other runs).

**The sweep's re-read matches boxes by IoU, not by overlap.** The 93pt logo's
re-read box CONTAINS the 16pt tagline under it, so by overlap alone the
tagline's edit was scored against the logo's text (0.11) while the tagline
itself had been traced correctly — a measurement artifact that read as a
regression for a whole round.

**A gap inside a word is a typo, not a fit.** `planPartial` called a stretch
"fits" when the tail's gap opened by up to a space's worth — right between
words, wrong inside one: deleting the "e" of "presente" left "pres nte" on
the page and extraction put a space in it. With no space on either side of
the change the tail may open by a letter gap and a hair; past that it is
shifted onto the vacated ink. Measured: "presnte" and "Rgistro" bake closed
up (partial+shift) and extract as typed.

### A partially redrawn line is ONE text object, on ONE baseline, at the ink's WIDTH
The partial redraw put a line back as three text objects — invisible head,
visible stretch, invisible tail — and MuPDF listed the visible "X" BEFORE the
line it belonged to, so an edited line no longer copied, searched or read back
in order ("Test Parameters", "Las partes que X", the sweep's `found` misses).
Three things, each measured on the CLARO order's "Las partes que" row:

- **One text object.** `addTextRun` (worker `addTextRunToPage`, bridge,
  `usePDFEngine`) writes every part of a `TextOp.group` inside one BT, `Tr`
  and colour set per part and the whole bracketed in q/Q. Inside one BT the
  characters are in reading order whatever their render mode.
- **One baseline.** Each part sat on the fitted baseline at its own x, and on
  a scan tilted 0.7° that put the head 0.8pt from the stretch sixty points
  away — `splitBlocksAtGaps` reads a step that size (over 8% of the size) as
  a new line, sorted by y, so the "X" came first even inside one BT. The
  invisible parts take the stretch's baseline: they have no ink to sit
  anywhere.
- **The ink's width.** An invisible run is set in Helvetica (or the CJK face,
  Latin letters included), whose advances are not the scan's: set naturally
  it ended 20pt short of the letters it stood for and extraction read the
  difference as a space ("Prove dor"). `TextRunPart.fitWidth` scales the
  advance with `Tz` to the span of ink the part stands for. The width it is
  scaled FROM has to be exact: `measureRunWidth` counted every character of
  a CJK-fallback segment as an em (11 ems for "(承包商 Prove", drawn as 7)
  and now reads the loaded face's own advances.

And the letter gap that places a shifted tail is measured between LATIN
neighbours only: the three ideographs on that row pulled the median to 4pt
at 9pt and a tail shifted by it left a space inside "Provedor".

Measured: the row extracts as one block, "Las partes que X (承包商
Provedor): AMÉRICA MÓVIL", spaces where the page has them and nowhere else.
Corpus: main 72 of 74 read back (was 71; "CUMPLIÓ" now in order), 0.915;
the second corpus (ten recent Downloads scans: the CLARO and LIDERA orders,
a work order, the fixed-asset reports, a quotation — `public/_sweep/ocr2`,
gitignored) 33 of 33 read back (was 30), 0.995.

### The OCR raster comes from MuPDF, not pdf.js
pdf.js took over 90 seconds — measured, it never finished — to render one page
of a 79-page calibration scan (CCITT fax and JPEG images through
iLovePDF/PDF24, /Rotate 270) at 220 DPI, and with it the OCR button did
nothing on that page; in node, MuPDF draws the same page in 32 ms.
`renderPixmap` (worker → `MuPDFBridge.renderPixmap` → `pdfEngine.renderPageBitmap`)
renders a page through `Page.toPixmap` with /Rotate applied, as pdf.js's
viewport applies it, and hands the RGBA back transferred. `renderForOcr` in
`EditorLayout` uses it for the recognition raster, the 440 DPI tracing raster
and the bake's 300 DPI tail crops, with pdf.js as the fallback when MuPDF
cannot. pdf.js stays the viewer. Measured in the browser on that page: the
raster in 59 ms, recognition in 13 s, and a first-word replacement
("Test" → "tseT") bakes and extracts as one line. The two rasters are
indistinguishable at the pixel level on a Word-scan page (recognition 62 runs
at 96% against 60 at 98%, Paddle's own noise); corpus after the switch: main
72 of 74 read back, 0.917, 45 of 74 cuts accepted (was 38); second corpus
33 of 33, 0.950 — two rows on the OT-GA order's page 4 dropped, both 6pt
table cells whose Helvetica redraw overruns the cell (see below).

### A split with no valley is the middle of a glyph, and a table's rows can be a line apart
Three defects on the OT-GA order's page 4 (a 4.5pt table set at 5.2pt leading,
grey ink), each visible only in the baked pixels:

- **The row above came along in the box.** `trimProfile` stripped a dense
  band behind a clear gap only when it was under a quarter of the body's
  height; here the bottom HALF of "ELABORACION" sat in "MODALIDAD"'s box —
  five rows against a ten-row body — so the box read 5.9pt for 3.3pt of
  letters, the em 7.8pt for 4.6, and the redraw painted over the row above
  and ran into the next cell. A dense band behind a gap is a neighbouring
  line up to 0.8 of the body's height; accents and dots never reach the 15%
  density that makes a band dense, so they stay.
- **A split through a glyph.** Two letters that touch meet at a VALLEY, a
  column with a few grazing pixels. On "50.00" the faint full stop fell
  below the threshold, the width fit gave the fused "50" three letters, and
  the "." cell — the right half of the "0" — went into the face as the full
  stop and the left half as the "0" ("$695.13 X" baked as "S69!:· X").
  `cutByProfile` marks both sides of a split whose column carries half the
  run's typical ink or more.
- **The ratio test counted only its own flags.** The cutter's marks did not
  reach it, so "$695.13" traced at three of seven suspect. `vetCells` now
  counts every suspect cell before the bar.
- **Sixteen pixels of em is the floor.** A 5pt line at 220 DPI has one-pixel
  stems and loses its punctuation to the threshold; whatever raster reaches
  the cut, an em under 16 pixels refuses ("too small to trace").

Measured: "MODALIDAD" boxes at 3.3pt and its replacement sits inside the
cell; "$695.13" refuses on both rasters and bakes in Helvetica-Bold with the
status line saying why. Corpus: main 72 of 74, 0.915, 44 cuts accepted
(one fewer: a run the valley test now refuses); second corpus 33 of 33,
0.968 (was 0.950). The "MODALIDAD" row itself scores 0 in the sweep because
the re-read cannot detect 4.3pt Helvetica at 220 DPI — the crop shows it
drawn in its cell; the metric, not the page, is at its floor there.

### A box of two stacked lines is two runs, and a run's WIDTH is the size that cannot lie
A table header set as "IMPORTE" over "PAGADO SOLES" came from the detector
as ONE box 13.7pt tall, and the whole-run redraw drew "PAGADO SOLES X" at
14pt across the two lines and off the page edge (the sweep read back "PAGA").
Three things, on the payment-order corpus file:

- **`inkBands`** finds the horizontal bands of ink in a box (rows with a
  stem's worth of ink, separated by two or more empty rows, rows inked
  across 60% of the width — a border — counting as empty). Two or three
  bands each at least a quarter of the box become their own pieces in
  `refineLines`, RE-READ like a cut piece. The words are shared out by count
  only as the fallback for a band that reads as nothing: a guard that kept
  the share unless the re-read resembled it was written and reverted the same
  hour, because on this very cell the shares were "PAGADO" / "SOLES" and the
  re-reads "MPORTE" / "PAGADO SOLES" — right, and rejected.
- **A border's fringe comes off the box.** A scanned rule is grey and blurred,
  and its blur reaches the letters with no empty row between; `trimProfile`
  strips end rows holding under a quarter of the densest row's ink unless
  that ink is a few narrow stems (a descender, an accent).
- **`fitSize` caps the redraw by the run's ink WIDTH.** Height is what a
  tilted line, a joined border or a two-line box inflates; width is not. The
  original words in the base-14 face at the box's size should be about as
  wide as their ink; a quarter wider or more brings the size down to match
  (never below six tenths). "PAGADO SOLES" went from 9.5pt to 6.5pt and sits
  in its cell.

Two guards keep the split off boxes that are not stacked headers, each
learned from a regression the sweep showed: the bands must be of similar
height (within 2×) and the box must be tall for its text — at least 1.8 lines
by the em its width implies — with a word for every band. A 93pt logo whose
letters break into two row bands, or a cover title with a line of small print
below it, was being split and re-read WORSE ("Ingenium" → "Inaenium"). And the
fringe trim is confined to boxes under 40px and four rows: on the logo it ate
the rounded tops of the letters row by row.

Corpus: main 74 of 74 read back, average 0.959 (was 0.915), 42 cuts
accepted; second corpus 33 of 33, 0.966. Drawing sheet pieces under 20px at
2× was tried for the 11px bands and the detector then found nothing in them;
1:1 stays (the hook remains in `recognizeSheetOnce`).

### A scan signed through a stamping service still has "text" — judge it by COVERAGE
`judgeScanned` counted characters: over 12 and the page was a text page. An
Intellisign-signed scan carries the service's ID strip — one 8pt line at the
foot of the page, drawn once per signing pass, 34 copies — so the scanned
contract page had 1768 characters of "text", the edit tool listed 34
unreachable blocks (their shuffle extracts as `IIIIIIInInnInnIInnn…`), and
recognising it took the OCR button and a confirmation. `textLayerOf` in
`EditorLayout` measures how much of the paper the text blocks cover, as a
UNION over a 64×64 grid so the 34 stacked copies count once; under 2% is a
stamp, a footer or a page number whatever its character count, and both
`isScanLikePage` and the OCR button take the verdict. Measured on the order:
pages 1–2 (real text, 2500+ characters) stay text pages, pages 3–5 (the
scanned contract) are scans.

### A traced glyph's weight is the STROKE's, its holes are the cut's, and its edge is a cell border's
The comparison sheet the user showed (OT-GA-2026-036, page 3: "CUADRO" →
"CUADROO", "COSFESA" → "COSFEEESA", "DE" → "DEee") baked its inserted
letters visibly thinner than the scanned letters beside them, and previewed
the title a quarter too large. Measured on the 440 DPI raster, the cut's
0.42-of-range threshold traced those three lines with 9–18% less ink than
the page holds (traced area over grey mass 0.91, 0.85, 0.82), and on the
serif title no single level could work at all: the U's right stem and the
A's left leg are hairlines at a third of the stems' darkness on a ~150 DPI
scan — invisible at 0.5, while 0.3 turned every stem into a slab. The trace
lab (`tools/ocr-calibrate/trace-lab.mjs`, MuPDF + the real `glyphCut.ts`
in node, ASCII bitmaps) is what showed each of these; a baked render at 300%
shows only that "something is off".

`cellBitmapTraced` now traces from the DARKNESS, not the cut's bitmap:

- **Level as a share of the local peak.** Ink where darkness ≥ share × the
  peak within three pixels (`traceLevel` picks the share so that the run's
  traced area equals its grey mass — blur conserves ink — held to
  [0.35, 0.65]), never below 0.15 absolute, only where the peak reaches
  0.25. A hairline peaking at 0.3 keeps its own width; a saturated stem gets
  the mass-conserving contour. A piece with no pixel darker than 0.55 is a
  neighbour's ring or the paper's grain and is dropped.
- **Sampled at 2× through a smoothed field.** A scan drawn at three times
  its own resolution is a field of 3-pixel plateaus, and a contour through
  plateaus is a staircase whatever the level. A 5-tap binomial (σ ≈ 1) from
  48 px of em, 3-tap below — σ = 1 fills the two-pixel counter of a 6pt bold
  "e" — then bilinear sampling puts the contour between pixels.
- **The cut's SMALL holes stay holes.** The level fills a counter the blur
  has half filled: the 6pt bold "e" was a blob. A hole in the cut bitmap
  under a fifth of an em keeps the cut's outline; an O's counter takes the
  level contour like the outer edge.
- **A tall narrow piece on the cell's edge is a cell border**, in the cut
  (`stripEdgeCrumbs`) and the trace alike: the grey rule beside the "C" of
  "CONTRATO" held a third of the cell's ink — over the crumb rule's quarter —
  and every C on the page read back as "IC". A stem on a glyph's edge (E, L,
  B) is joined to the rest of it; a lone stem (I, l, 1) has a cell no wider
  than itself.

- **Darkness is stated against the PAPER, not the box's lightest pixel.**
  On an identity card's teal strip the lightest pixel is a white speck, the
  teal reads a third dark, and to a stroke-relative level a third-dark field
  is a faint stroke everywhere — "CONSTANCIA" traced as ten solid blocks
  (`binarise` now subtracts the median darkness of what the cut did not call
  ink, and rescales). On white paper that median is a few hundredths and
  nothing changes; the sweep's "1 → 0" on that row is what found it.

Two things around it, found on the same page:

- **The run's size is the LETTERS' em from the commit on** (`traceItemNow`
  adopts `sizeOf(item, cut)` into the store, `restyled` runs excepted, and
  chooses the face AFTER — the face is keyed by size). The preview and the
  properties bar showed 12.1pt over a 9.8pt title while the bake, which
  already used the cut, drew 9.8.
- **`extendAscenders`** — PaddleOCR clips a line of 6pt body text at its
  x-height top as it clips it at the baseline. On the sheet's paragraph the
  box held ONE row of the L, d, l, t with seven above it; the em read 6.2pt
  for 7.7 and the cut flagged every ascender as not rising (22 of 83 cells),
  so the whole paragraph fell back to Helvetica. The walk up takes sparse
  rows of a stem's worth (dense = max(15% of the width, risers × height /
  5), a run no wider than the box is tall, no more runs than risers + 2), and
  is bounded by the box's own top row: ascenders THIN OUT going up where the
  line above gets denser, so a row over twice the head row's ink is the
  neighbour's. The head row is counted in the SAME profile as the band
  (each profile binarises at the midpoint of its own range — a three-row
  head measured alone read 227 pixels against 6). The descender walk got a
  two-row tolerance for the box's own blurred bottoms (a 113-pixel row of
  letter bottoms was "not stems" and the four rows of descenders under it
  were never reached); the ascender walk deliberately has none — the fringe
  trim keeps a few narrow stems, which is what ascender rows are.

**Known limitation:** a box that already holds the previous line's descender
tips (two stamped ID lines 0.7pt apart) keeps them; the walk refuses to make
it worse, it does not make it right.

Measured against HEAD baselines run in parallel (separate Playwright
contexts), with everything in this session's commits in place:

| corpus | docs | edits | read back | cuts accepted | avg re-read |
|---|---|---|---|---|---|
| main (`public/_sweep/ocr`) | 15 | 74 | 74 → 74 | 42 → 46 | 0.959 → 0.957 |
| ocr3 (never-swept Downloads scans) | 30 | 160 | 157 → 159 | 94 → 99 | 0.875 → 0.927 |
| ocr4 (second batch) | 30 | 141 | 140 → 140 | 85 → 91 | 0.933 → 0.922 |

The tracer changes on their own are row-for-row neutral on this metric
(0.959 → 0.959): a re-read cannot see stroke weight, which is why the lab
exists. The ocr4 loss is three rows: a notary's script logo "Notaria" (both
boxes wrong — the old one held the quill and a header line, the new one the
x-height only) and a card's "CONSTANCIA" whose bake is inspected below.

### Whether a run is light-on-dark is decided on a PADDED box
`sampleLineColors` decided "the glyphs are the light side" when over half of
the box was dark. Inside a TIGHT box around small bold text the ink IS the
majority: "COD PAGO: 419500" at 5.6pt bold on a payment slip sampled as white
ink (0.9996) on white paper, the replacement was drawn white on white, and the
label vanished from the page while extraction read it back perfectly — the
sweep scored it 0 with nothing in the status bar to explain. Six of the ocr3
corpus's sim-0 rows had this shape ("ASUNTO:", "AGENTES DE ADUANA…",
"METODOLOGÍA", "Contrato de").

Two attempts to read the SURROUND instead were measured and dropped. The bands
above and below the box ("the lighter band decides"): a cover's orange
"efectiva" sits between two orange rules, so both bands were light and the red
became the ink. The box's own side columns as a tie-break: a tight box's sides
are the first and last letters' stems. What holds is the original majority
rule on a box padded by a third of its height above and below and a sixth of
its width to each side — enough paper (or band) to outvote the letters, too
little of a neighbouring rule or header to outvote the paper. Verified on the
slip (0.01 on 1.0), the red cover (orange 0.96/0.53/0.07 on red), the navy
cover (white on navy), an identity card's teal strip (its text really is dark
on teal), and a scan with a genuinely inverted table cell (light digits on
black — right, and the reason a "1 → 0" row in the sweep was not a bug).
### Two lines that touch are told apart by the trough between them
A logo's "MINERA" over its "SHOUXIN" (ocr3/016) kept the tops of the line
below inside its box: the rows between the two held two pixels each — a
speck, a fringe — so by the empty-row test (`< minRow`, and minRow is 2) there
was no gap, the box read 7.5pt for 4.9pt of letters, the em 9.9 for 6.5, and
the traced M was half an S ("MINRA" baked as slashes). `trimProfile` now reads
a dense band at the box's edge as the neighbouring line behind QUIET rows
(under a tenth of the box's densest row) as well as behind empty ones, and —
on a Latin line only, because an ideograph's own strokes make dense bands with
dips between them — behind a two-row DIP under three tenths of the peak when
the band itself reaches half the peak. The width guard is three ems, not four:
a six-letter word in caps is 3.9 ems, and the density test already keeps an
accent band out. `extendAscenders` drops a band that ends against a dense row
(the previous line's baseline): the second of two stamped ID lines had taken
five rows of the first line's descenders and fringe, sparse stems all, and
stopped at its baseline — exactly the wrong five rows. Whether a walk or a
trim did what it did is readable in the lab (`MODE=box`, `lastWalkDebug()`),
which is what found both.

The word's cut is then refused honestly ("widths do not fit the letters") and
"MINRA" bakes in Helvetica-Bold at 6.5pt over an intact "SHOUXIN".

**A thin band behind a clear gap holding little of the ink is a border's
fringe.** The stray-band rule kept any band worth over 1.5% of the ink as
"an accent or an i-dot"; a cell border's blurred fringe (3, 6, 8 pixels, ten
empty rows above "MPORTE" on a payment order's header, 7, 4, 3, 3 under
"PAGADO SOLES") is 3%, and each box read 8.5pt for 4.7pt of letters. A band of
four rows or fewer behind three empty rows, under a tenth of the ink, is
stripped: an accent sits a row or two above its letter, never three empty
rows away. PaddleOCR's boxes for that header differ from run to run (one
two-line box, or two overlapping one-line boxes), so the band-split path and
this path both have to get it right.

### The whole-run redraw is fitted by the width the engine will draw
`fitSize` sized a redraw against the paper and the run beside it with
`approxWidth`, half an em per character whatever the face. A letterhead's
calligraphic "中國銀行" traced beautifully, and appending " X" drew the X across
the "秘鲁" beside it: the traced glyphs advance a full em each, 120pt for the
run where the estimate said 80, and 80 fit. `bakeOcrEdits` now measures every
edited run's full text at 10pt in the fonts that will draw it (the same
`measureRuns` the partial redraw already uses) and `planOcrExport` scales from
that (`widthAt10For`); the estimate stays only for a run the engine cannot
measure exactly. Measured: the run bakes at 22.5pt ending at x 195.4, two
points clear of the neighbour at 197.6, where it was 25.6pt ending at 210.

### Tried and dropped: lower darkness floors for a laser letterhead's faint bars
A Lexmark-scanned letterhead (ocr4/003) prints its bold face with dark stems
and horizontal bars at a tenth to a fifth of the paper-to-ink range: the top
bar of every "E" and "F" reads 0.1–0.2 darkness over most of its span, so the
traced E is an "Ł" and the F a stem with one arm. Lowering `MIN_PEAK` to 0.18
and `MIN_DARK` to 0.12 was measured in the lab and changed nothing on those
bars (the pixels are 0.11 and 0.22, patchy either way) while opening the
floors to grain and JPEG ringing; reverted. What the scan holds at that level
is what a reader sees as a weak E; the honest fix would be a stroke-aware
fill along a bar whose ends are dark, which is not implemented.

### A skewed scan: the ink box, the ink colour, the letter's shape and the missing glyph
A SEIDOR appendix scanned about half a degree off level ("LICENCIA" →
"LICENCIAA", "APÉNDICE 24" → "APÉNDICEe 24") baked with a Helvetica "A",
a Helvetica "e", black body text sampled as 0.54 grey, and an editor that
opened in 13.3pt over 8.4pt capitals. Four separate causes, each measured on
the page in the browser (`window.__ocrWeightPlans`, the face's glyph list,
`renderPageBitmap` crops):

- **The box is level; the line is not.** One axis-aligned box fitted to the
  middle of a tilted 464pt line cut through the feet of "AL CONTRATO" on the
  left. The capitals traced there came out without their bottoms and sat on
  the baseline short: the face's caps measured 618–726 units tall, left to
  right, and a typed "A" drew at three quarters of its neighbours' height.
  `extendForTilt` (inkMeasure) follows each vertical slice's ink out of the
  box to the first empty row and accepts it only with a tilt's signature —
  one slice needs nothing and the amounts rise steadily to the other end. An
  underline, a rule or a neighbouring line touches every slice alike and is
  refused. After it the caps measure 705–743.
- **A weight is a HORIZONTAL run, so a letter's shape biases it.** An "A"'s
  diagonals read wider than they are thick: 0.126 against 0.097 for the "I"
  and "D" of the same bold title, past `weightPlan`'s 30% bar, so the face's
  own A was skipped for Helvetica. `letterBias` divides the letter's shape
  out against its own context on the line, and a difference of two pixels
  never decides. The CONTRATO111 case the skip exists for still skips: its
  bold "S" sits in a bold context, and is still 40% off the regular word.
- **The darkest fifth is ink only while the box hugs the text.** A skewed
  line's box is half again the letters' height, ink a tenth of it, and the
  darkest fifth averaged in paper. Ink is now what lies beyond the
  threshold, capped at the old fifth (body lines 0.54 → 0.28–0.33). Only the
  darker HALF of it was tried first and read a grey scan's text as
  near-black (0.24 → 0.10 on a form whose neighbours are grey).
- **The face learned only from the runs the user edited.** An all-caps
  heading has no "e"; the page had bold "e"s at the same size in
  "31 de agosto de 2026". `borrowMissingGlyphs` (useOCR) cuts other runs of
  the page — nearest first, three that cut out of eight tried, because long
  skewed body lines refuse their cuts — and traces a cell only when its em is
  within 15% and the letters AROUND it (not the letter, whose shape biases
  the measure) weigh what the edited run's cells do, within 20%.
  `traceRunIntoFace` takes `{ only, acceptCell }` for it. A donor's text is
  the ENGINE's reading alone — the rule that only glyphs the engine and the
  user agree on enter the face cannot hold for it — so it is gated harder:
  confidence 90+, at most a tenth of its cells suspect, and the borrowed
  cell's neighbours clean. At the ordinary vetting bar the OCR corpus showed
  why: two runs that had baked cleanly in Helvetica took a "u" for an "i"
  and an "n" for an "o" from donors.

The editor and preview (`shownSize`, OcrTextLayer) size a run by WIDTH until
the glyph cut has measured its letters, which the editor now starts in the
background when it opens: a box a tilt inflated opened a 17.6pt editor over
10pt prose (now 10.9). That open-time pass MEASURES only
(`traceItem(item, { measureOnly: true })`). A full trace there was tried
first: nothing is agreed while the editor is merely open, so `trustedCells`
trusts the engine's whole reading, and the stretch the user was about to
correct entered the face — on the OCR corpus an "i" traced as a "t", and a
run whose own cut refused baked in those glyphs instead of Helvetica.

### A cut that slides in the MIDDLE is caught by agreement between copies
The same appendix's "262 (PS 8) LIMA … MARIA con RUC Nº …" line was read as
"(PS8)IMA … MARIAcon RUCN": letters missing from the reading, so the cells
slid by one around "MARIA con" and recovered further on. At under a fifth
suspect the 2x-raster cut passed, the face learned "c" from an "o", "o" from
an "n" and "C" from an "N", and every later edit drew "con" as "onn" and
"Contrato" as "Nnntratn" — the user's screenshot. The end-sliver guard only
sees a shift that starts at an END of the run.

`chooseCells` (scanFace) makes the copies of a letter vote. `cellShape`
(glyphCut) grids a cell's ink over a fixed em band about the baseline;
several copies take the MEDOID (most like the rest on average, mean ≥ 0.66),
because a shifted round letter can pass a bar (a "c" holding an "o" scored
0.77 against real c's, true copies 0.8–0.9) but is never the most typical.
Two copies agreeing (≥ 0.72) or one with clean neighbours; a lone copy only
with no suspect cell within two. Measured on the line: the misaligned cells
are no longer chosen and the corrected line bakes clean, the unconfirmed
letters in the base font.

### A partial redraw follows the line's slope, and extraction groups by STEP
The same line's stretch was drawn level from its start while the scan's
baseline rose, so the untouched tail sat a few points above the text before
it. `planPartial` now rotates the whole group by the fitted baseline's angle
(`rotation`, degrees counter-clockwise), places every part on the line at its
own x, and moves a transplanted tail along the slope (dy = slope × dx).

That exposed an extraction defect: `splitBlocksAtGaps` started a new line
when a glyph's baseline was 0.7pt from the line's FIRST glyph — its comment
already said "where the baseline STEPS" — so any gently tilted line (this
redraw, a skewed Acrobat OCR layer) came back as a chain of 60pt blocks
listed right to left. It compares with the previous glyph now, with the
line's spread capped at one em. Text sweeps: realistic identical on all
seven corpora; marker −3/+1, all on Acrobat OCR layers (every block `3 Tr`,
never offered for editing) whose tilted words now group into lines and
change which block the sweep picks by index.

### A scanned edit is applied LIVE, re-baked from the page's pristine scan
What the screen showed and what was saved were two different drawings. Until
save, `OcrTextLayer` drew an edited run as a stand-in — the whole line
retyped from the recogniser's reading over a paper patch — so every OCR
misreading the user never touched ("MARIAcon RUCN", "Lostérminos queenel")
was on screen, and a run whose cut refused showed as big grey Helvetica off
the page. The bake at save is the faithful one; nobody saw it until they
reopened the file. "It still looks like that" was the stand-in.

`applyOcrLive` (EditorLayout) bakes a page ~300 ms after any change to its
runs (a watcher on `ocrStore.pages`, serialised on `liveChain`), and the
layer draws nothing for a run marked `applied`. Baking on commit alone would
have made the second edit of a line a whole-run redraw — a baked run's cut
is gone and its "original" is the first edit — so each page keeps its
PRISTINE content (`getPageContent`: stream bytes plus its /XObject and /Font
names) and every live bake restores it (`setPageContent` with `keep`, which
also prunes what the previous bake added) and re-applies ALL of the page's
edits, each against its original ink. Measured on the SEIDOR line: first
edit `partial`, a second edit of the same line `partial` again, reverting
the run puts the page back to its 48-byte scan stream with only `Im2` left
in its resources.

Four things hang off it:
- **Undo carries OCR state.** A live bake changes the BYTES, so undoing it
  must also put the store back, or the next live bake re-applies the undone
  edit. Snapshots keep `{pages, hashes}` in a WeakMap beside them, and the
  undo point pushed BEFORE a live bake carries `appliedMeta` — the state the
  current bytes match — not the store as it is then, which already holds the
  new edit.
- **Something else wrote to the page** (a searchable layer, an image behind,
  a text edit): the content hash no longer matches the last live bake, and
  the page is ADOPTED — applied runs finalised the old way (`baked`), the
  current content the new pristine.
- **Tracing reads the pristine scan** (`renderPristine`, the OCR page
  renderer): the page's content is swapped for its pristine in one queued
  step, rendered, and swapped back — a 440 DPI raster of an edited page would
  trace the edits' own glyphs as the scan's.
- **Save and print** apply only what is still pending; everything else is in
  the bytes already.

### Measuring a run is not editing it — and a skewed line's neighbour is judged against the LINE
Live baking made every store change visible, and three of them were not
edits. Opening the editor runs the glyph cut in the background, which adopts
the letters' em (`updateItem({ fontSize, restyled: false })`) — and
`updateItem` counted any `fontSize` in a patch as a style change, so merely
clicking a line marked it edited, painted a patch over its pixels and redrew
it. A style change is now one whose value DIFFERS and is not the cut's
measurement, a move one whose rect differs; unchanged controls re-sending the
same values do nothing. The first real style change records
`originalStyle`, which `revertItem` restores (it restored the text and place
and left the new size, face and colour), and a finalised bake clears it.
`traceItem` yields for the 440 DPI raster and the Tesseract fallback; the
user can edit, restyle or re-recognise meanwhile, so `rememberCut` re-reads
the run from the store and drops a measurement that belongs to a replaced
raster or an older reading instead of writing it over the user's size.

The whole-run redraw now sits on the cut's fitted baseline, rotated to its
slope (not at four fifths of a tilted box, level), unless the run was
restyled or moved. Without a cut, a box inflated by skew is calibrated by
measuring the ORIGINAL reading in the face that will draw it
(`originalWidthAt10For`) against the ink width, never below six tenths; with
a cut the letters' em stands and no estimate shrinks it again. And
`trimProfile`'s neighbour test asked for a band inking 15% of the box's
width — a long skewed line never reaches that even in its own densest row,
so the row above stayed in the box. On a box twelve ems or wider the bar is
half the line's own peak row (capped at the old one).

Measured on the 15-document OCR corpus against a static HEAD build: 74/74
read back both ways, average re-read 0.965 → 0.959, every changed row
inspected. "PAGADO SOLES" 0.75 → 0.92; "MINERA" 1 → 0.6 renders pixel-
identical (re-read noise); "Referencia." 1 → 0.83 is now drawn at the height
of "Nombre:" above it, as the scan has it, where HEAD shrank it by the
character-count estimate — the re-read loses on the colon OCR read as a
period. `msp.pdf` hangs the sweep driver at HEAD as well (not investigated).
`tools/ocr-calibrate/store-regression.test.mjs` covers the store rules
(`node --experimental-strip-types --test …`).

### A scanned edit is made ON THE SCAN: kept letters are its pixels, new ones are its own letters
Every earlier path redrew an edited line (or its changed stretch) with a FONT —
a base-14 face, or one traced from the scan — over a patch, and however good
the trace, the result read as another face set into the page: lighter or
heavier, crisper than the scan's blur, an underline cut off under the new
letters, a bold word coming back regular. The user's bar is an edit that cannot
be told from the scan, and only the scan itself can meet it. The scan edit
(`src/utils/ocr/scanEdit.ts` and what it stands on) works on the page's OWN
pixels:

- **The scan at its own resolution** (`getScanImage` in the worker: the largest
  content image, decoded at native pixels, with the CTM placing it; `scanRaster.ts`).
  A render at another DPI straddles the scan's pixels and its overlay's edge shows.
- **The paper behind the ink** (`preparePage` in `lineInk.ts`): ink is found with a
  max filter wider than any stroke, then every inked pixel AND ~1.8 pt around it
  is filled from the paper beyond (`inpaint.ts`, push-pull). The margin matters:
  a scan's strokes are ringed by blur and JPEG ringing a few levels darker than
  the paper (measured 248–252 at 2–4 px, 254 beyond 6 px at 200 DPI); paper
  sampled inside that ring erased a word into a soft grey blob.
- **Each line analysed once** (`analyzeLine`): its baseline, the ink that is its
  own (not the lines above/below, not a rule), its words split on the ink's own
  gaps, the reading shared among them by width (`wordSeg.ts`), each word cut
  into letters on the LINE's em and baseline, and every pixel of the area given
  to the nearest ink (`owner`, a Voronoi partition out to ~2.2 pt — as far as a
  letter's JPEG ringing reaches). A letter's REGION is what is erased, moved or
  harvested with it: its core, fringe and haze, never a neighbour's.
- **The page's letters as an atlas** (`glyphAtlas.ts`): every letter of an EXACT
  word (one ink run per character — a reading that dropped a digit of
  "20515471681" shifts every cell after it, and digits all being one width,
  nothing else sees it), kept as transmittance over its paper. A letter is
  picked as the MEDOID of its compatible copies (same weight class, x-height or
  cap height within ~10%; the em a fit reports varies 21–25 px across lines set
  in one 9pt face, so sizes compare on what both lines measured); copies that
  look more like ANOTHER letter's established shape are doubted out. Weight is
  measured per word as darkness summed across vertical strokes only (a crossing
  wider than a stem is a bar — counted, every all-caps word read bold).
- **The edit** (`applyLineEdit`): old and new text aligned with contiguity
  preferred (a continuing match is worth twice a lone one, so "iento" stays one
  run rather than six letters picked from all over "cientocincuenta"); a word
  keeps its letters only when its cut is exact, the change is at its start or
  end or leaves most of it, and every kept letter LOOKS like its label (ink
  "claves" read ")laves" cuts cleanly). The line is laid out in three parts:
  everything before the first change keeps its place to the pixel; everything
  after the last change moves as ONE rigid block (letters, ink the reading never
  named such as handwriting in a form's blank, the line's own rules); only the
  middle is typeset — new gaps from the line's own word gap or a fitted
  letter-gap model `g ≈ μ + R[a] + L[b]`. A justified line (it ended at the
  page's right margin) is respaced over its word gaps (−30%/+60% each), but only
  when it is CLEAN (no loose ink, no rule of its own); otherwise a tail that
  would leave the paper is refused. The gaps after the change take the
  difference alone while they take it lightly (a tenth of their width when
  closing, a quarter when opening); past that EVERY gap of the line gives its
  share, the words before the change included (see "A justified line is
  re-justified whole" below).
- **Underlines** are carried: extended with the rule's own columns and end cap
  under new letters of the SAME word, trimmed where letters went. A rule is an
  underline only when letters cover 45%+ of it — a form's blank is left alone.
- **Printing** is multiplication of transmittance onto the paper (`printGlyph`),
  as ink prints; borrowed letters are toned to the line's ink.
- **Overlays** (`scanEditPage.ts`, worker `drawPixelOverlays`): one DeviceRGB
  image + DeviceGray SMask per edited line, drawn on exactly the scan's pixel
  rectangle (no ICC, Flate on save), plus the line's words as invisible text
  fitted to their ink so it extracts and searches. **The mask is opaque for
  three pixels AROUND every changed pixel, not on the changed pixels alone,
  and three more carry the scan's colour while transparent.** A renderer
  interpolates the image and its soft mask separately (MuPDF does), so the
  layers mix wherever the mask steps; a mask that was exactly the changed
  pixels stepped ON the old letters' anti-aliased edges — the edge pixels just
  outside an erased stroke were already paper, so unchanged, so transparent —
  and the old ink showed through at half strength: a grey outline of every
  erased letter, and (with white carried under transparent pixels) pale specks
  along every moved one. Invisible at 9pt, plain on a 24pt book title. The
  margin pixels carry the scan's own values, so an exact render is unchanged.
  The lab cannot show this class (it inspects the working copy, not a render):
  check a MuPDF render of the baked page at 6x.

Letters the document never printed come from `glyphSynth.ts`: the bundled
metric-compatible faces (`public/fonts/match`, OFL: Carlito≈Calibri,
Arimo≈Arial, Tinos≈Times, Caladea≈Cambria; subset to Latin, ~450 KB) are
rasterised by MuPDF (`rasterGlyphs`, `glyphRaster.ts`), the face and its blur and
tone chosen against the page's own letters (MSP: Carlito at 0.93 agreement), the
stems toned to the line's core darkness and re-weighed to the stem of the word
the letter goes into. Only from a look scoring ≥ 0.75, and never more than two
(or a quarter) of a line's new letters — a brochure title redrawn ten letters
out of ten read as another face, worse than the vector fallback. A letter the
page holds in the OTHER weight is re-weighed (`reweighImage`) rather than
synthesised.

Four things the synthesis got wrong, each visible only on a crop (013, a
96-DPI receipt; the lab's `look` command draws the references beside every
face, now with their ink masses and stems):
- **Shape agreement cannot tell the weights apart.** It is a correlation, and
  once the blur has spread the strokes a regular glyph correlates with a heavy
  bold serif as well as the bold does (0.89–0.95 either way), so the weight was
  a coin toss and "Universidad" got a pale, thin "s". Total ink does not
  separate them either — a compact bold letter holds what a wider regular one
  does. STROKE WIDTH does: darkness summed across a stem is its width whatever
  the blur. `fitOnRefs` picks each reference's weight by the stem nearer the
  page's (the page's over its ink's darkness, at least 0.75 — a thin black
  stroke on a coarse scan never prints full, and read as grey ink it measured
  twice its width), and the face, blur and tone by shape, as before; letting
  stems weigh in on the face too chose a sans for that serif line.
- **Toning compared unlike things.** The glyph's 90th-percentile darkness was
  aimed at the line's MEDIAN core darkness, so stems came out at four fifths of
  the scan's. The glyph's own core-level pixels (≥ `CORE`) are now matched,
  median to median.
- **Re-weighing compared units.** The page's stem is absolute darkness summed
  across a stroke, the glyph's is in shares of its ink colour; on grey ink the
  letter was thinned to the grey's share. The target is also the stem of the
  WORD the letter goes into (`GlyphWant.stem`, its neighbours' when it is too
  short to measure), not the page's median for its weight class.
- **A line with no cut word had no cap height**, so a letter was sized from the
  em and an "X" after "S/ 250.00" came out lowercase-sized. `lineMetrics(li,
  { loose: true })` falls back to the approximately cut letters' heights — only
  for sizing new letters; the re-reader and the harvest keep the exact ones —
  and a capital the line shows outranks its figures, which in an old-style face
  stand lower.

The gate went from 0.85 to 0.75 because the refusal's alternative is no
better: a letter the page does not hold is drawn in a foreign face by the
vector redraw too — crisp Helvetica, placed by the coarser glyph-cut
measurement, which set that "X" two points over the baseline. Handwriting
still fails it (0.43–0.69 on the corpus).

Lowering the gate exposed the atlas's weakest copies, and two things now keep
them out:
- **An atypical copy that is a coin-flip with another letter is doubted**
  (`markDoubts`): agreeing with its own letter more than 0.12 below how that
  letter's copies agree with each other, and within 0.03 of another letter.
  The old rule needed the other letter to win outright by 0.02, and an "N"
  cut from a misread line (0.72 own, 0.73 "R") was picked for a reversed
  "LEVANTAMIENTO" on a photographed label and printed as an "A". With it
  doubted the word is refused (6 of 13 letters wanting) — the honest outcome.
- **A letter borrowed from the other weight is toned to the line's core**
  (`matchCore`): re-weighing widens a regular letter's thinner strokes but not
  their paler cores, and the "s" and "t" borrowed into MSP's bold
  "30 de septiembre de 2026" read grey. Its core-level median is brought to
  `LineInk.coreDark`, never past the line's ink.

**A correction is not an edit of the pixels.** When the user retypes a word to
what the page already says ("026" → "2026", "Businss" → "Business"), the ink
already reads the new token, and redrawing it would at best put the scan's
letters back where they were. `findCorrections` plans such tokens on the
pixels as their OLD reading (untouched) and changes only the text layer. The
evidence has to be strong, because a false correction silently drops the
user's edit: the token lands on exactly one ink word and takes all of it, the
word's ink falls into exactly as many column runs as the token has letters,
every CHANGED letter matches that letter's established shape on the page (a
letter the page holds no copy of refuses), and — where the old reading had a
letter in that position — matches it better than the old letter ("2025" →
"2026" over ink that shows 2025 stays an edit). Letters that touch ("ís" and
"ca" in bold Calibri) defeat the column runs, and the word is redrawn from the
page's own letters instead — visually equivalent, and the safe direction.

**The line starts where it always started**, whatever letter now comes first:
the first new character used to be placed at its OWN old ink, so a reversed
"PERU" (first letter = the old last one) moved the whole line right by the
rest of the word.

**A synthesised letter takes the LINE's look, not the page's.** A page sets a
logo, headings and body in different faces, and one look fitted to the page's
letters fitted their mix: on a certificate whose body is Times Bold, the four
reference letters came from the flared-sans logo and an "X" appended to the
body was drawn in Carlito. `lookRefs(atlas, near)` takes its references from
the wanting line first, then from lines at its size (em within 12%) on its
page, then from the document; looks are cached per line, and synthesised
glyphs are keyed `line|wantKey`. Three things the fit needed besides:
- **Capital and figure probes** (`CAP_PROBES`, sized by their own ink
  height): a page of capitals or amounts has no lowercase to judge by, and
  "no face could be fitted" sent every line needing one letter to the vector
  redraw. A sparse page (fewer than four probes with three copies) is judged
  on single copies.
- **Both weights of every face per reference** (`regularAs`/`boldAs`): a
  page set almost entirely in bold has no regular to split it from — its
  "regular" class IS bold — and scored against the regular face, Times lost
  to a sans. The weight that fitted is the one synthesised for that class.
- The lab's `look <out.png>` draws each reference beside every face as it is
  compared; it is what showed the references were the logo's letters.
  `look <out.png> <sigma> <gamma> <page> <lineId>` fits a LINE's look and
  prints which lines its references came from.
- **Known limitation:** a line whose own letters could not be harvested (its
  word not exact) is judged on OTHER lines at its size on the page, which
  may be set in another face — a bold condensed "PUNTOS" heading took its
  look from neighbouring headings and was given a serif-like "X". Checking
  the made letter against the line's own ink is not implemented.

**The baseline is the line most letters SIT on** (`fitLine`): a search over
slopes (±0.09) for the densest band of letter bottoms, refined by least
squares. The median of pairwise slopes it replaced was dragged by the letters
of the lines above and below that a tilted line's tall box takes in, went past
its clamp and was reset to level — the "baseline" then ran through the middle
of a 3° line, every capital measured half its height, no word could be cut, and
a synthesised letter came out at half size. The letters are taken from a band
around the recogniser's box (the box's own counted double, and the fit must
pass through the box), because a tilted line's box is not where its letters
are: on a phone photo of a certificate it sat 30 px above the line's left half
and held the centres of only two letters.

**A line whose thin strokes break apart is GROUPED at a lower level.** `CORE`
(darkness 110) is where a stroke stops being fringe. A 96-DPI receipt's light
sans has strokes a pixel wide peaking at ~175, and at 110 every letter fell
apart into specks one to three pixels tall (the S's spine, the 2's diagonal):
the baseline was fitted to the specks' bottoms two pixels above the letters',
so a letter set on it floated, and 24% of the page's words could be cut. Now
60%. What it took, each measured with an A/B of the lab over seven documents
(`damage` plus `lines`, original files swapped in and out):
- **The trigger is fragmentation, not darkness.** Lowering the level for every
  line whose ink peaks under 200 cost a grey bilingual form twenty of its
  edits: its thick strokes are whole at 110, and lowered its letters fattened,
  its words merged and its em grew by a third. The lower level (half the
  stroke peak) is taken only where its pieces-per-character count is nearer
  one than the fixed level's — the receipt's lines run 1.7–2.4 at 110 and about
  one lower; the form's sit at 0.7–1.3 already — and never on a line with
  ideographs in it, whose radicals are pieces by design.
- **The lower level only groups.** A letter taken whole at it gains its fringe
  rows: every height grew a pixel or two, the em up to a quarter, and the
  letters such a line gave the atlas matched no letter wanted elsewhere ("no
  letter on the page" for an X the form had printed). Components are found at
  the lower level and keep only their pixels at `CORE`, so every measurement
  is the fixed level's. `LineInk.coreLevel` says which level grouped the line.
- **Pieces stacked in one letter's columns join** (`stackPieces`) for the
  baseline fit and the letter count — on those lines only: where letters print
  whole, a piece under a letter is an underline's stub, and joined to it the
  baseline was pulled onto the rule (MSP's underlined title touched twice the
  ink). Growing the core into paler pixels (hysteresis) was tried first and
  joined whole words at this resolution, whose letter gaps are one pale column.
- **The baseline band is narrower** (`tol = max(0.6, 0.06 em)`, was
  `max(1, 0.08 em)`): at a 12 px em an old-style 9, 4 or 5 hangs only two
  pixels below the line and the old band took it in, tilting "Bo08-190845"
  towards its last three figures.
- **An arc bends the letters' tops with their feet.** The arc test refused
  "RUC: 20319363221" once its descending figures were whole letters (the
  median foot of the middle third two pixels low). Bottoms alone are fooled by
  descenders, tops alone by capitals beside figures; a line is set on a curve
  only when both bend the same way, the middle third off BOTH ends — the
  seal's "REPÚBLICA DEL PERÚ" bends 2.7 px at the feet and 2.3 at the tops on a
  16.6 px em. A first fix (judging the higher bottoms only) let the seal
  through, and an edit moved its tail along a straight line.

**A form's blank does not count as the line's word spacing.** The recogniser
boxes a printed line together with the blank after it, so the line's ink ends
with the handwriting written in it. Two defects followed, on "el mismo que
acredita con copia de mi recibo de: ___LUZ___":
- `splitWords` sets its word-gap threshold by Otsu over the line's gaps, and
  one 58 px gap before the handwriting outvoted the rest — the threshold went
  over every word space (9–11 px), clamped to 0.4 em, and the whole sentence
  came out as one word. Gaps are capped at 0.6 em for the threshold.
- `alignCharsToWords` then shared the reading over eleven ink words for ten
  printed ones: the width scale included the handwriting, and fitting the
  reading over it cost less than skipping it, so "de:" landed on "LUZ" and an
  edit of "mismo" typeset 58 px word spaces and dragged the field left. Up to
  two ink words at either END may be left out (the scale taken from the rest,
  0.3 each) — but only ink set apart by a blank of an em or more: trimmed
  freely, a table row's short final cells were dropped whenever the scale was
  off, which cost two tables two edits each. That edit now changes the word
  alone (1.9k px in its own box, no damage).

Tried and dropped: keeping the searched slope when least squares moves the
line by under 1.5 px across its letters (to stop a round S a pixel above flat
figures from tilting a short line). The MSP scan really is tilted about 0.5°,
which over a 133 px title is 1.2 px — the same size as the artefact — and the
guard flattened it: the underlined "APÉNDICE 25" touched twice the other ink
and a form's date could no longer be set.

**The vector cut's baseline is found the same way** (`baselineOf` in
`glyphCut.ts`): the densest band of letter bottoms over a scan's slopes, then
least squares on that band. Its plain least-squares fit (with one 1.5 px
outlier pass) was tilted by old-style figures it does not know descend, past
the partial redraw's 0.03 "tilted" limit — so "Bo08-190845" + " X" was redrawn
WHOLE from glyphs traced off a 96-DPI scan (a B cut through, a 5 in halves)
instead of keeping the number's pixels.

**The page size for recognition comes from the render when the engine cannot
give it.** `runOcrNow` fell back to a LETTER page (612×792) when
`getPageSize` failed — which it does while the worker is busy right after a
load — and `recognizePage` then stretched the A4 render into a Letter-shaped
raster: every box came back at 0.94 of its height down the page and 1.03 of
its x. On a results table that is a whole row: the box of "223.5" sat on
"213.9", the reading fitted that ink's width, and the line analysis took the
wrong row for the edited one. It showed as recognition "not being
reproducible" between runs. The size is now the render's own (its pixels over
its scale) whenever the engine fails or disagrees about the shape.

**A letter-spaced line is read and set as letter-spaced.** A book's title page
sets "J U D E A  P E A R L": far wider than its letters' advances, so the
"reading does not fit the ink" test refused every tracked line and the vector
fallback redrew the title with a broken J and a seam. When the widths disagree
but the line's letter-sized pieces are as many as the reading's visible
characters (±12%), the reading is accepted. In `applyLineEdit` a new letter on
such a line takes the line's TRACKING — what its own letter gaps exceed the
page's typical gap by — on top of the pair model, or it reads as a word
squeezed in. Joining "JUDEA PEARL" into one word now just closes the gap with
every letter the scan's own.

**A pair the page never prints is spaced OPTICALLY.** Gaps are modelled ink
to ink (`g ≈ μ + R[a] + L[b]`, fitted on the pairs the page prints); a pair
with either side unobserved used to get μ alone. It now gets the gap that
makes the mean WHITE between the two letters' profiles (each row's depth
capped at a quarter em) equal the median of the line's own exact pairs. The
lab's layout log marks such gaps `o` (and model gaps `p`). Measured: "PEARL" +
"S" comes out at the line's typical white — the gap still reads a little wide
to the eye, because the L's open upper half is wider than the quarter-em cap.

**The user's text re-reads the line where the ink confirms it**
(`refineReading`). A user retypes a garbled line as it is printed plus the
change they mean, and the recogniser's reading is then the worse of the two:
it drops letters at word joins ("(5) claves" read "(5)laves", "Productivo y
cuatro" read "Productivoyuatro"), and the analysis shares the remaining
labels out shifted by a letter across whole words ("Productiv | o | yuatro"
over the ink "Productivo | y | cuatro"). Planned on that, an edit of the line
printed "y y cuatro" and "claves s serán". The line is analysed again with
the TYPED text; every ink word whose letters look like the typed ones
(`wordReadsAs`: cut exactly, or with as many column runs as letters; no
letter plainly another letter's shape; 70% of the letters passing their own)
takes the typed words, every other ink word keeps the recogniser's — those
are the user's real change — and the line is analysed once more with that
mixed reading and planned on it. On the MSP line, 13 of 15 words are read from
the typed text and the only pixels drawn are "seis (6)"; the rest of the line
is the scan's own, moved as a block and re-justified. It costs one or two
extra line analyses per edited line (up to ~0.15 s). The status note says "N
words read from the text typed". Two things it needed in the app, invisible
in the lab: a refined plan refused for want of letters RETURNS that refusal
(its `wanting` is what gets synthesised — falling back made the caller
synthesise for the other plan, and the refined one never got its letters);
and the synthesis gate counts LETTERS only — "seis (6)" needed its brackets
and figure made, three of seven glyphs, and was refused while the fallback
plan, redrawing twenty more letters, passed the same gate.

**A change the typed text "confirms" must be vouched for by the page.**
`wordReadsAs` passes a word on 70% of its letters, so a changed letter the
page holds NO shape for rode along on the rest: "(4)" retyped "(5)" on a page
with no 5 in it was confirmed on its brackets, read as what the ink already
said, and nothing was drawn — the edit silently lost. The letters a typed word
changes (and every letter of ink the recogniser never read) must have an
established shape and match it (`mustKnow`), as `findCorrections` demands.

**An edit of the garbled reading itself is carried onto the ink's own
reading** (`repairReading` + `mergeReadings`). More often than retyping a
line, the user edits the reading AS THE EDITOR SHOWS IT, garbage and all:
"(5)laves" → "(6)laves" over ink that says "(5) claves". Planned on that, the
"(5" word — one label short of its ink — was redrawn whole, its ")" lost, and
the line came out "Licenciatarioseis (6claves". Now, when the typed text
confirms nothing, the line is READ AGAIN from the page's own letters
(`rereadLine`): every ink word's column runs against every letter the page
has a shape for, and the recogniser's labels aligned to the runs of the
WHOLE line (a DP: keep a label on a run that looks like it, replace it where
the run plainly is another letter, drop a label with no ink, add the letter a
run plainly is where no label names it, two touching letters in one run, one
broken letter over two). Over the line, not word by word: the labels were
shared among the ink's words by width, and "presente contrato" read
"presentecontrat" was shared "present | econtrat" — a word alone cannot hand
its "e" back, and re-read alone it became "eontrato". The user's change is
then carried onto that reading by a three-way merge (base = the recogniser's
reading, the user's text, the repaired one): where only one side changed a
stretch it is taken, where both did the user's text wins, keeping a word gap
the ink shows at either end. "(5)laves" → "(6)laves" becomes "(6) claves" on
the pixels; the MSP line re-reads EXACTLY as printed, "Licenciatario cinco (5)
claves por cada instalación del Software, uno para Uso Productivo y cuatro (4)
… Las claves serán emitidas", from "Liceniatariocinco (5)laves por cad
nstalación del Softwar , no par Uso Productivoyuatro (4) … clavesserá
mitidas". The text layer reads the merged text. What made the re-read honest,
each measured on that line:
- **Where a run sits about the baseline decides what it can be** (`extentOf`,
  in ems of 1.92 x-heights): an accent rises above the x-height, a comma hangs
  at the foot. The shapes alone confuse "á" with "a" and "é" with "e" (0.79 vs
  0.78 — an accent is a few pixels a shape barely weighs), and the line's
  right end, its baseline a pixel off, read every "e" as "é". An accented
  letter is chosen only where the plain one does clearly worse.
- **A label the page has no shape for is no evidence either way.** "5" over
  its own ink looked 0.81 like an "S" and was replaced; a digit is replaced
  only by one of its own kind, or where it cannot sit (a comma's label on an
  x-height letter).
- **Every change costs** (replace 0.25, add 0.3, drop 0.5 over the shape
  cost), so the reading keeps the recogniser's labels unless the ink plainly
  says otherwise: cheap replacements made "sserá" "serrn".
- **A broken letter is two runs that look MORE like it together** — a "v" and
  the "o" beside it are not a "v".
- **A word whose letters mostly read is re-read too, more strictly** — "yuatro"
  over "cuatro" passes `wordReadsAs` on five letters of six.
- **A dot or an accent standing apart on top rules out "l", "I" and the plain
  vowels** (`NO_DETACHED_TOP`) — the shapes put "I", "l" and "i" within a few
  hundredths and read "instalación" as "lnstalación". Only that way round: in
  bold type an accent touches its letter, and the converse rule read bold
  "dólares" as "ddlares".
- **An ascender rises well above the x-height** (0.62 em, a "t" 0.5): with the
  looser bound an "o" could be a "d", and "calculado" read "calculadd".
- **An ambiguous letter may be added at a price, not refused**: refused, the
  alignment explained the run worse ("calculad" kept its "d" on the "o").
- **The word's case decides between look-alikes** ("I" against "i" in a word
  of small letters, a letter against a figure in a number).
- **Two to four letters may share a run, and dropping a label costs more than
  any of that** — "00/100", its "00/" one run, read "0/100" by dropping a "0".
- **A space the reading missed is put back only between two words whose labels
  fit their ink**: between two that do not, the gap is not where the labels
  part ("l\"|Contrato\"" over ink saying "el \"Contrato\"").
- A word that does not read well this way (mean shape cost over 0.33, or
  changes on more than half its letters) keeps its labels, and so does any
  neighbour the alignment gave one of them to — a label is never read twice.

The text layer of a repaired line reads the MERGED text — the ink's reading
with the user's change — not the garbled text typed over: it is what the page
now shows. `fidelity-driver.js`'s read-back (`readsBack`) accepts it when it
carries the stretch the user changed, and says so (`found: 'repaired'`).

**A change as wide as what it replaced keeps the tail where it is.** "5" →
"6" moved the rest of the line by the pixel the "6" is wider, and a justified
line was then respaced to its margin — 26 000 pixels rewritten for one figure.
A difference of up to two pixels (or 0.08 em) is split between the gaps either
side of the change, as a figure set in the same advance; the overlay is the
figure's box alone.

**Only a line of a justified PARAGRAPH is respaced to the margin**
(`justifiedMargin` in scanEditPage, shared with the lab): one just above or
below it must end at the same margin. A slide's title "Introduction to Deep
Learning" happened to end at the page's estimated margin, and deleting the
"o" of "to" spread every word gap of it to keep an edge it never kept; now
the line simply ends shorter.

**A justified line is re-justified whole when the change is large.** Only the
gaps after the change used to give way, a quarter of each at most: "el 31 de
agosto de 2026" → "el 30 de septiembre de 2026" closed the gaps after the date
to "porlas" and "quesu" and still ran the line 18 px past the margin, and
"veinte" → "veinticinco" ran 15 px past it — in a justified paragraph a line
sticking out of the margin is the first thing an eye catches. A difference the
gaps after the change take lightly (a tenth of their width closing, a quarter
opening) still stays there and the words before it keep their pixels; past
that every gap of the line takes the same share, up to three tenths closing,
and the words before the change are moved too, as a typesetter re-justifies.
Measured on the MSP appendix: both lines end at the margin with every gap
5–7 px (was 7–8 before the change and 6 after it), and inserting "y uno" into
the same line overshoots by 7 px where it overshot by 31. A line still past
the scan's own pixels after that, where no overlay can draw it, is refused
("the edit would run the line off the paper") and the vector redraw sets it
smaller; before, it was drawn there with a note and its end clipped away.
Only the image's edge is the bar: refused 6pt short of it, an "X" appended to
a book cover's "NATURE" went from the page's own letters (damage 0) to a
redraw in another face (22 497 px).

**A figure is set like a figure.** Hand-written edits of numbers on two forms
(a payment checklist: cost centre, amount, reference, project code; a public
service order: order number, day, year, amount, page number) found six ways
a new figure came out wrong, each measured on the crops (glyph extents per
5x zoom, ink under 140):
- **Sized by the wrong measure.** A copy is compared on what both lines
  measured, and a line that measured neither x-height nor cap height (a lone
  "8" in a table cell) was compared by its em — the least reliable measure —
  so "9408100" → "9408200" took an "8" 2 px short of the figures beside it.
  And x-height first is wrong for a figure or a capital: a form sets "RUC:
  20613872893" larger than the "Teléfono :" after it, so that line's x-height
  matched the header's while its figures stood 13% taller, and its "2" went
  into "Página: 2 de 3" two pixels taller than the "1" it replaced.
  `sizeRatioOf` (glyphAtlas) measures a capital by the copy's OWN height
  over the baseline first (`ownCapHeight`, core pixels), then cap height,
  then x-height; a figure by the lines' cap heights first and its own height
  (over 0.98, as `lineMetrics` takes figures) only where its line measured
  neither; any other letter by x-height first. Own height first for figures
  was tried and is wrong for OLD-STYLE figures, which stand at the x-height
  or rise and fall below it: a receipt's "1980" → "1985" had every page
  figure refused and came back in synthesised lining figures.
- **Typeset instead of placed.** "13,000.00" → "13,500.00" put the new "5"
  where the gap model said, two pixels right of the old "0", and moved
  ",00.00" with it. Figures replacing as many figures (each with the same
  space before it, from cut, not approximate, cells) now take the old ones'
  cells, centred where each stood — lining figures share one advance — and
  the tail stays to the pixel: the edit rewrites one figure. Kept characters
  BETWEEN such figures stay put too, so two changes in one line are two
  figure swaps: a certificate's "del 03 de abril al 01" → "del 04 de abril
  al 02" moved "de abril al 0" by the new "4"'s width when typeset, and now
  redraws the "4" and the "2" alone.
- **Rounded onto the baseline.** Every borrowed glyph was placed at a whole
  pixel, half a pixel off the fitted baseline either way, so two neighbours
  could stand a pixel apart ("PYT000123": the first new "0" a pixel above the
  next). A fractional offset between 0.2 and 0.8 is now applied by
  resampling (`shiftDown`, the cubic kernel `scaleImage` uses).
- **Grown to the right in a right-aligned cell.** "20,000.00" →
  "25,000.00" redrawn from the line's start ran its last figure into the
  cell's border. A line mostly of figures that ends within an em and a half
  of a vertical rule (`li.borders`), with more room on its left than its
  right, keeps its right edge ("set flush right in its cell").
- **A number whose figures touch was never cut.** At 150 DPI "9408100" has
  its "08" in one run of ink, the word was not exact, and changing one figure
  redrew all five after the "94". `figureCellsOf` (lineInk) cuts a word of
  figures alone by its PITCH — lining figures share one advance, so a run
  holding k figures is k equal cells — when every run's width is a whole
  number of figures within a third and the counts add up to the reading's
  exactly. A number's separators (". , : / -") stand apart as narrow runs of
  their own; which runs they are is decided with the counts in reading order
  (a small DP over the reading's tokens and the runs), so a bold "20,000.00"
  whose "20", "000" and "00" each touch is cut too. The edit's kept-letter
  shape check still refuses a figure cut wrong. Measured: "9408100" →
  "9408200" redraws the "2" alone, "PYT000000" → "PYT000123" keeps "PYT000"
  and adds "123", and "20,000.00" → "25,000.00" redraws the "5" alone.
- **A borrowed glyph brought its colour fringes.** `toned` scaled each
  channel by the ratio of the two lines' inks, so a copy kept the chroma of
  where it was taken from (JPEG fringes, a stamp's red): "123" borrowed into
  a grey form came with a pink haze, ten levels of red over the green that
  the line around it did not have. Each pixel's darkness, as a share of the
  copy's ink, is now printed in the target line's ink (within the old
  0.75–1.35 bound on how much darker or lighter); the haze is gone, and the
  MSP edits move by at most 8 levels on a few pixels.

The MSP suite in the browser is unchanged (14/14 on the scan, damage 0); in
the lab the misread amount now keeps its tail in place and two figures change
their source copy. **Known:** a figure the page does not hold is synthesised
in LINING figures, the bundled faces' default: on a 96 DPI receipt set in
old-style figures, "28/08/2025" → "29/08/2025" (too small to cut, so redrawn
whole) came back with its synthesised zeros standing a head taller than the
page's own.

**Letters that stand apart are the cut** (`runCellsOf` in lineInk). The cutter
refuses a line under 16 px of em ("too small to trace" — a floor for outlines,
not for moving pixels) and vets widths against a face it guesses; on a 150 DPI
office scan 70 of 72 words were uncut, and an edit could keep none of their
letters — deleting a letter of a logo redrew the word from letters the page
did not hold, and fell to the vector path. A word whose ink pieces fall into
exactly one run per character, each about as wide as its letter, is cut on the
runs. On a very small scan (em 8–13 px) most such counts are coincidences — a
"U" one pixel wide — and the width test refuses them.

**A word whose letters only PARTLY stand apart is split where they do**
(`peelWord`): its leading runs that each hold one letter (about that letter's
width, short of a pair's) and its trailing ones, counted from each end, are
words of their own; the touching middle stays whole. "MSP-SIST-202309006" at
150 DPI has "20" and "900" touching, so it was never exact, and reversing
"MSP" redrew all eighteen characters — four figures synthesised, read back as
"PSM-SIST-2023000б". Split "MSP-SIST-" | "20230900" | "6", the edit moves the
"P", draws "S" and "M" from the page and leaves the rest where it was. Two
rules had to give for it:
- **A letter typed against a word glues only THAT word** (`insertions`, with
  the old letters either side): a code without spaces is one token, and "SM"
  typed into "MSP-SIST-" made the figures "glued" and redrawn.
- **A kept letter must not plainly be another letter — it need not match its
  label as well as the page's best copies do.** The old bar (the class's own
  cohesion less 0.16) redrew "SIST" at 14 px of em for an "I" at 0.67; a kept
  letter now fails under 0.5, or where another letter beats it by 0.15 and
  reaches 0.75 (the ")" on a "c" of ")laves" is 0.34).

**A redrawn word takes its letters from lines set in its own face**
(`inStyle` in glyphAtlas). A form sets its labels in one face and its values
in another, at one size and weight, and the medoid of all their copies drew a
reversed serif label in the sans of the values. Each request carries the
shapes of the exact letters nearest the word on its own line (its own, when
it is exact; at most two words away — a label and its value sit side by
side); each source line of a candidate copy is scored on the letters it
shares with those (two at least), and only the lines within 0.05 of the best
are drawn from. All of them when no line can be scored. **Known limitation:**
on a 150 DPI form whose serif labels are small enough that their letters
touch, no label word is exact — there is no same-face copy to choose, and
"CORRELATIVO" reversed is still drawn in the values' sans.

**A pale dot or accent belongs to the letter under it.** A colon's top dot at
darkness 106 (a core is 110) was no ink of its own: moving the colon moved
its bottom dot and the part of the top one within reach of it, and left the
rest behind — half a dot where the colon had been. Before the owner map
grows, a small faint piece (darkness 60+) that touches no core and sits over
a letter's columns within half an em of it is seeded as that letter's.

**A table's rules and borders are never a cell's letters.** The lab's
automatic edits over a 585-run table page (ocr/007: names, amounts, "NO
INGRESÓ") changed other ink in 17 of 45 edits, up to 296 px — the table's
grid broken under and beside the edited cells, inside the edit's own box
where the sweep's damage measure cannot see it. Five causes, each in
lineInk/scanEdit:
- **A vertical rule cut into row-high pieces** by the horizontal rules it
  crosses was shorter than the 1.45 em "tall thin stroke" test and became the
  cell's first letter: reversing "QUISPE" erased the border. A piece that is
  thin, stands from above the capitals to below the baseline and is STRAIGHT
  (`isStraightUpright` — a parenthesis is as tall and bows) is protected.
- **A cell's text stops at its borders**: the recogniser's box of "QUISPE…"
  reached across the border, and the "51" of "351" was read as its "Q". Where
  a border stands within the box's span, the line's ink is the stretch between
  borders that holds most of it.
- **A rule is followed out through its pale ends**, and a piece lying on a
  rule's line is the rule's: the last twelve pixels of a cell's rule, paler
  than a core and then dark again, went to the nearest letter — moving the
  "Ó" carried them along (darker where they landed, a gap where they had been).
- **A rule that runs past the analysed box is not an underline**: cut to the
  box, a narrow cell's text covered most of it, and an edit "trimmed the
  underline" by breaking the table's rule.
- **Nothing is printed on ink the line does not own** — another line, the
  next cell, a border; beyond the analysed box any ink at all (the next cell's
  letters lie outside it). Core on core: a letter's soft edge beside its cell's
  rule is how every letter of the page sits. " X" appended to a narrow cell was
  set onto the first letter of the next one; it is now refused.
- **A border welded to the cell's first or last letter** is carved off the
  piece (`carveBorder`): columns at its edge inked unbroken from above the
  capitals to below the baseline — or to the baseline, where they meet the
  rule the text sits on (`ruleMask` under the column's end). A stem of "l" or
  "d" ends at the baseline and meets no rule, so it is never carved.
- **A rule is judged with the steps it continues into** (`ruleChain`): a
  tilted rule is found as stair-steps, and its last step, ending inside the
  box, passed for an underline. A rule that ends at a border or crosses one
  (`LineInk.borders`) is never an underline either.
After them: 2 of 45 edits touch other ink (21 px and 1 px), one append is
refused, and every MSP edit is unchanged. **Known:** a border at the very
edge of the analysed box, welded to a number's last digit, still moves with
that digit's cell (an eight-digit ID number on ocr/007, 21 px). **Fixtures exported before the
page-size fix** (`pageWidth` 612×792 on an A4 page) put every box on the
wrong row — re-export before trusting a lab result on them.

**A page whose scan is not ONE upright image is read from its render.** An
office scanner's "compact PDF" (Konica's MRC: a JPEG background with the text
removed, and the text as 1-bit masks painted over it), a /Rotate page whose
image is turned, or a scan in tiles never reached the scan edit: the largest
image held paper and no letters, or its pixel grid was not the page's. The
worker's `getScanImage` now returns null when image MASKS (`/ImageMask` or
1-bit images) other than the largest image cover a tenth of the page — only
masks: a slide deck's other pictures are pictures, its largest image still
holds the text, and treating them as layers sent a 3628×2041 pt slide to a
106 DPI render too coarse to read (this editor's own `OcrPx…` overlays are
excepted too) — and gives its CTM in the DISPLAYED frame (composed with
`pageRotationCtm`); the layout's scan
loader then falls back to MuPDF's render of the page CONTENT (no annotations —
`renderPixmap` takes `contentOnly`) at up to 300 DPI and 16 MP, and the edits'
overlays are drawn on that render's grid. On the Konica scan (a /Rotate 90
MRC results table) four of six edits now go through the scan edit.

**A line set over a picture is refused** ("the line is set over a picture"):
a book cover's sticker over a photograph of water, where the water read as
ink against the sticker's yellow, so the plain-paper test (which samples only
the light) saw a plain ground and an erase smeared yellow over the photo. Ink
no letter can be — wide AND tall, or vast — covering 6% of the line's area
says so; thin rules and table borders do not count. Only its pixels in the
LINE's band count — within 0.6 em of the median centre of the letter-sized
pieces: the recogniser's box of a results table's first row reached past the
rule into the speckled grey header above it, one wide tall component, and
"250.80" was refused while its figures sat on clean white. (The same table
read through a fixture exported before the page-size fix put every box a row
off and failed two more cells — re-export before believing a lab refusal.)

**On squared paper the grid is paper.** A student's notes on squared paper
(ocr3/020 and 023) had their grid read as ink: every grid line within reach
of a letter was filled in under the letters as if it were a stroke, and the
line analysis gave its pieces to the nearest letters — so an edit moved grid
segments along with the moved words and left white gaps in the grid where
they had stood ("x1+2x2+x3+x4=0" → "x1+2x2x3+x4=0" broke four lines of it).
`preparePage` now finds FAINT, THIN, LONG straight lines — lighter than 120
and not within two pixels of anything darker, a few pixels thick at most,
unbroken over 8pt — and takes them as paper. Where a letter crosses one, the
line is bridged across it (up to 40pt), its paper the line's own colour from
one end to the other, so a moved letter's grid pixels are transmittance one
(they stay put) and an erased letter is refilled WITH the grid. "Faint" is
judged on the pixel's own lightness: against the local maximum a bold
title's stem edges read faint, and the thinness test alone let a large
title's crossbars through. Three things the real pages needed that the
synthetic one did not:
- **The line is no source for the paper AROUND it.** Taken as known paper,
  the grid fed the fill under every letter beside it, and the paper estimate
  came out with grey smudges at each crossing — an erase would have painted
  them. The fill sees the line and its blurred fringe (two pixels each side)
  as unknown; afterwards the line's own pixels take back their colour.
- **The plain-paper tests look past the line AND its fringe**
  (`PageInk.lines` is the widened band): a scanned grid line is blurred, its
  pale edges are paper of the grid's tint, and counted as the page's paper
  they read every squared page as rough — "x1+2x2+x3+x4=0" and "La matriz
  escalonada es:" were refused as "not plain paper" where they had been
  edited on the scan before. `paperRoughness` bridges a line pixel with the
  first paper outward from it, `relaxErased` holds a line pixel inside an
  erased hole at the grid's colour instead of relaxing it into the white.
- **Not on the inverted page.** A cover's art reversed holds long faint
  strokes of its own; taken as paper there they made a reversed author line
  (ocr3/008, "W. Chan Kim • Renée Mauborgne") read as set on rough ground.
Measured with a synthetic squared page (scanedit.test.mjs): 66 grid pixels
changed by an edit before, under 20 after; the MSP appendix is
pixel-identical. **Known:** handwriting on squared paper cuts unreliably —
"escalonada" → "eslonada" removes the wrong letters and reads "esnada" —
at HEAD before this change as well; the grid is now kept round it.

**The ink colour is the LETTERS'.** New letters are toned to the line's ink,
and that was the darkest pixels of ALL the line's own ink — a bullet the
reading never named included. A dashboard's solid green disc in front of
"49.7% good" outweighed the grey letters, and an "X" appended to them came
out green. It is now taken from the cores of the line's letter and figure
cells, and from every pixel of the line only when those give fewer than 24.

**A small tinted ground is paper of its own colour.** The paper filter is a
max over 3.6pt, so a ground darker than what surrounds it — a dashboard's
light-blue button, a shaded table cell — has a band of that width inside its
edge that read as ink. On a button barely taller than its words (ocr3/021,
"Last 3 days": 36 px tall at 3.5 px a point, a 13 px band top and bottom)
the band and the margin round the letters left NONE of the button known, the
paper under the letters came from the panel outside, and every letter an
edit moved carried a box of ground × ground/panel over the button — measured
(166,204,236) on (199,224,244), exactly that product. Two steps:
- **A closing restores the ground.** The max filter followed by a min filter
  as wide brings back any region wider than the filter; where it lowered the
  paper level by more than 12, the closed level is light (150+) and the pixel
  itself is that ground within 6 levels, the pixel is paper. A thick black
  stem is closed too and stays ink: its closed level is dark.
- **A restored ground is filled from its OWN known pixels** (`fillGrounds`):
  the region a closed level runs through without a step (neighbours within 2
  levels), push-pulled inside its own bounding box with only its own pixels
  known, or — when the margins leave it almost none — the median of its bare
  pixels. It must be flat (closed levels within 6) and mostly bare (half its
  pixels at the ground level), which keeps chart bars, gradients and photos
  on the page's fill; and under a quarter of the page, which keeps the page's
  own paper there.
Measured on the dashboard: the paper under the button's letters matches the
button everywhere (it was 8+ levels lighter round "days"), and "Last 3 days"
→ "Last days" moves the word with no box. Costs ~190 ms a page (the closing
125, the fills 66 on a 5.6 MP raster), paid once per page — and nothing on a
page with no ground, which skips the region pass. The MSP appendix is
pixel-identical.

**A bullet the reading does not name takes no label.** Recognisers drop list
bullets more often than not, and the alignment of the reading to the ink
then gave the bullet the line's first label and shifted every label after it
by one: "● 49.7% good" read "49.7% good" put the "4" on the disc, the "9" on
the real "4", and so on — an edit of the number would have rewritten the
wrong figures, deleting its first character would have deleted the bullet,
and the line's ink colour came out the bullet's, so an "X" appended to grey
text was green. The same dashboard's legend dots took the "Se" of
"Sessions" and the "C" of "Chrome". An end ink word may already be left out
when a blank of an em sets it apart; a bullet sits an ordinary word space
from its text. `markBullets` (lineInk) marks an end ink word that is ONE
piece, about square (0.65–1.5), solid (68%+ of its box inked), 0.3–1.1 em
tall and with no counter — no letter is all of that: an "o" or a "0" has a
hole, an "l" is thin, a full stop a fifth the size — unless the reading's own
end character is bullet-like (then the reading named it). `alignCharsToWords`
must then leave it out (its width is a letter's, so it fits a label about as
well as the trim costs, and the label went on it anyway), falling back to
the unforced alignment only if that leaves nothing to fit. Left out, the
bullet is the line's loose ink: it stays where it is before the first change
and travels with the tail after the last.

**A dash the recogniser boxed short is read whole.** A book cover's
"—LAS 4 VIRTUDES ESTOICAS—" came with a box that stopped inside the closing
dash, past even the 0.6 em the line's region adds: the part of the dash
outside the region belonged to no line, so deleting the "D" moved the
dash's inside half with "ESTOICAS" and left the outside half where it was —
two dashes, a gap between them. When an owned piece at the region's left or
right edge is a DASH (no taller than a quarter em, at least 0.3 em long)
that visibly runs on past the edge and ENDS within an em and a half,
`analyzeLine` reads the line again once on a region two ems wider on that
side, and owns a dash that starts inside its margin however far it runs.
Both limits were learned from the corpus: widened for ANY piece at the edge
(a cover's specks, a title's last letter) the line read differently and
some lines could no longer be read at all; widened for a form's blank, its
underline running on for ems, a date typed into it was set somewhere else
(MSP's "Fecha: ____" fill moved 47 px).

**A letter is judged against its own face, not the page's commonest.** A
cover sets its title in a big sans and its subtitle in a small serif, and a
letter's medoid is whichever face holds more copies: the subtitle's serif
"I"s agreed 0.49 with the title's sans "I", looked more like an "L", and
were doubted — so deleting the "D" of "VIRTUDES" redrew the whole word (a
kept "I" scored under 0.5) and synthesised its "I", blurrier and paler than
the scan's. Two changes, both only where the medoid is another SIZE (on a
page, size goes with face; more than 20% apart):
- `markDoubts` marks a doubted copy `peerVouched` when the copies of its
  letter at its own size from OTHER words agree with it (median 0.8+, and
  more than with any other letter). `pickGlyph` uses such copies only when
  nothing else can be picked. Un-doubted outright they were picked over true
  copies on MSP — a re-weighed regular "7" and "0" where the page's own bold
  ones had been, visibly lighter than the bold digits beside them.
- The kept-letter check in `applyLineEdit` accepts a kept letter that its
  own size's copies (doubted ones the peers vouch for included) agree with.
Measured: the cover's "VIRTUES" keeps every letter of the scan; MSP's edits
are pixel-identical.

**A correction cannot hold two letters in one run.** `findCorrections`
reads a token as what the ink already says when the word's ink falls into
as many column runs as the token has letters. Two letters that touch make
one run, so deleting the first of them ("VIRTUDES" → "VIRTUES" in a bold
serif, its D against its E) left exactly as many runs as letters — and with
no CHANGED letter to check the shape of, it passed: the edit changed the
text layer and drew nothing. Each run must now be no wider than its letter
(its advance × 1.3 + 0.12 em).

**A synthesised letter is as soft as the LINE's edges.** The look's blur is
fitted on the page's reference letters, and those may come from anywhere on
the page: a cover's crisp 44 px "RYAN" has no lowercase to judge by, the
references fell to small lowercase elsewhere, and a face that does not quite
match correlates BETTER blurred — the fit took the grid's softest (1.3 px)
and the appended "X" came out a blur beside sharp capitals. `edgeWidthOf`
(lineInk) measures the line itself: the median 20–80% width of its letters'
stroke edges, each stroke against its own peak so grey and black ink are
measured alike (`strokeEdgeWidths`). The want carries it (`GlyphWant.edge`)
and `synthGlyph` picks the blur, 0 to 2.5 px, whose rendered glyph measures
the same by the same rule; the look's blur stands only where the line gives
under a dozen edges. Measured on a page built like the cover
(scanedit.test.mjs): the "X"'s edges went from 2.28 px to within 0.6 px of
the line's 1.05; on the cover itself the "X" is now as crisp as "RYAN", and
MSP's one synthesised "W" comes out a little sharper beside its "L" and "E".

**Ten hand-written edits of a scanned purchase order** (dates, amounts,
quantities, payment terms, a model, a supplier name) found four defects the
automatic corpora never had, all on ordinary small print:
- **A full stop fainter than its figures was no piece.** "1.00" printed its
  stop at darkness 80 against the figures' 180, under the core level: the
  reading's "." went on the first "0", the second "0" was split over two
  halves, and changing the "1" erased a stop the analysis never knew about —
  "2.00" came out "200". A faint mark of its own (touching no piece's core)
  that is stop-sized, sits on the baseline in a GAP between pieces, now joins
  the line's pieces — but only as many as the reading has stops and commas
  its own small pieces do not already account for, the darkest first: on
  handwriting any faint mark near the baseline would do, and with no count
  a page of notes on squared paper lost a third of its cut words.
- **A thin diagonal breaks into a staircase.** Each "/" of a 7.8pt
  "09/08/2023" was three pieces in neighbouring columns, so the date counted
  fourteen ink runs for ten characters, was never exact, and changing its day
  redrew all of it from figures off other lines — resized, visibly heavier.
  `inkSpans` (lineInk) joins pieces that only touch column to column when
  their rows barely overlap — steps of one stroke — and `columnRuns`,
  `runCellsOf` and `figureCellsOf` all count runs through it; a run held by
  one cell goes to that cell whole, or the slash's foot, in the gap before
  its cell, went with the figure beside it. Two letters that touch stand side
  by side, rows overlapping, and stay two runs. The edit now changes the two
  figures alone.
- **A word in a replaced word's place takes that word's gap.** A new word
  after a letter that stays was set at the line's TYPICAL word gap — on
  ": Mantenimiento Instrumentacion" that was the 10 px after the colon, so
  "Electrico" stood 3 px further off than the word it replaced. And where
  the INK broke but the reading did not (":09/08/2023" read without the space
  the scan shows) the new figure was set at a letter gap, glued to the colon.
  `gapBefore` gives a new letter after a kept one the old gap there, when the
  old text broke there — a space in the reading, or a word boundary in the
  ink.
- **Only a line of a paragraph is a paragraph's.** `justifiedMargin` now asks
  that the line and the neighbour vouching for the margin each span half the
  text's width (from where its lines usually start): two value fields of a
  form's right-hand column ending at the same x are not justified prose.
MSP: every edit as before but for a pixel's shift where a redrawn word
picked a slightly different copy, and "30 de septiembre" set at the scan's
own gap before the date rather than the line's typical one.

**A number redrawn whole keeps its characters' places** (`sameSpan` in
`applyLineEdit`). A bold "18/07/2022." whose slashes touched its figures
could keep none of them — not exact, so redrawn whole — and the redraw was
set at the spacing model's gaps: the touching original came back
"25/07/2022." letter-spaced, wider than the date it replaced. When the
changed stretch replaces exactly as many old characters, figure for figure
and every other character the same (a number and its separators), each new
glyph is centred in the old character's cell and anything after it stays
put — `sameCells` did this only for figures between kept characters.
Approximate cells count here, unlike there: lining figures share one
advance, so a share of the run by advance IS a figure's place, and the span
keeps its extent either way. On MSP the "5" of "APÉNDICE 25" now sits in
the old "4"'s cell (it was set a pixel tight against the "2") and the
underline under it ends where it did. Seen on a scanned service-acceptance
letter edited by hand, which also showed: a justified line that takes a
longer word closes its gaps to about 0.2 em, the same as MSP's — tight but
accepted there — rather than running past the margin.

**New figures are set on the figures' PITCH, centre to centre.** Lining
figures share one advance and a stop or comma takes about half of one, so
an amount's characters sit at fixed centre distances whatever their ink
widths (a "1" is narrow ink in a full cell). The pair model sets ink GAPS,
and a figure the page never printed — synthesised, or one of a pair never
observed — came out a pixel or two off: "0.00" retyped "2,500.00" opened a
gap after the comma that "13,000.00" above it does not have. `gapBefore`
places a figure or separator next to a figure on the pitch the line's own
figures measure, or, with fewer than three pairs of its own ("0.00" has
one), the page's lines at its size (`pageLines`, ±8% em); a stop or comma
without a sample of its own is three quarters of a pitch from its figures.
The chain runs on exact centres (`figCentre`) and is rounded once per
figure: rounded at every step, three new figures drifted a pixel and a half
off their column.

**Figures changed for figures are aligned by POSITION** (`positional` in
`applyOnPixels`). When every word of the new text has the old word's length
and every changed character is a figure where a figure stood — an amount, a
date, a code — character k of each word is character k of the old one:
whatever did not change (the separators, a figure that happens to stay)
keeps its pixels, and every new figure takes its predecessor's cell
(`sameSpan`). The value alignment paired the "1" of "16,949.15" with the
"1" of "21,186.44": the comma between them could not be kept, the word fell
under the "kept too little" rule and was redrawn whole. Such a word is not
redrawn for keeping little — what it keeps is in its own place. And a
number laid in its old cells is not then set flush right: a new last
figure narrower than the old one is not a shorter number, and the shift
moved the kept separators a pixel.

**A kept character that is plainly its label's LOOK-ALIKE is kept**
(`lookAlike` in scanEdit). The kept-letter check redraws a word when one of
its kept letters plainly is another letter — that is how a shifted reading
(")laves" over "claves") is caught. A receipt's code "B008-190845", read
"Bo08", tripped it: its zero is an old-style one, shaped like an "o", and
matched the page's "0" at 0.98 against "o" at 0.21; changing the code's last
figure redrew all eleven characters and synthesised the "B". Characters drawn
alike by design (B/8, o/0, l/1, S/5, Z/2, G/6, g/9, case pairs) say nothing
about a shift, and keeping their pixels shows exactly what the page showed.

**Old-style figures are sized as x-height glyphs** (`fitLine` in wordSeg).
A line that is mostly figures is measured as capitals (`median / 0.72`), and
old-style figures stand at the x-height: "Fecha: 28/08/2025" on a Raleway
receipt fitted a 9.6 px em where its letters and its box's width say 14, so
every figure was too wide to cut and an edit redrew the date from glyphs of
the wrong size. When a line is a third figures or more, its em is under 0.85
of the width's guess, and more of its pieces hang below the baseline than its
reading has descending characters (g j p q y Q J ( ) , ;), the x-height
measure (`median / 0.52`) is taken if it is nearer the guess. Lining figures
sit on the baseline and keep the capitals' measure: the em guard decides,
the hanging count only confirms. A slash is NOT counted as descending: it
hangs in some faces and not in others (not in this receipt's), and counted,
the date line's one hanging "5" no longer outnumbered its two slashes.

**An amount in a column set flush right grows to the LEFT** (`alignedRight`
in scanEditPage, `columnRight` in `applyLineEdit`). `flushRight` already
kept the right edge of a figure line ending against a cell's vertical rule;
a payment checklist's amounts column has no rule, and "0.00" under
"13,000.00" retyped "2,500.00" ran out past the column. A line of figures
(60% digits) is in such a column when another line of figures within six
ems, at its size, ends where it ends (within 0.12 em) and starts elsewhere.

**A box's side is carved off whole, rounded corner and blurred edge
included** (`carveBorder`). A form's day cell ("05" under "Dia") is a box
whose left side runs down from the cell above and curves into the bottom
rule. The carve demands columns inked unbroken through the letters' band,
and the side's outer column was inked over a third of it (blur), so no
column at the very edge qualified; the side and its corner stayed one
piece, the two touching figures one run, and the cut took the side for the
"0" and "05" for the "5". Changing the day to "12" erased the border and
printed the "1" where it had stood. On a piece taller than any letter (1.3
em), two blurred edge columns may be stepped over and the side may be as
thick as the band's horizontal rules plus one; what is left wholly outside
the letters' band touching the carved columns — the corner — is the
border's too. Only on such a piece: stepping over the edge columns of a
bold "l" whose stem ends two pixels under the fitted baseline carved it as
a border, and reshuffled a whole MSP line's word split.

**A stop, a comma or a colon is harvested only if it is SMALL**
(`harvestLine`). A purchase order's quantity column reads "1.00" over ink
whose stop is too faint to be a piece; the word split gave the "." the
first "0", every row did the same, and the page's established "full stop"
was a zero — an amount typed "1,050.00" printed "1,050000", and every real
stop on the page failed the kept-letter check against it. A cell labelled
". , : ; ' ·" wider than 0.24 em (or, but for a colon, taller than 0.4 em) is
not taken.

**Peers vouch for a kept letter at any real size difference.** The
kept-letter check compares a letter with its medoid; on that order the
medoid "0" came from rows fitted at a 13.9 px em and the "930.00" rows at
15.3, the same face, and a perfectly good "0" scored 0.49 — under the 0.5
bar — so "930.00" was redrawn whole to become "1,050.00". Copies at the
line's own size now speak for it from an 8% em difference (it was 20%).

**A figure is sized by FIGURES first** (`figH`: the median height of a
line's figures, on `lineMetrics`, every `Exemplar` and the request). The
same face's figures stand at one height on every line, whatever the em fit
made of a line of figures alone; by capital height, a purchase order's
"930.00" rows (fitted 10% larger than its "1.00" rows) took their "1" re-
weighed from the bold header, and a bold day cell's "12" came out in the
regular figures, visibly lighter than the "05" it replaced. Old-style
figures compare x-height-ish with x-height-ish the same way. Capital
height and the figure's own height remain the fallbacks.

**Each line's wanted letter is its own** (`wanting` keyed by line in
`planScanEdits`). A synthesised letter is made in its line's look and looked
up under the line's id; keyed by the letter alone, two edited amounts on one
page wanting the same comma kept only the last line's want, and the other
amount went on wanting its comma — a vector redraw in the middle of a
column of scan edits.

**Amounts in a column are set flush right even when all are as wide**
(`amount` in `alignedRight`): a column of "930.00" down every row gives no
left edge that differs, and amounts are set flush right; a code column as
wide as itself (923-002) is not taken for one.

**A signature or stamp crossing the line is another LAYER of ink**
(`LineInk.overInk`, `layers` in `applyOnPixels`). A notarised deed's blue
signature crosses three lines of grey text; the owner map gave each letter
the stretch of stroke within its reach, so a respaced line carried those
stretches along with its words and an erased letter took its stretch with
it — the signature came back broken at every line it crossed. Where the
line's box holds ink of another colour, every pixel's density is shared out
between the two inks (densities add where inks overlap: least squares of
`-ln(pixel / paper)` over the three channels against the two inks' density
vectors, both non-negative). An erased pixel becomes the paper under the
other ink, a moved letter carries only its own ink, and the other ink's
pixels are held through the erase's relaxation.
Two traps, both measured on a service order whose navy letters fringe into
greyish blue on its tinted paper — taken for a second ink there, the
letters' own density was shared out to it and erased letters stayed:
- the other ink is judged as a DENSITY DIRECTION, on unclipped pixels only
  (a dark core is cut off at zero in one channel and points anywhere), at
  ten degrees or more from the letters' own mid-dark pixels — hue alone
  calls a dark ink's anti-aliased edge another colour;
- it must come in STROKES at least an em long — colour noise round other
  letters and a form's rules comes in specks — and the two inks must be
  fifteen degrees apart for the split to be trusted.
A grey scan, and any page without such strokes, takes the old path to the
pixel.

**A rule before the change does not stop a line being respaced**
(`cleanAfter`). The respacing moves the line from its first change on, so
only loose ink and rules there forbid it; one before the change (a deed's
underlined "INTRODUCCIÓN.-" opening the line) never moves. Such a line is
respaced over the gaps after the change only, never the whole line.

**A word given a new first letter keeps the gap before it.** "Moneda :
S/." retyped "US$" kept the "S" and put the new "U" a word gap off the
colon — the line's typical word gap, ten pixels more than the form's colon
gap. The gap before an old word whose first letter now comes second is
that word's own gap (`leadsOld` in `gapBefore`).

**Word gaps are measured where the READING has a space.** The ink's own word
split also cuts one word at a wide letter gap ("ESTE | FAN | I" in a capitals
cell); counted as word gaps those gave a page of table cells a 0.15 em word
space and an "X" appended to a first name came out glued. `LineInk.wordGapPx` is 0 when the
reading has no space on the line, and the edit then takes the page's word gap
clamped to 0.25–0.6 em. (`LineInk.spaceAfter` holds the index of the first
character AFTER each space — the name is the old one.) A line of FIGURES alone
takes its digits' height as its cap height, or a capital set beside them was
sized from the em at four fifths of their height.

**A bowed line is followed, not fitted straight** (`fitBend` and
`LineFit.bend` in wordSeg, read through `baselineAtOf` wherever a line's
baseline is evaluated). A phone photo of a curled page bows its lines: on a
CamScanner letter the letters' feet sag one to three pixels in the middle of
most lines against their ends (up to 0.12 em at a 19 px em). Measured against
the straight fit, the bold date "18/07/2022." at a line's risen end stood
15.3 px tall where its figures are 13.5 — every bold digit the page printed
elsewhere was then the wrong size for it, and changing the date synthesised
two of its four new digits. A letter set on the straight fit at such an end
also sits a pixel or two low. Knots every three ems or so, each the median
foot of the letters within two ems of it, linear between and held beyond the
ends; only where the knots stray from their own best straight line by a pixel
and a twentieth of an em — on a flat scan the feet scatter by half a pixel,
and those lines keep the straight fit exactly. The straight fit still decides
whether the box holds two printed lines and whether the line is set on an arc
(a seal's); the bend is added after both. A letter or a tail moved along a
bowed line rises or falls with it (`base(x + dx) − base(x)`, not
`slope × dx`).

**The request's own line is its own style; the other lines compete among
themselves** (`inStyle`). The face filter scored the requesting line as a
perfect 1 and kept only lines within 0.05 of it — and one face agrees with
itself across lines at 0.85–0.9, so every other line was shut out whenever
the requesting line held a copy. On that letter's bold date the copy was the
"8" of "18", touching its slash and so not whole, and no bold "8" printed
elsewhere could stand in for it. The own line is now always kept and the
others within 0.05 of the best OTHER line; where no other line can be scored,
only the own line's copies, as before.

**A copy doubted only across sizes is still its own line's best**
(`ownLineOnly`). A small phone number's "7" agreed 0.64 with the body text's
"7" — a third larger — and 0.65 with its "1", and was doubted; with no copy at
its own size to vouch for it, an edit of the number synthesised its "7" where
the line's own was there to borrow. Such a copy (its medoid another size, no
peers, no more like another letter than its own) is picked for a request from
its OWN line, and only when nothing else can be — the second pass, beside
`peerVouched`.

**A word the cutter cut is still cut on its runs when the two agree**
(`exactRuns`, `runsAgree` in `addWord`). A word is exact when its ink falls
into one run per letter, but its letters' boundaries came from the cutter,
which places them by the letters' advances: on a notarial deed's bold
"FBERERO" it put the F|B boundary four pixels into the B's stem, the B's piece
straddled it and was divided by column, and the F took a strip of the stem.
"FEBRERO" then erased the B and left the strip standing after the F —
"F|EBRERO", at HEAD as well. The cutter's suspect flags stand; its boundaries
give way to the runs when every run is about as wide as its letter
(`runCellsOf`) AND lies mostly inside the cell the cutter gave that letter.
The second condition is not decoration: without it, a typed text's re-read
gave the ink of "G." the reading "ING." (its G, its stop and two specks made
four runs), every letter cut on those runs "looked like" its label, and a
table cell's "ING. CIVIL" + " X" printed "I. CIVIL X".

**The lab gates synthesis like the app** (`look.score < 0.75`, as in
`useOCR`). It synthesised from any fitted look, so a display title fitted at
0.63 "passed" in the lab with a sans "I" and "Ó" set into a condensed serif
word — an edit the app refuses and redraws as vectors. A lab result that
synthesises has to be one the app would make.

Measured for these four: the letter's 11-edit suite in the browser draws
every edit on the scan with 0 px of damage outside the plan, the bold date
from the page's own bold digits (was two synthesised) and the phone number's
"7" from its own line; the lab A/B over 16 suites (235 edits) against HEAD
takes synthesised letters from 45 to 36 and refusals from 27 to 26 (a
reversed "FACTURA" drawn from page letters), and every changed plan was
inspected — MSP's "30 de septiembre" now takes its "s" and "t" from the
page's bold copies instead of re-weighing regular ones. `bend <page>` and
`heights <page> <lineId...>` in the lab print a page's bows and a line's
letter heights over its (bent) baseline.

**A synthesised letter is re-weighed like for like** (`GlyphWant.stemChars`,
`synthGlyph`). A word's stem is the median darkness summed across every stroke
its letters cross, and a curve or a diagonal is crossed wider than a stem — in
many faces a date's 0, 2, 3, 8 and 9 read heavier than its "1". Aiming a
synthesised "1" at that raw median made it visibly bold beside the scan's own
"1" on a service order's date. The target is now `have × pageStem / faceStem`:
the same characters the word's stem was measured on (`stemSource` names them),
rendered in the face and look that will draw the new letter and measured by the
same rule (`stemRuns`), so the bias of the word's shapes cancels. Where those
characters cannot be measured (fewer than four stems) the old target stands.
Measured in the lab A/B: only synthesised glyphs change, and that "1" comes out
at the scan's weight. The unit test pins the neutral case: a date printed
exactly as the look prints it gets its "1" un-re-weighed (ink within 3%).

**A letter is never borrowed from text set in the other kind of face**
(`footRatio`, `faceAt` in glyphAtlas; `GlyphRequest.style.face`). A registry
page sets its headings in a serif and its body in a sans, and "SIGA TICS" →
"SIGA TECH" drew the "E" and the "H" from the body: a sans "E" and "H" inside
a serif heading, visible at a glance. The shape scores could not see it — one
coarse grid per letter, and a sans "E" agreed 0.76 with the heading's letters
where one face agrees 0.78 with itself across a table's lines. What does
separate them is the FOOT of a stem: a serif widens it into a slab, a sans
leaves it as wide as the stem. `footRatio` (the darker of the last two rows
over the median of the lower stem, on I T H F P i l) read 1.9–2.3 on every
serif line of that page and exactly 1.0 on every sans one; across twelve other
documents sans lines sit at 0.8–1.2 and serif capitals at 1.5–2.9. n, m and r
are left out: at body sizes their serifs are a pixel and merge into the stem
(a Times paragraph read 0.5 to 1.4 on them). `faceAt` classes a place on a
line by the median of the five nearest stem feet within eight ems — two at
least, and under 0.75 is a baseline a pixel off, not a face — and where that
stretch cannot tell, by all the line's feet (three at least): a serif
paragraph shows its feet somewhere along the line even where a stretch holds
none, and a sans amount line ("(CIEN MIL CON 00/100 SOLES)") went unclassed
at its "E" and lent it to the serif heading. Three things hang off it:
- **`pickFrom` drops copies set in the other class**, and a letter the page
  holds only there is MADE in the line's own look (Caladea Bold at 0.87 for
  that heading). The foreign copy is a stand-in, used only where the letter
  cannot be made (no face prints like the line, or the line may not take that
  many made letters — the gate swaps made letters back to their copies before
  refusing). Such an edit succeeds and still reports `wanting`;
  `planScanEdits` collects wants from successful lines too, and `useOCR`
  harvests more pages for them, makes them and plans again.
- **Doubts are judged within a face.** `markDoubts` compares each copy with
  its letter's medoid, and the medoid is whichever face holds more copies:
  the heading's serif bold "E"s agreed 0.57 with the body's sans "E" and 0.74
  with a "D", every one was doubted, and even a page holding serif "E"s gave
  the sans one. When the medoid's face (its own, or that of two thirds of the
  copies like it — the medoid may stand where no stem foot is near) is the
  other class, the copy's peers in ITS face vouch for it (`faceVouched`) —
  and only for a request KNOWN to want that face. Vouched for anyone, they
  filled in for a one-word bold sans header (one stem foot: its face cannot
  be told) and drew serif letters into it. Telling such a word's face from
  its letters' SHAPES was tried and dropped: on a bold serif title the coarse
  grid scored the sans lines 0.92 against the serif ones' 0.86.
- **A made letter is as crisp as its line** (`sharpenTo` in glyphSynth). No
  blur still leaves a rendered glyph's edges about a pixel wide, and
  re-weighing adds part-dark columns; that page is a bilevel archive copy
  (edges 0.6 px) and its made "H" measured 1.3, a soft letter in a sharp
  heading. Its darkness is steepened about the middle until its edges
  measure like the line's; a line at 0.6 px has nothing between ink and
  paper, and the letter is thresholded. On such a line the sub-pixel baseline
  shift (a cubic resample that puts grey rows into a glyph) is not made: the
  glyph lands on the nearest whole pixel, as the scan's own letters do.

**A regular paper texture is kept under the ink** (`paperTexture` in
lineInk, `PageInk.texture`). The registry page is printed on security paper
with a hatch of dots at an eight-pixel pitch. Push-pull filled an erased
letter with the paper's smoothed level, a clean patch in the hatch; and a
letter borrowed from elsewhere carried the hatch of where it was taken (its
fringe's transmittance against the smooth fill), a faint box of misaligned
dots 3–5 levels darker round every new letter. Where the paper's residual
against its own blur repeats on a lattice — autocorrelation over 0.6 at a
shift of three pixels or more, measured on 48 px windows of plain paper (the
hatch measured 1.00 at (8,0) and (0,8)) — every pixel the fill made takes the
residual of the nearest lattice translate that is plain paper.
`relaxErased` then relaxes the hole's LEVEL only: the residual comes off
every value first and goes back on the hole after, or the harmonic fill
smooths it away again. Selective by construction: of eight other documents,
five have under a level of residual and stop at the first test, and the two
grainy ones peak at 0.18 and 0.32. It costs about 1.5 s once, on the
textured page.

Measured: lab A/B over 18 suites (246 edits) against the last commit: 15
changed, all inspected — the registry heading (its own serif "E", a crisp
made serif "H"), its "CIENTO CINCUENTA" and "ESTATUTOS" now from same-face
lines (the base drew letters with grey fringes from the other face), its
other edits by the hatch alone (no pixel by more than 40 levels), and
synthesised letters elsewhere crisper. The four browser corpora (ocr, ocr2,
ocr3, ocr4: 261 automatic edits) are unchanged in damage, edits on the scan
and read-back; one page makes one letter fewer. The registry suite draws
10/10 on the scan with no damage. **Known limitation:** a reversed one-word
bold sans header on a page whose body is serif (a service order's
"Descripción") still takes serif letters from the body — one stem foot
cannot tell its face, so no filter applies; that was so before this change
as well. Lab: `serif <page>` prints each line's stem-foot
ratios, `texture <page>` the paper's residual and autocorrelation peaks,
`explain` takes FACE=serif|sans and prints each copy's face, and `edit`
prints made letters' edge widths with EDGES=1 and plans again with made
letters when an edit drew foreign copies.

**Text lighter than its ground is read on the INVERTED scan.** Reversed-out
titles, a book cover's lettering and logo badges are not ink on paper: read as
such, the paper estimate takes their white letters for paper, and an edit
painted pale blobs around letters it never removed. On paper the median
luminance of a line and the ring around it sits near the LIGHT end of its
range; reversed out, near the dark one. Such a line is analysed on
`invertedPage(pi)` — every pixel's colour inverted, prepared like the page and
kept with it — where it is dark ink on light paper, and `LineInk.inverted`
says so: the harvest reads its letters there (`pageOfLine`), and
`planScanEdits` edits it in an inverted working copy and inverts the changed
pixels back before the overlays are cut. The multiply-onto-paper print model
holds in the inverted domain, so a letter moved, erased or synthesised there
comes back as light lettering on the ground's own colour. The test runs BEFORE
the plain-paper one, which the paper estimate around white letters always
failed. Measured on a book cover (white serif on red and on a blue circle):
every line was refused, the vector fallback painted rectangles (22.5k px of
damage in the sweep); now 38 of 39 words cut, and deleting, reversing and
appending letters (the X synthesised) all draw on the scan with no damage —
including the two title lines that straddle the circle's edge. Lettering over
a photograph still fails, in either domain, as not plain paper.

Tried and dropped: letting a letter's region follow its pale strokes past the
2.2 pt reach (ink of fringe darkness connected to the letter, bounded to its
neighbourhood), for what looked at 5x like the ghost of a deleted italic "L".
Contrast-stretched, the "ghost" was the erase itself: inpainted paper is flat
and the scan's paper around it has 1–3 levels of grain — invisible at any
normal contrast. The extension changed nothing on that edit, nothing on MSP,
and on a certificate with a patterned ground it walked the pattern: two edits
went from 0 and 6 to 40 and 181 px of damage. Stretch a crop (`lo` ≈ 215)
before calling something a remnant.

**A whole-run vector redraw erases on the scan's pixels where the line was
read** (`inkAwareFallback`): when the scan edit declines a line for want of
letters (or too many to synthesise) its line analysis still holds which pixels
are whose, so a WHOLE or REMOVED run's paper rectangles become an erase of
that line's own letters and nothing else. A painted rectangle erased whatever
fell inside it — under a tilted line, the top of the line beneath (an edit of
"EMPRESA : MINERA SHOUXIN PERU S.A." took "RUC : 20392776975" with it). The
mode gains ` {ink-aware}`. Two limits, both measured wrong first:
- **Not for partial redraws.** Their rectangles and moved tails are placed on
  the vector planner's own letter cut; erasing this analysis' letters inside
  them disagreed by a letter, and a deleted "J" stayed under the "M" moved
  onto it. Partial redraws keep the painted patch and the tail crop.
- **Only on a trusted analysis** (`analysisTrusted`: half its words cut one
  ink run per letter). On handwritten graph paper the grid's segments came out
  as "letters", and the erase took the grid with it.

**Every other vector patch is filled from the run's GROUND, and stops at its
neighbours** (`groundFill.ts`, mode ` {ground}`). Where the scan edit refuses
a line for its background — a book cover's gradient, a band of colour, a
photograph — the vector redraw painted a rectangle of one colour over it: a
flat green box on a green-to-yellow gradient, a navy block over a photograph
of water. And the box reached: its pads are 12% of the run's height, and the
detector's box around a 140pt title already held the line beneath it, so
editing "RICO" on a red cover took the bottom half of "Y HÁGASE" above and the
whole of "LA RIQUEZA Y LA REALIZACIÓN PERSONAL" below (42 000 px of damage);
"$100M" took the tops of "LEADS". Now a run's patches are filled the way the
scan edit erases a letter — what is printed in them is found against the
ground around it and only those pixels are filled from that ground
(`pushPull`) — and only the run's OWN letters are:

- **All of a run's patches are judged together.** A tilted line's patch is a
  staircase of rectangles; judged step by step, some steps were refused and
  painted flat yellow on a sticker while letters straddling the others were
  half erased.
- **The max filter is as wide as the strokes** (a quarter of the run's em):
  at 3.6pt a 160pt title's stems read as ground inside, and the fill left a
  blurred copy of the word.
- **Thresholds are relative to the run's contrast and above the ground's
  grain**, the grain measured in a ring around the patches with every shape
  set aside first. Dark red on red is 35 levels deep; the fixed 12 left a
  ghost of every letter, and grain taken for letters smoothed the whole
  rectangle into a visible box. Specks are never letters.
- **Ownership is decided letter by letter**, never by cutting the rectangle:
  a letter whose centre lies in another line's box (centre outside this run's
  middle band) or another run's along it is that run's — inside two boxes (a
  tilted sticker's line ending inside the box of the line beneath) the nearer
  middle wins, each box in its own half-size — and a box covering most of the
  run is no neighbour at all (a junk run over half a cover's artwork held a
  title whole). A shape over half outside the run's box (a quarter, when it
  also reaches the working region's edge), 1.6 em tall or 2.5 em² is the
  PICTURE: the photograph beyond a sticker's edge read as "ink" against its
  yellow and was filled yellow. Reaching the edge alone is no proof — a
  title's "L" welded to a photograph's ripples was kept as picture while the
  rest of the word went. A shape outside the box, widened for accents, is a
  feature of the ground and stays.
- **The ground is measured twice**: from everything, and from what lies
  outside the other runs' boxes (with a margin — the tops of white letters
  poke out of a tight box), the second winning wherever it found anything in
  reach. White letters beside a dark line were the brightest thing around and
  the red between them read as ink; a single brightness to cap the boxes at
  was fooled every time (the white page beyond a navy band took a title's
  whole ground away); blanking the boxes outright lost the ground where two
  tilted lines' boxes overlap.
- **The fill draws only on the ground the letters stand on**: what can be
  reached from beside them without crossing a colour step bigger than grain.
  A gradient is all small steps; a narrow navy band between red stripes is
  not, and filled from both a title came out pink — from the white page beyond
  the band, white.
- **It refuses rather than half-erase**: print in the patches with none of it
  the run's, or over a third of the run's middle band taken for picture,
  keeps the flat patches (old behaviour). Patches with nothing printed in them
  paint nothing.
- **A partial redraw's tail moves over the ground too**: each of the run's
  own pixels as its transmittance over the filled ground, laid on the ground
  where it lands (on the inverted colours for light lettering). Pasted as a
  crop, the tail brought its old ground with it — a box on a gradient.

The flat patches themselves are clamped in `planOcrExport`
(`clampToNeighbours`): a neighbour whose centre lies outside the run's box
trims only the pad — on tightly set text honest boxes overlap by an ascender,
and cut there the tops of erased capitals would stay — while one whose centre
lies INSIDE it (an inflated box) stops the patch, never nearer the run's middle
than a quarter of its height.

Partial redraws take the fill too. The limit above ("not for partial redraws")
was about erasing the ANALYSIS' letters inside a rectangle placed on the
planner's cut; the ground fill works inside the planner's own rectangle, so the
two cannot disagree.

**Known limitations:** on a photograph the fill is smooth — the letters go, but
their place shows as a soft patch of the picture's colours (texture synthesis
is not implemented); text a few pixels tall on a band barely taller than it
has no band left to fill from and smears the stripes beside it; and the
replacement the vector path draws is still Helvetica in the colour it sampled,
which on a narrow band can be the band's own. Verified in the lab (`fill <page>
<id> <out.png>`: the original, the flat patch, the fill, stacked; `COMPS=1`
prints every shape and what it was taken for) on the red, green, water and
sticker covers, and in `scanedit.test.mjs` (a white title on a gradient, its
box over the line beneath: the title goes, the line beneath keeps every pixel).

Refused, with the reason in the mode, and left to the vector path: a box holding
two printed lines, a line set on a curve (a seal's arc), a reading that cannot
fit the ink, lettering over a picture (paper luminance spread > 40 levels), ink
the reading does not account for where the edit lands, a line outside the scan
image (phone apps inset it), moved/restyled/vertical runs, and scans over 16
megapixels (the paper estimate's working memory).

Measured on the MSP appendix suite (14 hand-written edits over 3 pages, the
fidelity driver, in the app): 14/14 drawn on the scan (was 0 — every edit was a
vector redraw), 14/14 read back, damage outside the planned pixels 0 on every
page, underline coverage kept (0.99, 0.995). In the lab every crop was inspected:
inserted, replaced and moved letters are the page's own; the misread amount
"USD 30.00" (ink "630.00") edits to "700.00" because the whole ink word is
replaced. Timing: the first edit on a page ~1.5 s (scan read, paper, ~60 lines
analysed, harvest), every later live bake 100–260 ms.

Tools: `tools/ocr-calibrate/scan-edit-lab.mjs` (node, the app's modules through
Vite SSR: `lines`, `debug`, `atlas`, `edit` (writes `-before/-after/-zoom` and a
`-context` crop of the change in its line), `damage` (also counts any pixel
written OUTSIDE the edit's box — the overlay would drop it), `explain`, `who`,
`cell`, `inspect`, `corr` (why an edit is or is not a correction), `look` (the
look fit's references beside every face), `repair <page> <id> [text]` (the
line re-read from the page's letters, op by op, and a typed text merged onto
it), `exact <page>` (how many words were cut, and how many more stand one run
per letter; `WIDTHS=1` prints each run's width in ems), `fill <page> <id> <out.png>` (a
vector patch: original, flat, ground-filled), `repairall <page>` (every line's
reading beside its repair from the page's letters), `colors <page>` (each
run's sampled ink and ground); `VARIANT=<dir>` loads the OCR
modules from a copy of `src/utils/ocr` there, so a change can be measured
against `src/` without touching it while a browser run is going — the unit
tests below take it too),
`tools/ocr-calibrate/scanedit.test.mjs` (node --test; alignment, push-pull, an
end-to-end edit on a synthetic MuPDF-rendered scan asserting nothing outside
the edited line changes, a correction that changes no pixel, a real edit not
taken for one, the overlay mask's margins, the three-way merge, an edit of
a garbled reading landing on the ink it meant, and a heavy title on white
paper whose paper estimate stays white under its strokes), `fidelity-driver.js`'s
`runAuto` (delete/reverse/
append on readable runs of any scan, with damage and crops) and
`public/_sweep/auto-corpus.js` (`start({ only })` runs `runAuto` over a staged
corpus; results in `window.__autoResults`, crops in `__autoSheets`). The lab
finds the scan by replaying q/Q/cm to its `Do` — a page that wraps its scan in
a flip and then places it (`0.72 0 0 -0.72 72 842 cm` … `627 0 0 -971 0 1081
cm`) was read at the wrong place by the first version, which grepped one `cm`.
The fixtures it needs are exported from the app (`__fidelity.exportFixture()`
after a `runSuite` that recognised the page).
Test drivers set `window.__noUnloadPrompt` — the "unsaved changes" prompt
otherwise blocks every automation call after a hot reload. **Do not edit `src/`
while a browser run is going**: a hot reload replaced the OCR controller mid-run
once and every later document read as a text page. To keep working while a
corpus runs, run it on a FROZEN build: `NODE_ENV=development npx vite build
--mode development --outDir <scratch>/snap` (development, so the DEV-only
hooks such as `__ocrBakePlans` and `__noUnloadPrompt` survive; it copies
`public/_sweep` too) and `npx vite preview --outDir <scratch>/snap --port
9100`; nothing written to `src/` reaches that page.

### A smooth ground is ground; the lines that are not the scan's are left alone
Found by the full OCR sweep (three corpora, 51 documents), each measured with
the lab before it went in:

- **A wide range of ground is accepted when it is SMOOTH** (`paperRoughness`:
  the 90th percentile of |paper − box blur(paper)| over the line's non-ink
  pixels, at most 8 levels). A cover's gradient spans a hundred levels across
  one title and was refused as "not plain paper"; a photograph's texture reads
  tens. On such a ground only a line cut CLEANLY is taken — every word one ink
  run per letter: a title printed in two inks (black "APOCALÍP", grey "SEX")
  reached the core level only in places in its grey half, its reading was
  shared out over the wrong ink, and deleting "SEX" erased the "P". A guard on
  two ink darknesses was tried first; it refused good lines on two forms and
  could not tell that title from them. Both failures had an approximate cut.
- **The erased hole is relaxed after the push-pull** (`relaxErased`: SOR on
  Laplace's equation over the erased pixels, 120 sweeps at ω = 1.85, held at
  the scan where it is not ink and at the paper estimate where it is).
  Push-pull is a pyramid average: on a gradient it leaves a faint plateau
  where a letter was.
- **An accent below the baseline is the line beneath's** when it is shaped
  like one (at most 0.06 em² and 0.35 em tall, starting 0.08 em under the
  baseline, none of this line's letters reaching down to it) and sits right
  on top of a letter that is NOT this line's. Set tight, the next line's
  accents fall inside this line's band; taken as its loose ink, deleting "LOS"
  from a title carried the accent of "SEDUCCIÓN" onto its U. Asking less (any
  piece below the baseline that nothing reaches) took a form's handwritten
  blank and a tilted heading's "S".
- **A change in marks alone is an edit, never a correction** (`stripMarks`).
  An "O" and an "Ó" are one letter to the shapes, so "SEDUCCIÓN" retyped
  "SEDUCCION" was taken for what the ink already said: the accent stayed on
  the page and only the text layer lost it.
- **Light-on-dark is judged on a box padded by min(15% of the width, half
  the height)**, not 15% of the width: on a long title the padding reached
  past the band, outvoted it, and white lettering on navy was sampled as
  navy. Identical on 1088 runs on plain paper.
- **A run the recogniser read off the page's own VISIBLE text is not the
  scan's** (`dropRunsOnVisibleText`): visible blocks covering 60% of its width
  on its row and reading what it read (LCS ≥ 0.7) take it, and the status line
  says those lines are real text. A translation service draws its banner and
  the book's title as text over the scan; edited as OCR runs, "ALEX HORMOZI"
  baked as "XELA" — the partial redraw kept "HORMOZI" as scan pixels while the
  bake blanked the real text under it. 11.7k damaged pixels on that page to 0.
- **A first edit blanks only the INVISIBLE text under a run**;
  `blankInvisibleText(…, all)` is for runs already baked, whose first bake
  has to go. With `all` on a first edit, visible text overlapping the patch —
  the same banner, a stamp's ID strip — was blanked too.

### A re-read is held to what the document reads, and to letters it can read
`repairReading` re-reads a line from the page's own letters when the user
edits a garbled reading, and its text is what the edited line's text layer
says. On the MSP appendix it turned "Lostérminos queenel … deinidos" into
"Los términos que en el … definidos" and "USD 30.00" into "USD 630.00", but it
also made words worse: "Limitado" → "Lmitado", "Upgrade" → "Uugrade", `("Software")`
→ `("SSoftware"))`, "o Licencia:" → "ooi Ucencia:", and on a form whose small
bold letters the atlas cannot tell apart every repair it made was wrong
("Normal" → "Normel", "Valorización:" → "Valorizacien"). Each defect, fixed:

- **A line is re-read only when its shapes can read it.** Where the alignment
  KEEPS a label, the run should plainly be that letter (thin strokes agree
  with each other). Under 80% of at least 8 kept letters, nothing on the line
  changes. MSP lines read 88–99%; the form's failed.
- **A word the document reads elsewhere is not re-read into one it reads
  nowhere** (`wordsLeavingVocab`). The atlas counts every word of the
  recognised pages (`forms`, `vocab`); each token of the old reading that is
  a word of the document (three letters read elsewhere once, two letters
  three times) is followed into the new text by aligning the two letter by
  letter, and unless it comes back intact or only as words the document also
  reads, the ink words holding it keep their old labels and the line is
  re-read around them.
- **A double quote is two strokes**, and the page holds no shape for it: two
  neighbouring runs that both hang where a quote hangs are one quote. Read as
  two, the second tick took the next label and its letter was read twice.
- **A label the analysis found no ink for is not shown absent if it is a
  mark** — a colon's dots are specks, and "PROYECTO:" came back "PROYECTO".
- **A full stop or comma is named by its PLACE** (`markAt`: a small blob at
  the foot of the line, on the baseline or hanging below it). Its shape is a
  blob the atlas barely knows, so the shapes never named it: unnamed, the
  comma after "Perú" took the "ú" label and the "ú" was read as a "d" —
  "Perdú". Named, "Perú,", "período. La forma" and "Business One, versión"
  came back right.
- **A word's FIRST letter may be a capital, and a word of letters takes no
  figure**: read by the rest of its word, the "S" of "Software" became the "3"
  it looks like, and the "L" of "Licencia" an "l". When the word's kind
  decides, its rivals are of that kind too.
- **Thin strokes**: where the line's own exact i's show their dot apart, an
  undotted stroke is no "i", "í" or "j" ("el" came back "ei"); a stroke
  clearly taller than the line's capitals is no capital ("la" came back "Ia");
  and a re-read word one i/l/I stroke from a word the document reads twice is
  that word (`lookalikeFix`, only for words the re-read changed).
- **A small letter followed by a capital inside one word** ("eL") is refused
  unless the reading had that shape already.
- **Ink taller than any letter, that looks like none, is drawn OVER the
  word** — a signature's stroke, a stamp's edge — and the word under it is
  not re-read from its runs: "Add-Ons" came back "Adddnns".
- **An accented vowel is also read from the letter under its mark**: judged
  whole, the mark outweighs the vowel. (It did not fix "número" → "nómero":
  this page's "u" under its accent matches the "o" medoid 0.73 against 0.70 —
  the shape grid barely sees an open top. `lookalikeFix` now does: its pairs
  include ó/ú, á/í and v/y besides i/l/I, so a re-read word the document reads
  nowhere, one such swap from a word it reads twice, is that word. A v/y swap
  needs three characters — "va" and "ya" are both words.)
- **Over a rule, a descender is cut off**: an underline or a table cell's
  rule runs where a descender hangs, so such a run may show none and a
  descender label is never replaced by a letter without one ("Upgrade" came
  back "Uugrade").
- **A refused word hands its labels back both ways**: a word that keeps its
  old labels reverts every neighbour whose alignment took one of them AND
  every neighbour one of whose labels its own alignment took. Refused, "N" →
  "N2" kept the "2" of "2039277697", which came back "039277697".

Measured with `repairall <page>` (every line's reading beside its repair):
MSP 18/29/15 lines repaired on its three pages; the errors left are
"Regaláas" (for "Regalías") and "v/o" (for "y/o") — "nómero" is now read
"número" by the wider look-alike pairs; the other two appear nowhere else
on the three pages the lab reads, so there is no second reading to defer
to — each replacing a word the recogniser had wrong too ("Professional", which looked like one, is
what the scan says); the form 12 repairs, every
one wrong (an amount among them, "13,000.00" → "1 3,000 00"), to none; a
certificate 6, all wrong, to none. The MSP edit suites draw exactly the same
pixels; `scanedit.test.mjs` passes.

### The editor opens on the page's own reading
PaddleOCR loses the spaces and letters at the joins of small body text, so the
editor opened a contract's lines as "Lostérminos queenel presente Apéndice
sean,serán términos deinidos" and the user edited THAT: every change landed in
a garbled line, and whatever they did not retype stayed garbled in the text
layer. After a page is recognised, `repairReadings` (useOCR) re-reads every
untouched run from the page's own letters in the background — the same
`repairReading` an edit uses, with all of its gates, so a line whose shapes
the atlas cannot read stays as recognised — and stores the result as the
run's text AND its original: it is the reading, not an edit, and nothing is
baked.

- **Only runs nobody has touched**: not edited, removed, moved, restyled or
  baked, not the selected one (an editor may be open on it), and still read
  as they were analysed. It yields between lines and stops if the page is
  recognised again.
- **Only prose, and never a figure** (`repairIsDisplayable`): three ink
  words, fifteen letters, mostly small letters, the same digits before and
  after, and no mark put in front of a line that began with a word (a bullet
  read as the "*" the page has). On a table of names in capitals every repair the re-read made
  was wrong — a cell border or a speck after a name has no label, the
  alignment shifts the letters onto it, and a name came back with two letters
  inserted; and an RUC came back with a "5" in the wrong place, which reads
  as the document's number, not as a typo. An edit's own repair is not held
  to this: the user is changing that line, and the repair only steers where
  the change lands.
- **"Reconocer texto en este archivo" waits for it** before writing each
  page's layer (`settleRepairs`), so the searchable text is the corrected
  reading as well — a couple of seconds a page on top of recognition.
- **The page analysis it needs yields every eight lines**, and two callers
  asking for the same page share one build (`scanPageFor`): it now runs the
  moment recognition ends, where before it ran as one block of a second and a
  half at the first edit.
- **The atlas keeps the letters of eight pages, the eight used last**
  (`MAX_HARVESTS`). A page's harvest holds 4 to 10 MB of glyph crops
  (measured: 2,700–4,100 exemplars a page on the MSP appendix), and with every
  recognised page harvested, "Reconocer texto" on a hundred-page document
  would have kept well over half a gigabyte. A document sets its pages in the
  same few faces; a page in use is touched, so it is the last to go.
- **Whatever looks runs up by their text waits for it**: the editing
  assistant's `recognise` awaits `settleRepairs()`, and so does the fidelity
  driver (`__pdfHooks.ocrController.settleRepairs`). A suite entry may carry
  an `alt` lookup for the line as the re-read leaves it ("USD 30.00" comes
  back "USD 630.00", "de 026" comes back "de 2026").

Measured on the MSP appendix: 16, 28 and 14 lines of its three pages read
again (`BG=1 repairall <page>` in the lab), the editor opening on "Los
términos que en el presente Apéndice sean, serán términos definidos …"; in
the browser the 14-edit suite stays on the scan with no damage, and a page
recognised with "Reconocer texto" carries "Niveles de Corrección, paquetes de
actualización" in its layer where the recogniser read "Corrcción,aquetes de
actualizción". Over 17 other recorded documents the gate lets 2 lines through
(and the bullet rule then none); a table of 496 names, none. The OCR sweep
(51 documents) is unchanged on the scan path; without the gate a short
heading's changed reading moved a deletion onto the wrong letters and left a
grey smear on a cover — the gate keeps such lines as recognised.

**After `cp` into `src/`, rewrite the file once** (read and write it back):
the dev server missed a copied `scanEdit.ts` and kept serving its old
transform, the new import failed, and the app came up with no stores at all.

### A title's thick strokes are ink, and ink brighter than its ground cannot be printed
`preparePage` finds ink with a 3.6pt max filter and fills it from the paper
around it. A stem wider than the filter's reach is never seen through: on a
300 DPI bilevel cover the 45pt bold title's stems are 34 px, their middles
were read as PAPER, and the estimate around every letter came out grey —
deleting one letter printed grey halos round the letters it moved and left a
grey smear where the line had ended. A near-black pixel with white paper
(247 or more) on BOTH sides along one axis, within 24pt, is now ink too: the
inside of a stroke, or of letters that touch (dark runs of 80 px on that
title).

Each limit on that rule was measured, and each was a failure first:

- **Only on white paper** — a page whose non-ink pixels are 240 or more at the
  median and 225 or more at the 10th percentile, and white paper on both
  sides of the pixel. Applied anywhere, a certificate's patterned light-blue
  ground (243 at its lightest) stopped reading as a gradient, and two of its
  lines were let through and edited badly: a moved word carried a pale box of
  smoothed ground, and "ALTIMETRÍA" came back "ALLTIMETRA". The old estimate
  had refused them for the wrong reason, but rightly.
- **Never on the inverted page** — lettering reversed out of a band
  ("OFFERS" in yellow on purple, "PIENSE" in white on red) was let through
  the same way and came back pinkish, with the old letters' drop shadows left
  as ghost rings and colour fringes as red specks.
- **Ink brighter than its ground in any channel is refused** ("the lettering
  is a colour its ground cannot be printed with"): letters are printed as ink
  MULTIPLIED onto the paper, channel by channel, and a product is never
  brighter than the paper. Yellow on purple, read inverted, is blue on green
  — its blue channel above the ground's — and that is what came back pinkish.

On 22 recorded documents the analysis changes on one page only (the cover
itself, where words' measured weights move by a few thousandths); the MSP
suite is pixel-identical, and the cover's deletion comes back clean white.
The rule costs about 0.4 s on a 300 DPI page.

### The vector redraw on a condensed cover: no lost letter, and the face's width kept
Deleting one letter of a condensed bold cover title ("NAPOLEON HILL" →
"NAPOLEN HILL", red ground, so the vector path) erased the "H" of "HILL" and
never drew it again. Three separate things, each found by following that one
edit through the bake:

- **The word split was wrong, and nothing checked it.** On the coloured
  ground no word could be cut, so the line was split into words by its ink
  and the reading shared out by width — and the split fell between the "H"
  and the "I" (first word 230pt where the scan's is 199pt; second word 30%
  narrower than its letters). The partial redraw widened the edit to the
  whole first word, the "H" with it, and patched it out. `planPartial` now
  refuses when the boundary at an edge of the edit is one LETTER off
  (`boundaryOffByOne`): one word too wide and its neighbour too narrow, both
  fitting once a letter crosses over (0.12 and 0.30 off; 0.01 and 0.05 with
  the "H" moved). The run is then redrawn whole and nothing of it is lost.
  A word's width error on its own is NOT the test, and was tried first: a
  wide display face ("UNAJMA" in a techno face, its "U" and "N" half again the
  advance table's width) is off by 0.3–0.5 letter by letter with every split
  right, and the guard sent a partial redraw that kept four of the scan's
  letters to a whole redraw in Helvetica.
- **A whole-run redraw keeps the original's width.** Its size is the
  letters' own once the cut has measured them, so a base-14 face set wider
  than the scanned one ran a fifth past the box. The original words, measured
  in the drawing face (`originalWidthAt10`), against the ink they took, give
  the squeeze; the new text gets the same (`fitWidth`, never below 0.7), for
  a left-aligned run neither restyled nor moved. The bake measures in the
  base-14 face as well and falls back to it when the traced face cannot
  measure a run exactly.
- **A single text op dropped its fit.** The bake drew a group of one with
  `addText`, which has no width to fit to; a fitted single op now goes
  through `addTextRun` like a group.

And in `groundFill`: a shape of the run that the patches only CLIP, most of it
outside them, is left alone — a kept letter a misplaced boundary cuts into is
not half-erased. (It did not save this "H", which the bad split had put wholly
inside the patch; that is what the planner check is for.)

Measured in the browser on that cover: before, `partial` with the "H"
erased; after, `whole` with "NAPOLEN HILL" set condensed inside the old box,
damage outside the plan 0 (was 7068 px with the plain whole-run redraw).

**Known limitations, both on covers:** a STENCIL face whose letters break at
a notch as wide as its letter spacing (the "N" of that "UNAJMA": 33px inside
the letter, 26–33px between letters, at a 141px em) is split into ink words
mid-letter by any gap threshold, and a partial redraw next to that letter
cuts off its far half. A TWO-TONE title ("APOCALÍP" black, "SEX" grey on a
green gradient) is measured on its dark half only: the ink box stops at the
grey letters, the reading's last letters are shared over the black ink, and
whichever redraw follows leaves the grey half on the page beside the new
text.

### Text drawn under `3 Tr` cannot be edited into view — a searchable layer makes the page a SCAN
Acrobat's "Reconocer texto" (and ABBYY, and this editor's own layer below)
leaves a scan's words in the content stream as INVISIBLE text: render mode 3,
one BT, ordinary fonts (Times, Helvetica, `HiddenHorzOCR` only for the words it
doubted). MuPDF extracts them like any text, so the edit tool listed the words
of a signed contract, the user edited one, the engine rewrote the glyphs
faithfully in the same mode, and the page did not change: "when I edit it it
does not show". Render mode is graphics state the extraction does not report,
so it is read off the stream: `collectShowOpOrigins` walks every content
source once (q/Q, `Tr`, the text matrix as `scanShowOps` tracks it) and
records where each show op draws, in top-left page space, and whether it is
visible; `markInvisibleBlocks` flags a block whose glyph origins coincide only
with invisible ops (`TextBlock.invisible`). A block with hits on both sides is
left visible — hiding a real block makes it uneditable, the worse error — and
a block matching no op at all is invisible only on a page whose EVERY op is.

Three consumers: `textLayerOf` ignores flagged blocks, so the coverage judge
calls the page a scan (the visible Intellisign ID strip alone is under 2%);
`TextBlockOverlay` never offers them (`hiddenLayer` also lets a click on the
paper recognise the page while the strip stays editable as text); and the bake
calls `blankInvisibleText` under each edited run, so the old words are not
found by search beside the new ones. A font-name test would not have done:
the layer's fonts are the page's ordinary faces, distinguished only by the
RESOURCE name under which the visible strip is set.

Measured on the contract (43 pages, Acrobat-OCR'd, Intellisign-signed): page 3
reports 49 invisible blocks and 1 visible, page 1 of real text none; the click
recognises the page, "MSP-SIST-CS-2025-004" edits to "-2026-999" with the scan
pixels kept around the changed digits, extraction reads the new number and no
longer the old. Text sweep experiment-identical to baseline (262/236, 0/0/0).

### "Reconocer texto en este archivo": a searchable layer, tagged so it can be replaced
`recognizeDocument` (layout; dialog `OcrRecognizeDialog`, menu item under the
OCR button) recognises the chosen pages and writes each an invisible layer —
`3 Tr`, one run per recognised line, `Tz`-fitted to the width of the ink it
stands for, one `addTextRun` per page — inside `/OCRLayer BMC … EMC`.
`removeMarkedContent` blanks that section before a re-run, nesting-aware, so
recognising twice leaves ONE layer; pages with real text are skipped, pages
that already carry a layer (Acrobat's or ours) are skipped unless "replace",
in which case `blankInvisibleText` over the whole page clears the old one.
One undo point for the whole run: the snapshot is pushed just before the
final sync, when the store's bytes are still the pre-run document.

Three things measured wrong first:
- **`maskStreamLiterals` blanks NAME tokens**, so `/OCRLayer BMC` searched on
  the masked stream matched nothing — the layer was written, `hasMarkedContent`
  said no, and a re-run would have stacked. `findTagBmc` searches the RAW
  stream and accepts a hit only where the masked stream still shows the
  operator (inside a string it would be blanked too).
- **One character no face holds failed a whole page's layer.** Paddle read a
  "①" and `addTextRun` refused the 54-run object ("Characters not supported by
  Helvetica: ①"), leaving page 3 with no layer while page 4 got one. For an
  INVISIBLE part the character costs nothing visible, so `dropUnencodable`
  strips it and the run is encoded again; a visible part still refuses.
- **A CJK subset per RUN is ruinous at layer scale.** `registerCjkRun` embeds
  a subset per segment, right for one edited line; a bilingual page has a
  dozen Chinese lines and the layer cost ~150 KB a page. `sharedCjkFontFor`
  registers ONE subset for the union of the object's non-WinAnsi glyphs and
  every segment encodes against it (162 KB for two pages, was 316).

The layer's runs stay in the OCR store, so any line can be edited afterwards
exactly as on a page recognised by hand.

### A move is decided by where the target is DRAWN — four silent wrong-block moves
Round 7 of the sweep found four moves that reported success and moved the
wrong text, each a different way of letting text or stream order decide what
only position can. All four reproduce in the node harness in seconds.

- **A bucket tie fell to stream order.** Two consecutive e-mail lines
  ("1) El proveedor…" / "2) El proveedor…", one BT each, 13pt apart) both
  fuzzy-match at score 1 and both land in the 8pt bucket 0; the tie went to
  `order`, which is the line ABOVE, and that is what moved. The candidate sort
  now breaks a bucket tie on the run's DRAWN position first
  (`runDistanceToTarget`, min over the candidate's blocks — a rotated
  inventory sheet holds each of its two "CANTIDAD" cells in a different huge
  BT whose origins are both 508pt from the click, so the block's origin says
  nothing) and on the real distance second.
- **`findTargetRun` took the first run that scored.** A Ghostscript timesheet
  draws adjacent rows from ONE block and repeats the same activity in the same
  column, so both copies scored alike and the row above moved. The x-overlap
  test cannot see it (same column) and is only asked when every width is
  known; runs are now ranked ROW first — `op.y` against the clicked box, 6
  page points, the bar `findTargetSegment` already uses — then score. It ranks
  rather than refuses, so where the row cannot be told the choice is what it
  was.
- **The exclusivity test was gated on the 1.4× size ratio.** A Ghostscript
  letter draws "Atención: Oficina de Abastecimientos", two blank lines and the
  body line from one BT under one Tm — 124 glyphs against a target of 87,
  just under 1.4×+4 — so `governingTmIsExclusive` was never asked and six
  blocks moved for a one-line drag. `holdsOtherText` (three glyphs of slack)
  asks it whenever a governing Tm exists; a Tm that governs other text falls
  to the Td bracket, then the segment shift, then a refusal. A block with no
  governing Tm keeps the whole-block move it always had.
- **A match made on '?' wildcards moved 15 blocks.** A Type3 font with no
  ToUnicode decodes as "????259???2??…"; `wildcardIncludes` lets a '?' stand
  for anything, so a 15-line block CONTAINED every target on the page.
  `readsOnPlaceholders` refuses a non-exact move candidate whose KNOWN glyphs
  carry less than half of the target (longest common subsequence). Judged
  against the target, NOT as a share of the decode: a Corel block reads
  "???????????????????TUBERIA EMT" because its `/Corel_OTF <<…>> DP` operand
  literal is walked as text, and a ratio test refused a match that rested on
  no wildcard at all — one experiment lost before the measure was changed.

Measured on all seven corpora against same-day baselines: main 262/236 → 237,
r2 439/393 → 396, r3 466/413 → 414, r4 462/416 → 416, r5 446/409 → 410,
r6 551/502 → 502, r7 420/369 → 373 — ten gained, zero lost. Every changed row
was read: eight `tm_rewrite_governing → td_bracket_run` rows go from TWO
blocks touched to one (the "CONTRATO / ORDEN DE TRABAJO" template family,
"Proyecto", a supplier form title), three `tj_segment_shift →
td_bracket_run` rows are the same outcome to the point (the trailing space
op stays behind in both, as it did before), and every gain is the
"wrong copy of a repeated cell" class (geometry_error 0.02 → 0).

**Known:** a label drawn as one-word BTs and repeated across three signature
columns (r6/038, "Nombres y Apellidos – Sello") still tears — it did before,
on a different word — because the line group holds all three copies and no
join matches.

### A CID row takes a substitution AND keeps its columns — two gates, one table
Microsoft Print to PDF draws a timesheet row as ONE BT holding ONE TJ array
("06-05-26 16:00:00 18:00:00", cells separated by kerns) in a CID subset that
holds digits and little else. Every cell edit needing a letter refused with
"Could not find matching text" — ten rows across three files in round 7 —
while "DPTO:" → "AREA:" on the same producer had been measured working when
`readCidWidths` went in. The gate added AFTER it (`encodingName === 'Unknown'
&& codeBytes !== 1`, meant for two-byte SIMPLE fonts whose codes index
/Widths as garbage) also matched every Type0 font — a Type0 is always
'Unknown' (its /Encoding is a CMap name) and two-byte by design — and took the
CID branch straight back. The gate is now simple-font only; a Type0 is
admitted by the branch above it, which already demands a known /W.

Opening the gate ALONE edited the wrong row, and the sweep would not have
seen it (its markers never take this path). Containment candidates were
ranked by the OP's start (`opRunDistanceToTarget`), and every row's array
starts in the same column 150pt left of the clicked cell: all rows measured
148pt, fell into one 8pt bucket, and the tie went to the first row in the
stream. `runDistanceToTarget` — the per-RUN measure built for the
one-character label — now reads a CID font's /W as well as /Widths, answers
in PAGE points (it answered local units; a `0.75 cm` stream scaled them),
and ranks the containment candidates of both the REPLACE matcher and the MOVE
matcher's carrying blocks; the op-start distance is the fallback when no run
is found. The move had the same tie: at HEAD a drag on row two's "16:00:00"
moved row ONE's, silently.

The same-font (keep-hex) compensation kern read /Widths only, so a CID row
got NO kern after a same-subset edit and every later cell shifted by the
width difference — "01-01-26" → "AREA" moved the "8:00" and "16:00:00" beside
it 8pt left, and an empty replacement 21pt. It reads /W now, like the
substitution branch. Measured on the three timesheets: "16:00:00" → "17:30:00",
"8:00" → "9:15", "01-01-26" → "AREA", "" and "SWEEPMARK50" (Helvetica
substitute) each land in the clicked cell with the row's other cells at their
original x, and a cell drag moves its own row. Sweep: r3 +4, r5 +6, r7 +7,
zero lost; the "changed" rows are a 4-character cell replaced by an
11-character marker that overruns the next cell (char_delta 0, the neighbour
unmoved) and a right-edge cell whose marker is clipped — both the documented
justified-line limitation, and both were refusals before.

### /Resources is INHERITABLE — dompdf keeps it on the /Pages node
`pageObj.get('Resources')` answers MuPDF's null object on every dompdf/CPDF
page (15 of round 7's 60 files), the `.get('Font')` after it throws "Cannot
read properties of null (reading '_fromPDFObjectKeep')" (689 times in one
sweep), every reader caught that as "no font", and the family was edited
blind: no ToUnicode, no /Widths, no glyph-availability. Worse, the WRITE
sites created a fresh empty /Resources on the page, which SHADOWS the
inherited one — a substitution on a dompdf page reported "cannot find XObject
resource 'I1'" and lost the page's image and every font it drew with.
`pageResourcesOf` reads with `getInheritable`; `ownPageResources` (for
writes) starts the page's own dictionary as a copy of the inherited entries,
so nothing already on the page stops resolving and nothing registered for
one page reaches the others. All seven corpora experiment-identical.

### A fallback glyph is stroked up to the scan's stems; a traced one at half the width
The user's edited contract showed "MAESTRA" appended to a scanned bold title
visibly lighter than the letters beside it: the scan's stems measure 0.161 em
(the face detector's own cue) and Helvetica-Bold's 0.138. `OcrTextItem.strokeRatio`
keeps the detector's measurement of the run; `ocrStroke.ts` turns the
difference against a per-face stem table (calibrated with
`tools/ocr-calibrate/measure.mjs` — run `build-sample.mjs` first) into a line
width, and the worker draws FALLBACK segments in render mode 2 with that
width in the text's own colour (`strokeWidth` on `TextRunPart`/`addText`,
`2 Tr`/`w` set per op inside BT). Traced glyphs get their own
`tracedStrokeWidth`: an outline traced at the mass-conserving level renders
crisp and lighter than the blurred stems it came from (0.148 against 0.172),
and each traced glyph remembers the weight measured on the bitmap it was
traced FROM (`strokeRatioOfImage`). At HALF the nominal width — potrace leaves
many short segments and a round-joined stroke puffs every one, so 0.37pt
took the title to 0.197 em where 0.185pt lands it on the scan's 0.172.

**On light lettering the ink is the LIGHT side.** `detectFace` split ink from
ground at the midpoint and called the darker side ink, so on a reversed title
it measured the GROUND: the blue between the letters of a cover's
letter-spaced "NATURE" read as stems, the run came out heavier than any bold,
the stroke went to its cap (0.05 em — 3.3pt on a traced glyph at 132pt, 6.6pt
on a fallback one) and every redrawn letter's serifs melted into blobs.
`detectFace` takes `lightOnDark` (`isLightOnDark(color, background)`, from the
colours the recogniser and the bake already sample) and measures the light
side. Measured on the four reversed-text covers: "NATURE X" redraws with the
traced letters' own thin serifs and a regular X (damage 22 497 → 13 744 px),
"OFFERS X" 86 660 → 62 868, "$100M X" 7 918 → 5 762. The same wrong polarity
had marked every reversed run bold and measured its slant on the ground.
**Known:** the traced "$100M" is visibly thinner than the scan's extra-bold
figures; the wrong stroke used to hide that, and the trace's own weight there
is not fixed.

### The patch covers the ink's HALO, measured
Deleting "MINERA SHOUXIN PERÚ S.A." left the accent of the Ú on the page: the
ink box stops at the caps and the fixed 12% pad did not reach two rows up.
`measureHalo` (ocrSampling.ts) walks each edge of the box outward on a fresh
220 DPI raster at bake time — faint rows (JPEG ringing, any visible tint) are
always taken, sparse dark rows (an accent, a descender) are taken, dense dark
rows (the next line) stop the walk, and up to two clean rows are looked
across for a floating accent — and `item.halo` widens the patch in
`patchRect` and in the partial redraw (top and bottom separately).

### A stretch takes the weight of the letters it is GLUED to
"Conste por el presente documento el CONTRATO DE "MEJORAMIENTO…"" is regular
up to the quote and bold after it: one OCR line, one face verdict (bold), one
scan face keyed by that style. Typing "CONTRATOS" traced the S from "SALA" in
the bold half and drew it heavy inside a regular word. Every cell of the
glyph cut carries its stem ratio (`cellStrokeRatio`, `SpanCut.cells[].weight`);
`weightPlan` compares the face's glyph against the cells beside the change
and lists disagreeing characters in `faceSkip` (the worker's `segmentRun`
leaves them to the base-14 face; `measureRuns` honours the same list, or the
stretch is measured at the wrong glyph's width). The base-14 face's weight
comes from the detector run over a window of the neighbours' own ink
(`measureRatio`, the six cells on the side the stretch is GLUED to — the bold
quote after the space says nothing about the S), against the detector's
calibrated bar; the per-cell ratios cannot decide this — quantised to a pixel
of the em and light on any thin letter, they say "different", never "bold".
A split-the-line's-weights heuristic was tried first and put the split in
the wrong place for exactly that reason.

### An appended run resets Tc — the page's stream leaves one in force
Acrobat's OCR layer ends its stream with `-0.035 Tc`, and text state outlives
ET: every object this editor appended inherited it, so each glyph's pen fell
0.03pt short of its advance. An invisible head fitted to 150pt drew 149, and
the extractor read the gap before the stretch as a space — "MSP-SIST-CS-202
6-777", "CONTRATO S DE". `addTextRunToPage` and `addTextToPage` open with
`0 Tc 0 Tw 0 Ts`. `tools/pdf-sweep/fit-check.mjs` draws a fitted run in node
and measures it back (the CJK face is served from `public/` through a
patched `fetch`; the worker reaches opentype.js through the `ot` shim so the
SSR loader's `default` wrapping does not break it). The invisible head and
tail are also fitted to within a hair (0.3pt) of the stretch where the text
has NO space at that boundary, so the extracted advances meet; where it has
one, the gap is kept to say so.

### A run edited AGAIN after a bake blanks and covers its first bake
The second edit patched the ORIGINAL ink box and blanked only invisible ops,
so the first bake's visible stretch stayed on the page beside the new title
and every extractor read both. `blankInvisibleText(…, all)` blanks every op
whose origin lies under the edited rects (the patch covers them anyway), the
rects include baked runs, and after a bake each run's ink box grows
horizontally to what its patches painted (`PatchOp.item`, net of the pad —
taking the padded rectangle would grow the box by a pad on every bake). A
baked run's glyph cut is forgotten, so its second edit is a whole-run redraw
from the face; with every glyph traced and stroked that reads as one weight.

### `measureRuns` loads the CJK face before measuring
The first Chinese edit on a page measured `exact: false` (the face was only
ever loaded by the writers) and the partial redraw declined with "width
unknown" — a whole line redrawn for one added ideograph. The handler awaits
`ensureCjkFontFor` like `addText` does.

### pdf.js needs its WebAssembly decoders served, or a page never paints
"I edited this text but after blur it returns to the same text": the engine
had applied the edit, the status bar said "Text replaced", and the canvas kept
the old line. pdf.js 5 decodes ICC colour spaces, JBIG2 and JPX through
WebAssembly modules fetched from `wasmUrl`; unset, the fetch 404s and the
render NEVER SETTLES. This editor's own OCR bake writes an ICC-based image
(the transplanted tail of a partially redrawn line — a PNG MuPDF stores under
sRGB ICC), so a scanned page edited that way (page 3 of the user's contract)
rendered in 8 ms in MuPDF and timed out at 30 s in pdf.js, and any JBIG2 or
JPEG 2000 scan was in that state from the start. `pdfjsDocumentOptions`
(usePDFViewer.ts) points every `getDocument` — viewer and thumbnails — at
`public/pdfjs/{wasm,iccs,cmaps,standard_fonts}`, copied from `pdfjs-dist`
(3.2 MB; re-copy when pdfjs-dist is upgraded). Production must serve `.wasm`
as application/wasm and may cache `/pdfjs/*` for a year.

The second half of the same report: the render queue is SEQUENTIAL and paints
the neighbouring pages in the background, and an edit saves and RELOADS the
document while such a render is in flight. `getPage`/`render` on a destroyed
pdf.js document never settle, so `renderBusy` stayed true for good and the
edited page sat behind it — even a scroll could not repaint. A reload now
drops the document reference BEFORE destroying it, bumps a generation and
wakes every in-flight render (`abandonRenders`; a render races each await
against that wake-up and returns nothing, so the queue re-queues the page and
moves on), and a render arriving mid-reload waits for the new document rather
than burning its three retries. Measured with the headless-Chrome
reproduction (`scratchpad/pw/edit-repro.mjs`: type into the inline editor,
blur, hash the canvas): unchanged before, changed right after blur now.

### On a scan the picture IS the page — it is never an object to drag
A screenshot showed every edited line of the scanned contract page twice, the
photographed words a few pixels from the patches and replacements written for
them. In the select tool the page-covering scan image was an ordinary object,
and a click that wobbled three pixels dragged the whole picture, while the
text and patches an earlier OCR edit had written into the content stream
("MAESTRA", the replaced paragraph line, the paper painted over a deleted
title) and the recognised runs stayed where they were. The page-filling image
of a scan page is `paper` in EVERY tool now (it was only in the edit tool),
a recognised page counts as a scan whatever the cached verdict says, and a
page-covering image needs an 8px drag before it counts as moved. Should one
still move (a scan-like page without the verdict), `ocrController.scanMoved`
shifts the page's runs with it and `scanChanged` drops them after a resize,
crop or deletion, with a status line. The headless-Chrome reproduction is
`scratchpad/pw/drag-scan.mjs`: a 20px drag on the scan's margin used to
report "Image moved"; now the press lands on the marquee surface.

### The editing assistant: a chat whose replies are engine calls
`AssistantPanel` (right drawer, `smart_toy` toolbar button) sends the user's
request to OpenAI with function-calling tools (`src/utils/assistant/`) and
`createAssistant` (`src/composables/useAssistant.ts`) executes each tool call
against the engine. Verified in the browser: "Cambia X por Y", a three-action
request (delete + highlight + recolour), "Deshaz el último cambio", writing a
bold red run under the last line, and on a scan: recognise, then edit an OCR
run that bakes on save. Four things it has to do the app's way:

- **It is built in `EditorLayout`**, with the layout's own `syncAfterEdit`,
  `pushUndo`, page ops and OCR runner passed in, because a second copy of
  the save→reload sequence would drift from the first. Every mutation is one
  `enqueueOp`: engine call → `pushUndo()` (bytes are still pre-edit) →
  `syncAfterEdit()`. A whole request holds a `beginTransaction()`; the `undo`
  tool RELEASES it around `undo()`, which waits for transactions to settle
  and would otherwise deadlock on its own.
- **A reference the model sees is an ANCHOR**, `p1b12` → {page, text,
  centre}, re-resolved from a fresh `getTextBlocks` before every call with
  `findByAnchor`'s rule (same text, nearest centre, twins over 24pt rejected).
  Block ids are renumbered by every reload, so the third action of a request
  cannot use the id the first one saw. OCR runs (`p1r3`) keep their store id.
- **The model sees the current page's listing before EVERY turn** (positions
  in page space, top-left, points) as a transient system message, never in
  the history: the listing is stale the moment an edit lands.
- **A phrase that spans lines is edited with `replace_in_page`, not per line.**
  Extraction splits a paragraph or table cell into one block per line, so a
  phrase the user names ("MEJORAMIENTO DE LA SALA DE COMUNICACIONES" on the
  SUPRA invoice) begins in one block and ends inside the next; a per-block
  `replace_text` changed only the first and stranded "COMUNICACIONES".
  `replace_in_page(page, find, replace)` (`replaceAllSpans`) locates the
  phrase across the ordered units whitespace-insensitively, puts the
  replacement in the first unit, trims the last to what followed the match,
  empties the middle, and applies them in one save→reload back to front (or
  per OCR run). It changes EVERY occurrence on the page by default and reports
  the count — "change X to Y" on a name or date repeated through a form means
  all of them (measured: the approval form had 4 copies of "PLAYA HERMOSA",
  one split across two blocks and one mixed-case; a first-occurrence-only
  replace changed one and falsely reported done). `occurrence:"first"`
  restricts it. Matches are found once on the original text (a replacement
  containing the search text cannot loop) and applied right to left.
  `replace_text` stays for rewriting one whole listed block. A whole-document
  change ("en todo el documento") goes through `replace_in_document(find,
  replace)`, which edits every page in one call — text pages directly, scanned
  pages by recognising them itself (capped per call so it stays responsive; a note says how to continue) — and returns a per-page
  report; done by hand across tool rounds the model edited some pages,
  recognised another, and declared it finished without editing that one
  (measured: page 6 of contrato111 left unedited while it claimed "en todo el
  documento"). **Known limitation:** where extraction merges an overlapping element into a block
  (the SUPRA invoice's "NIUMEJORAMIENTO", a shuffle), the kept prefix collapses
  its gap and can render glued ("NIUIMPROVEMENTS").
- **`highlight_text` on a single word matches WHOLE words, not substrings.**
  PDF search is substring-based, so highlighting "RUC" also lit it inside
  "INFRAEST**RUC**TURA"; a match is kept only when the overlapping block holds
  the word with non-letter/digit boundaries. Multi-word phrases skip the
  filter (a substring-in-word is not a risk there).
- **A scanned / OCR'd page is routed to the OCR flow, not `replaceText`.**
  `pageMode` calls a page `scan` when its INVISIBLE text (a searchable OCR
  layer — Acrobat's or this app's) carries more characters than its visible
  text; `isScanLike` alone is not enough, because an Intellisign-signed
  contract's visible stamps ("Intellisign ID…") give the page enough
  characters and coverage to read as a text page while its whole body is
  invisible (measured: contrato111 page 3, ~2000 invisible chars vs ~120
  visible). `replaceText` on that layer changes nothing the reader sees and
  usually fails to match. For a `scan` page `list_page_text`/`find_text`
  return "call recognize_page(N)"; the model recognises it, edits the `r`
  runs (`ocrStore.updateItem` + `traceItem`, as `OcrTextLayer.commitEdit`
  does), and the change bakes on save. Verified on contrato111: pages 1-2
  (real text) edit via the block path, pages 3+ (the scanned signed copy)
  via OCR — "PLAYA HERMOSA" → "ISLA HERMOSA" bakes to real page text. An OCR
  run rewrite that equals the current text reports a no-op so the model can
  correct rather than seeing a false success.
- **The key is the user's own**, in localStorage like Mistral's; a DEV build
  seeds it from `.env.local` (`VITE_OPENAI_API_KEY`, gitignored) behind an
  `import.meta.env.DEV` guard so the production bundle can never carry it
  (checked: `grep sk- dist/assets/*.js` finds nothing). Consent is asked
  once per session, as for Mistral. No SDK: `api.openai.com` sends CORS
  headers, and COEP does not govern `fetch`.

### A restyle RESTORES what the block left in force — it never wraps in q/Q
Recolouring one line of a Chrome-printed work order turned five lines of the
numbered list under it into glyph garbage (637 characters changed by a colour
change), and on a PDF24 slip a line vanished with "cannot draw text since font
and size not set". The restyled block was wrapped in `q … Q` so its new colour
and size could not leak into later blocks, and the `Q` did more than that: it
discarded the `Tf` and colour the block had SET for the fontless blocks after
it. `stateRestoreAfterBlock` puts the block's original last `Tf` and fill colour
back after `ET` (`fillColorStateAt` replays colour through q/Q the way
`fontStateAt` replays fonts; `lastFillColorIn` reads the block's own). Restoring
beats resetting, the same rule `rebuildBtContent` follows.

Three more things the realistic sweep (`tools/pdf-sweep/sweep-real.mjs`: same-
width edits, deletes, appends, resizes, recolours, page-2 edits — 7300
operations over the seven corpora, a fresh document before every one) found in
the same path, each measured on its file:

- **Colour is set for the target's RUN, not for every op in its block.** A
  LaTeX title shares one BT with the abstract and the body column; replacing
  every colour op in the block turned the abstract red while the title — set
  by an op BEFORE the BT — stayed black. `color_rewrite_run` brackets the run
  (`findTargetRun`) with the new colour and what was in force at its end;
  `color_rewrite_segment` does the same INSIDE a TJ array (a Ghostscript or
  Print-to-PDF table row: "18:00", "DPTO:"), splitting the array around the
  cell as the segment move does. A size change on a segment is refused. The
  sweep's recolour experiment now counts OTHER blocks that turned red, which
  is what exposed twenty "successes" that had recoloured a whole row.
- **A containment match that rests on placeholders identifies nothing.** A
  Corel datasheet block reads "???????????????????Propiedades mecánicas…"
  (its `/Corel_OTF <<…>> DP` operand walked as text) and nineteen '?' matched
  "AZUFRE:0.045%Máximo" exactly; that block sat nearer the click than the
  right one, so the composition row's recolour landed on the mechanical table
  below it. `readsOnPlaceholders` judges the whole decode by LCS and is lenient
  on a long block; `wildcardRestsOnPlaceholders` looks at the best ALIGNED fit
  and refuses one that is more than half '?'. Both containment passes use it.
- **A block the position matcher cannot see is reached through containment.**
  An Adobe guía draws its whole form as ONE BT; `findContainingBlockNear`
  (the replace matcher's containment leg, nearest run first) hands it to the
  run-scoped rewrite.

### A wrapped continuation never lands on another table row, and a word is broken only past the paper
`wrapRoom` refused to wrap a cell within three em of the margin, a bar
measured on two files; a third cell sat half a point past it. On an itext
invoice "$ 0.00" had 23pt of room against a 22.5pt bar, so appending a word
wrapped it onto the totals row beneath ("ok" drawn across the next "$ 0.00"),
and a dompdf inventory broke a status word mid-letters ("SWEEPMA" / "RK27")
onto the row below. `continuationLineIsTaken` reads the SHAPE of a table row —
a neighbour of two or more glyphs on the target's own row to its left, and text
already in the band one leading below across the room the wrap would use — and
`wrapRoomFor` answers "one line" for it. Prose has neither, so paragraphs wrap
exactly as before; a bullet glyph is not a neighbour. `currentPageBlocks` is
what the wrap looks at, set by the replace and restyle entry points.

`wrapToWidth` used to break any word wider than its line by characters, and on
a PDF24 header cell that cut a date: "27/13/3137" came back "27/13/31" with
"37" on the next row. A word is now kept whole while it still fits on the
PAPER (`hardEm`, the room to the page edge) and broken only past it — a few
points into the margin is visible and right, a word cut in two is neither. The
op-window path's first-line break follows the same rule.

### Two BTs with a positional gap join with no space — compare space-free
dompdf and PDF24 draw an inventory row as "LENOVO" and "M70s Gen 6 Desktop…"
in two BTs with nothing between them; extraction reports the line with a
space. The line-group join read "LENOVOM70s…", was no exact match, the second
block alone won as a fuzzy single block, and deleting the line left "LENOVO"
standing (six characters, on forty forms of one template). Both matchers now
accept a space-FREE equality as exact, in the replace matcher's line runs and
the move matcher's whole-line and contiguous-run tests.

Measured (this session's baselines, node): marker sweep +8 gained, 0 lost over
seven corpora; realistic sweep main 625, r2 1040, r3 1117, r4 1131, r5 1071,
r6 1371, r7 990 operations — gained 16/36/43/38/33/32/35, lost 0.

### A visual line spread over several blocks' OPS is one line
A style run splits a paragraph line over three BTs on InDesign and Quicksand
exports: the head is the LAST op of a block that also holds the two lines
above, the bold word is a block of its own (drawn `2 Tr`), and the tail is the
FIRST op of the block holding the lines below. No whole block and no run of
whole blocks read as the target, so the head's block won as a fuzzy single
block and the partial path wrote the whole replacement into its last op — the
bold word and the tail stayed and the line read twice (cd 52 on a 78-character
edit, and a delete that left half the line). A 4-heights legal form does the
same with a clause number in its own fontless BT ahead of a two-line block:
retyping "6. Conozco…" drew "6. 7. …" and deleting it left the "6.".

Step 2c of the replace matcher gathers, from EVERY block, the ops on the
target's row and, when their text across the page is exactly the target's
(space-free), makes the line one candidate (`cross_block_line`): the leftmost
member takes the replacement through the partial path against ITS share of
the line, the other members' row ops are blanked in place. A block's later
lines are placed by their own Td/T*, so blanking its first op moves nothing.
Two things had to be right for the row test:

- **The row is a BASELINE, not a box.** An 11pt line's box is nearly as tall
  as its pitch, so the line above sat within a point of the box top and passed
  a box test; the target's first glyph origin, mapped into the block's space,
  is compared at 0.35 em.
- **`T*` steps by a leading the block may never set.** `TL` is text state and
  outlives ET; a form sets it once and every clause block inherits it. Tracked
  from zero, every `T*` line reported the same y and a clause's second line
  read as part of its first. `BtInfo.inheritedTL` replays TL/TD through q/Q
  the way `fontStateAt` replays fonts and seeds `scanShowOps`.

**The row can hold MORE than the target, and untouched members stay put.** A
LaTeX author line ("José Luis Barboza Gonzales¹,ⓘ,*, Diego Omar … ¹,ⓘ, Paul …")
draws each name as the tail op of its own BT, with the superscripts as ops
positioned by `Td` between them; extraction splits the line at the first
superscript, so the clicked block is only ", Diego Omar … Crisostomo," while
the row's members also carry the first author. The members were only accepted
when ALL of them joined to the target, so every edit of that block reported
"could not find matching text". `findCrossBlockLine` now also accepts a
contiguous sub-range of members that reads as the target. And
`applyCrossBlockLine` drops leading and trailing members the edit did not
change before writing (each member is its own BT, so an untouched one keeps
its place at either end): written whole into the first member, the line
redrew "Paul …" from Diego's position, and the "¹,ⓘ" between the names was
left inside the new text. The narrowed share is located by glyph COUNT
(`shareOfTarget`'s `fromFree`), or a "," member matches the line's first comma.
**Known:** a Td-placed superscript after an edited name stays where it was,
so a longer name runs into its own "¹,", and the ORCID icon (an image) never
moves.

### A substitute face is fitted back to the width the original set
Helvetica is wider than Calibri, Aptos, Arial Narrow or a condensed display
face, and on a same-length edit the excess ran the line off the page: a
Chrome-printed e-mail line lost its last four letters, a Word letterhead five,
a datasheet title nine. `substituteTz` scales a substituted run with `Tz` to
the original run's average advance times the new length — an append still
grows the line, only the face's excess is taken back — floored at 0.72, and
the scaling in force is put back after the run. Every substitute writer takes
it (`rebuildBtContent`, the op window, the in-array split, and the trailing
kern is measured at the scaled width); `textStateAtOp` multiplies advances by
the Tz in force instead of refusing, so a second edit of such a run is not
turned away. Measured side effect: the phantom spaces extraction used to
invent inside a re-encoded run ("UÉDO JDP", "Alarc on") are gone, because the
glyphs now sit where the original's did.

### Smaller matcher truths from the same round
- **A string inside an inline dictionary is not text.** `(es-PE)` in
  `/Span <</Lang (es-PE)/MCID 23>> BDC` decoded as two CID glyphs and put "??"
  ahead of every tagged block; Corel's `/Corel_OTF <<…>> DP` did the same with
  nineteen. `blankInlineDicts` blanks `<<…>>` operands before the decoder's
  literal walk. Those placeholders were what let containment fit a target into
  the wrong block.
- **An op that decodes to nothing but '?' is unreadable, not foreign.**
  `narrowToChangedOps` kept it as "a glyph neither text had".
- **Only a colour op that PRECEDES a show op governs a block's glyphs.** A
  PDF24 order sets `1 1 1 sc` as the last thing in its "PROVEEDOR" block, for
  the white text of the block after it; rewriting that op recoloured the
  neighbour while the target stayed black.
- **The move matcher reads a row space-free too** ("Código de Cliente:232900
  - 2R.U.C.:…" against "Código de Cliente : 232900 - 2"), and a candidate
  provably far from the click is dropped only when it is about the target's
  size AND a near candidate exists — every candidate far means the distance
  itself is suspect (an Excel export under `1 0 0 -1 0 0 Tm` measured its one
  exact block 444pt away).
- **The move matcher's space-free containment strips accent marks too**, as the
  replace matcher's containment leg does: a pdfTeX paragraph draws every
  accent as its own glyph ("segmentacio´n"), and without it no line of a TeX
  paragraph could be moved, resized or recoloured.
- **A line group's clip is widened around the block that was REWRITTEN.**
  The primary is not always the first block (a Wingdings tick leads, the
  Calibri sentence takes the text) and Word clips each run separately.
- **The blank guard tolerates an extraction transposition** ("defniido" for
  a Word TOC's "definido"): a block whose glyphs are nearly all in the target,
  in order, is not foreign.

Measured (node, this session's baselines): realistic sweep gained 3/6/12/19/
13/30/16 over main/r2…r7 on top of the first round, 0 lost; marker sweep
against the session's HEAD: 7/2/4/3/4/15/3 gained, 0 lost.

### A block's origin is its Td pushed THROUGH the Tm matrix
`getBlockOrigin` added Td/TD/T* straight onto the Tm translation, which is
only right while the matrix is the identity — the same composition
`scanShowOps` had already been taught. An Excel export draws every label under
`1 0 0 -1 0 0 Tm` and places it with `18 -376 Td`, so its origin read as
y = -376 where the page has it at +376: the one exact block for "Revisión
externa" measured 444pt from the click, and a Qt service report's title lines
grouped wrongly. Under a scaled Tm (`12 0 0 12 x y Tm`, `1 Tf`) a `0 -1.2 Td`
is a line, not a point. Sweeps: experiment-identical except the Qt/Excel
files, where cross-block and single-block edits became clean line groups.

### A colour change on a block that holds MORE than its target stays on the run; a resize of such a block is refused
`restyleInSource` took the whole-block path for any block under the 1.4x glyph
slack, so an itextsharp table header drawing "Num. Activo" and the cells beside
it in one BT recoloured the row (the sweep's collateral count found 22 such).
Provable containment (`provablyHoldsMore`, the same test the replace path
delegates on) now sends it to the run-scoped rewrite however small the excess.
A SCALE has only whole-block strategies (the run and segment paths translate),
so `transformInSource` refuses to resize a block that provably holds other text
rather than scale the neighbours with it — four sweep "successes" that had
touched two blocks each became honest refusals, and a utility bill's row
("Código de Cliente : 232900 - 2  R.U.C.: …") stopped running off the page.

### One line of a shared block can be RESIZED, not only moved
A scale had only whole-block strategies — the run and segment paths are pure
translations — so every resize of a line inside a block that draws more was
refused: 248 across seven corpora, because pdf24, Ghostscript and TeX draw a
whole page from one BT and on those producers no line could be resized at all.
`td_bracket_scale_run` treats a uniform scale the way `td_bracket_run` treats a
move: the line-leading run is bracketed with a `Td` and its inverse (the Td also
carries it to where a scale about the user's anchor puts it, converted into Tm
space), and its size is set with `/F size×s Tf` in front and the original put
back after. Gated on a run that leads its line with nothing pen-relative after
it and no `Tf` inside, the shape a heading, a table label or a paragraph line
has. Measured: 150 resizes gained, two "lost" that were a clause number in its
own block no longer scaling with the clause (a cross-block resize is not
implemented), marker sweep identical.

### At equal score the REAL distance decides, and an unnameable glyph is neither foreign nor a neighbour's
Three small matcher truths from the realistic sweep's last damage rows:

- **Inside one 8pt bucket, equal scores fall to the real distance before the
  line/single preference.** An itext invoice repeats "$ 0.00" on rows 11pt
  apart; the exact line group of the row ABOVE the click (3.4pt from the box)
  outranked the exact single block sitting ON it (0.0pt) and the wrong row was
  deleted with every character count intact. The move matcher already had
  this rule; the replace matcher did not.
- **A block whose decode is nothing but control characters is not foreign.** A
  bullet from a symbol subset without a ToUnicode reads as U+0001; the line
  guard called it a foreign word and refused every bulleted line of a utility
  bill. Control-only decodes are skipped like blanks and '?' placeholders.
- **…and one BEYOND the target's right edge is another cell's.** The run for
  "• www.bn.com.pe" took the second column's bullet as its last member and
  rewriting the line blanked it. `applyLineReplacement` drops an unreadable
  block whose origin lies past the target's box.

Tried and reverted in the same round: retagging `/ActualText` only on spans
that already carry one. A Chrome-printed statement's compensation kern makes
MuPDF place the retagged words as a zero-width phantom at the end of the line
above ("Expediente : …" read twice), but tagged Word, PowerPoint and SAP pages
read their text from the tag with NO prior ActualText — 28 edits across three
corpora lost their words the moment the retag was withheld. The phantom stays
a known limitation.

### A string literal may wrap with a backslash-NEWLINE, and a row may be drawn value-first
Round 8 (the 50 Downloads PDFs never swept, mostly dompdf and pdf24 forms):

- **`STR_LIT_SRC` matched `\.`, and `.` does not match a newline.** A backslash
  before an end-of-line is a line continuation inside a PDF string, and dompdf
  wraps every long paragraph string that way — "(Declaro que he recibido …
  bajo m\<LF>i resguardo…)". Those literals were never seen as strings: the
  block decoded without them and every paragraph line of the inventory form
  reported "could not find matching text". `\[\s\S]` now.
- **`blankInlineDicts` must look at the literal-MASKED copy.** A pdf24 form's
  subset-coded plain strings hold the bytes `<<`; scanning the raw content
  blanked from there to the next `>>` — real show ops gone and the rest of
  the block decoded as a wall of one ideograph. (My own defect from two
  rounds earlier, caught by the new corpus.)
- **A row drawn value-first is read across the page.** pdf24 draws "419600"
  before "付款代码 COD PAGO : " inside one BT, so no in-order reading of the
  block held the target. Step 2c now reads a member's row ops by x as well,
  admits a SINGLE member when its ops are out of reading order, and the
  partial path writes the new text into the LEFTMOST op of the window
  (`leftmostOf`, same-row within 0.6 em) — written at the first op in stream
  order the label's words landed in the value's column.

`tools/pdf-sweep/stage-round.mjs <folder> <round>` stages everything not yet
in any manifest without touching the main corpus. Round 8: realistic 771 ops
724 → 730, marker 317 ops 275 → 281, rounds 2–7 identical.

### One cell of a shared-array row can be RESIZED, with the row held still
`transformTextBlock` had two resize strategies, both whole-run: rewrite the
block's Tm, or bracket a line-leading run with a Td and a bigger Tf
(`td_bracket_scale_run`). A cell of a row drawn as ONE TJ array — every row
of a Ghostscript or Print-to-PDF timesheet ("06-05-26 16:00:00 18:00:00",
cells separated by kerns), a pdf24 form's "DPTO:" — leads no line and shares
its Tm with the whole page, so 84 resizes across the corpora were refused
with "could not find matching text" while the same cell MOVED and EDITED
fine. `scaleInsideTjArray` is `shiftInsideTjArray` with a size: the array is
split around the run, the middle op set under `/F size×s Tf` and the original
restored after it, and the TRAILING kern cancels the displacement AND the
run's extra advance (`runAdvance × (s − 1)`, in thousandths), so every later
cell of the row draws exactly where it did. The segment is found by
`findTargetSegment`, the same row-aware chooser the move uses, and the hit now
carries what a scale needs (font name, pen x, op y, run offset and advance).
Measured: "16:00" 5.7 → 7.1pt, "DPTO:" 7.0 → 8.7pt, "CODIGO" 6.4 → 7.9pt,
each anchored at its own bottom-left with its neighbours unmoved.

### A bake is an undo point
`bakeOcrEdits` wrote patches and text into the document with no snapshot, so
Ctrl+Z after a save that baked a scanned page's edits did nothing — or, with an
earlier text edit on the stack, jumped PAST the bake to that edit's snapshot
and took both away in one press (the headless scan-flow smoke,
`scratchpad/pw/ui-ocr.mjs`, still read the baked text after the undo). One
`pushUndo()` before the first write covers every page baked in that pass:
`docStore.pdfBytes` is the pre-bake document until `syncAfterEdit` at the end.

### A line that still fits on the PAPER is not wrapped
A wrap with Reflow off draws the continuation across the next line, and with
it on leaves one word on a line of its own — either way a mess for what is,
on most lines, a few points of overflow. Retyping a full-width line with
letters a little wider than the old ones wrapped its last word onto the line
beneath on a Quartz and a dompdf paragraph, and extraction read the two
interleaved. `layoutReplacementLines` and `wrapWindowText` now draw on ONE
line whatever the margin says while the text fits between the block's left
edge and the paper's edge less `PAPER_EDGE_SLACK`; only what cannot fit on
the paper wraps, at the margin room as before.

Two measurement defects sat under the same symptom:
- **A substitute draws with its own metrics.** The stand-in is calibrated
  against the width the block occupies today, which is right while the
  block's own font keeps the text and wrong when a base-14 face takes it: a
  Century Schoolbook paragraph retyped into Times-Roman measured 589pt with
  the wide-calibrated stand-in and draws at 422. `substituteFaceFor` plans
  the single line first (find-or-create, so nothing registers twice) and the
  wrap measures in that face uncalibrated; the partial path passes its own
  plan's face.
- **A cross-block share calibrates against the LINE.** `applyCrossBlockLine`
  hands the partial path a share whose text is one member's ("6.") and whose
  width is the whole line's (460pt): 38 points per em, clamped to 2, and an
  appended line wrapped into three at half the page. `TextBlock.wrapRef`
  carries the line's text and width for the calibration.

### A space at a literal's end is not a boundary, and a segment takes a size too
`findTargetSegment` accepted an occurrence only when the target began at a
literal's first character and ended at its last. A Ghostscript form draws its
two signature labels as one array of `(FIRMA FINANZAS )` literals, trailing
space included, so the target's last letter sat one short of the literal's end
and the label could not be recoloured, resized or moved — "could not find
matching text" on a block whose text plainly contained it. Space glyphs at
either end of the literal are now stepped over; the splice takes the whole
literal, so the space travels with the run (nothing visible marks where it
was), and the hit's `runOffset`/`runAdvance` span the literals in full so a
scale's compensating kern counts every glyph that grows.

The restyle path's segment branch refused a size change outright ("the row's
advances would change under it"); it goes through `scaleInsideTjArray` now,
with the colour, when there is one, set before the scaled `Tf` and restored
after (`tf_scale_segment` / `restyle_segment`). Measured on the Ghostscript
form: the right-hand label recolours, grows to 8.7pt, moves and takes a font
size, each leaving the left-hand copy at its own x.

### A substitute is measured UNDER its Tz, and a segment carries its trailing space
Two more things the wrap measurement had to get right once it measured a
substitute in the substitute's own face, each found by the realistic sweep
losing a row it used to pass:
- **The writers squeeze a wide substitute with `Tz`** (`substituteTz`, floor
  0.72) to the width the old text had. Measured uncompressed, Helvetica-Bold
  for a Calibri e-mail line came out 15% too wide, wrapped, and the tail was
  drawn across the line beneath — eight LibreOffice/Word e-mail and letter
  lines across four corpora. `layoutReplacementLines` and `wrapMeasure` apply
  the same `substituteTz` to the same text, so what is measured is what is
  drawn.
- **The untouched PREFIX of a narrowed window stays in the block's own font**,
  so its width is measured with the calibrated stand-in whatever face draws
  the window; measuring it in the substitute put the continuation's start in
  the wrong column.
- **A segment's trailing space travels with it.** `findTargetSegment` now
  absorbs the space-only literals right after the run (small kerns between
  included, a kern past `KERN_SPACE` being a column jump), the rule
  `replaceInsideTjArray` already follows: left at the old pen position the
  space lands INSIDE a scaled or shifted run, and extraction read a resized
  "Atención: " back as "Atención :".

Measured across the seven text corpora: realistic sweep +75 gained, 1 lost
(a Canva doubled-draw line whose earlier pass was luck), marker sweep
experiment-identical to before this batch (3046/2811); ocr4 OCR sweep
0.922 → 0.936 average re-read similarity with the OCR code untouched.

### "On the click" is judged ALONG the line and ACROSS it — the block's axes, not local x/y
Every run-position test (`runDistanceToTarget`, `runGapToTarget`,
`opRunDistanceToTarget`, `findTargetSegment`'s row and occurrence choice,
`findTargetRun`'s overlap check, the partial path's `arrayTooFar`) reasoned in
local x and y: the pen advances along x, another baseline is a step in y, and
an array may START well before the cell it draws — but only to the left of
it. That is true only while the block's Tm is upright. pdf24's fund-request
form draws each invoice row under `0 1 -1 0 e f Tm`, a quarter turn, so the
pen advances along local Y: the array holding "F015-00344345" started 65pt
before the cell ALONG the line and was measured as 65pt off it ACROSS lines,
`arrayTooFar` refused it, and every cell of every row on that page reported
"could not find matching text" — while the same rows' edits on the upright
page 1 worked. `LocalFrame` (what `blockLocalPoint` returns) now carries the
block's reading direction from its Tm (`dir`), the clicked box projected onto
it (`aLo..aHi` along, `cLo..cHi` across) and the two projections; an op's pen
position along the line is its origin projected plus the advance
`textStateAtOp` accumulated. For an upright Tm the projections are x and y
exactly, so nothing changes where the old arithmetic was right. The segment
scale's origin follows the same direction (an in-place resize on that page
moved 16pt sideways with the advance added to x).

Measured on the form: the cell edits, moves by exactly the delta asked and
resizes anchored at its own corner.

### Every run of a line is a MOVE candidate, and the nearest form is searched first
Two silent wrong moves from the marker sweep's "landed off" rows, each a
matcher taking the first thing that read right:
- **The run search in `findBtBlocksByPosition` stopped at the first window.**
  A permit form draws "SI NO SI NO" on one line as four one-word BTs — two
  checkbox pairs a column apart — so the LEFT pair was the only candidate for
  a click on the right one, and the drag moved the wrong pair, 66pt off,
  reporting success. Every window that reads as the target is now its own
  candidate, ranked by its own distance like any other; a single window
  behaves exactly as before.
- **The move and restyle paths searched content sources in DOCUMENT order**
  and returned on the first that answered. An iLovePDF catalogue draws
  "CHAT GPT:" in several nested cell forms and once more in the page-sized
  form that holds them; the page-sized one answered first with a copy 110pt
  from the click, and that copy moved. Ordering the forms by their invocation
  ORIGIN (as the replace path does) was tried first and swapped one wrong
  copy for another: a cell form nearer by origin answered with its copy 284pt
  away. `sourcesByMatch` asks every source where its position match lies
  (`lastPositionMatchDist`, the winner's origin or drawn-run distance) and
  puts the nearest match first, so the loop's "first that answers" is the
  nearest copy; sources with no match keep their origin order after.

### Resize: the whole Tm scales, a run's own offsets scale, a multi-op run is measured as a run
Four resize defects from the realistic sweep's "wrong size" rows, all
reporting success:
- **`tm_rewrite` scaled only a and d.** The scale acts on the matrix's output
  (x' = a·x + c·y + e), so sx multiplies a AND c, sy b AND d. On a
  quarter-turn Tm (`0 1 -1 0 e f`, a Ghostscript /Rotate form) a and d are
  zero: the title's resize rewrote the Tm and changed nothing.
- **A block's distance is its FIRST Tm's.** An Adobe letter draws a header
  artifact and its footer in ONE BT — `( )Tj` at the top, the footer 735pt
  below under a second Tm — so the footer's block ranked 728pt from a click
  on the footer, and a copy of the same words in a nearer block took the
  resize. `runDistanceToTarget` now measures a target that spans SEVERAL ops
  as a run (`findTargetRun` + `runGapToTarget`) before falling back to the
  origin.
- **The Td/TD offsets INSIDE a bracketed run scale with it**, about the run's
  start, and the closing Td takes back their growth too: "[(Empresa …
  Huallaga)]TJ 13.056 0 Td ( )Tj 0.185 0 Td [(S.A.)]TJ" put "S.A." at its old
  offset inside the wider "Huallaga" ("Hu Sa.Alla .ga"). A Tm inside the run
  is scaled the way the block's own Tm is — matrix by the scale,
  translation about the anchor — and the offsets after it scale on their own
  (they are multiplied by that matrix); the closing restores the last inner
  Tm as it was plus the offsets that followed. A Tf inside scales too and
  the face it leaves in force is restored at its original size. Microsoft
  Print to PDF draws a date as "0" + `… Tm` + "7/01/2026"; refusing the Tm
  let the segment path take the same date one row UP (a flat 6pt row bar
  admitted a baseline 5.4pt outside an 8.5pt box in a 12pt-pitch table —
  `findTargetSegment`'s bar is a third of the box's height now, 2..6pt).
  Tc/Tw in force scale with the glyphs and the run's own last values are
  restored after it.
- **Fragments are refused for a move or restyle.** `readsAs` and
  `fuzzyTextMatch` both admit a block whose text is a SUBSTRING of the
  target; an Adobe letter draws "… del Banco Interbank para …" as the tail of
  one BT, "Banco Interbank " as its own and the head of a third, and the
  middle word moved 20pt alone (and was recoloured alone, reported as
  success). A candidate carrying under 85% of the target's characters, all
  of them inside it, is skipped — in the line-group pass and the
  single-block pass. A move, resize or restyle of such a line then goes
  through `crossBlockTransform` / `crossBlockRestyle`: `findCrossBlockLine`
  (the replace matcher's Step 2c, extracted) assembles the members, each is
  addressed as its own SHARE of the target (`shareOfTarget`), so a member
  takes whichever per-block strategy fits it, and the source is put back
  untouched when any member refuses. Each member's write goes into the
  document, and a ContentSource holds the stream it was made with — the next
  member must start from a FRESH one (`getContentSources` again), or its
  rewrite starts from the original and undoes the last: measured, three
  members, three "successes", one moved. On the Adobe letter the whole
  "… del Banco Interbank para …" line now moves and recolours as one.

### A substitute draws with its own spacing
`Tc`/`Tw` are set for the face they were designed with. A datasheet
letterspaces its condensed title with `0.075 Tc` (1.4pt a glyph at 19pt); the
Helvetica that replaced the face is wider already, kept the spacing on top,
and `substituteTz` — which measures glyphs alone — could not see it: the
title ran 55pt past the paper's edge and read back two letters short on a Tz
that "fitted" (the one viewer-sweep failure). `spacingResetFor` puts `0 Tc
0 Tw` in front of a substituted run and the values back after it (they
outlive the run) — the partial path's window, the in-array split and the
rebuild alike. `textStateAtOp` reports `tc`/`tw` for it.

### A target that BEGINS inside the previous cell is refused, not half-edited
The op-window matcher can find only the TAIL of a target when its head is the
end of a TJ array holding other cells: a pdf24 form draws "…87.64S/ … 2.79%"
as one array and " DEBITO AUTOMATICO" as the next op, the window held the
second op alone (score 0.76), the whole replacement was written into it, and
the row read "2.79% 3.80% EFCJUP…" — the old percentage kept beside the new.
`applyPartialBlockReplacement` now checks whether the window's text is a
strict tail of the target whose missing head ends the previous op, and
refuses with a message naming the head. Splitting the array's tail off and
editing both pieces is not implemented. (The realistic sweep counts a refusal
as `char_delta` 28 there — its expectation assumes the edit — while the page
is untouched.)

### A move or resize that would leave the PAPER is refused
Text drawn past the page's edge is neither visible, printable nor findable —
it is lost, while the operation reports success. The realistic sweep's
largest damage cluster was exactly this: 164 resizes of full-width lines at
1.25x, and the moves that pushed a line's last glyphs off the right edge.
`transformLeavesPaper` projects the block's bbox through the requested
transform (in the bbox's top-left space, the anchor converted from the
bottom-left one the caller states) and `transformTextBlock`/
`transformTextBlocks` refuse with a message naming the edge. The margin is
deliberately not the bar — a heading may run into it on purpose — the paper
is; one point of slack for rounding.

### Small matcher truths from the checkbox rows, the bilingual line and the Adobe footer
- **A narrowed line's retry targets the MIDDLE's share.** `narrowLineAndRetry`
  passed the whole line as the target, and `substituteTz` fits a substitute to
  the target's width per character: a bilingual line ("本手册介绍了 Intellisign
  平台…") is ten points a character where its Latin word is five, Helvetica
  for the word needed no squeeze, and its last glyph landed on the ideograph
  beside it ("Joufmmjtjh平o"). `shareOfTarget` cuts the share from the
  target's own glyphs (text with its spacing, the width they occupy, the line
  kept as `wrapRef`).
- **A SHORT target (2–5 characters) is admitted to containment when a run
  carrying it sits on the click.** `readsAs` demands six; a permit form draws
  its second and later "SI NO SI NO" rows inside ONE block that spans the
  form, so the only candidate for a click on row 2 was row 1's four-block
  pair, 5.5pt above — and that row moved, on two producers.
- **Runs are found space-FREE.** Extraction fuses adjacent cells ("SI" and
  "NO" read back as "SINO") while the array holds a space glyph between:
  `findTargetRun` accepts space-free equality, and `runDistanceToTarget` /
  `findTargetSegment` find occurrences space-free and map them back to the
  array's character positions, start and end.
- **The move ranking's bucket is the target's height (3..8pt).** With a flat
  8pt bucket the row above (4.3pt from a 6.6pt box) tied the right row and
  won on score.
- **A run never STARTS with a blank op.** An Adobe letter's BT opens with the
  header artifact's `( )Tj` under a 12-scale Tm and only then sets the
  footer's 6.48-scale Tm; a window that began at that space put the footer's
  run before its own Tm, the delta converted through the wrong matrix, and
  the move landed at 54% of the ask (its resize interleaved "Hualla ga").
  `findGoverningTm` and `findTargetRun` skip blank leading ops — unless the
  target itself begins with whitespace (" N° de Servicio", " Tasa 18% ", a
  blank cell), where the space is part of what was clicked: skipping it
  unconditionally lost twelve moves and resizes on four producers.

### Every EXACT window of a line is a candidate, and a run on another row is refused
- The replace matcher kept ONE best window per line group, so the first
  exact window won even when a second exact window sat where the click was.
  A pdf24 order's date row is [":" (left column) … "10/04/2026" … ":" (right
  column)] in stream order: the first exact window paired the date with the
  LEFT column's colon 470 units away, that group measured 344pt from the
  click, and the row BELOW — the same date with its own colon — won at 10pt
  and lost its colon to a delete meant for the row above. Every exact window
  is its own candidate now, ranked by its own distance.
- `findTargetRun` only PREFERRED an on-row run; with no on-row single-op run
  it handed the recolour and the edit of an invoice's "1,630.00" to the
  grand total one row below (the clicked row's copy sits inside a TJ array
  with the unit price). A run whose row gap exceeds the box's height and a
  half (never under 6pt) is refused, and the segment path then finds the
  copy inside the row's array.

### The OCR editor is one line, so its textarea must not soft-wrap
A textarea soft-wraps whatever the stylesheet's `white-space` says. The OCR
editor is sized to the run's box, a long title wrapped inside it, and End (or
a click past the fold) put the caret at the end of the first VISUAL line:
typing appended mid-run — "Compra-Venta XYde Repuestos" in the headless
scan smoke. `wrap="off"` on the textarea; the run is one line.

### Known Limitations
- **CID fonts with incomplete CMaps**: Some glyphs (especially ligatures like 'ti', 'fi') may not have ToUnicode mappings → decoded as '?' → fuzzy matching compensates
- **Single BT block replacement**: Each edit targets one BT/ET block. Multi-block edits need separate operations
- **Text position**: Replaced text uses the same position/size as original — no automatic reflow; justified TJ kerning is not regenerated
- **Substituted fonts are not embedded** (standard base-14, always available in viewers)

## Deploying
`npm run build` → `dist/` (≈85 MB without `public/_sweep`, which is
gitignored and must not be shipped: delete `dist/_sweep` before upload).

**Zip it with `tar.exe`, never `Compress-Archive`.** Windows PowerShell 5.1's
`Compress-Archive` writes entry names with BACKSLASHES (241 of 246 entries in
a build zip), and a Linux unzip extracts those as single files literally named
`assets\index-….js` — the site then loads nothing. From inside `dist/`,
`C:\Windows\System32\tar.exe -a -c -f <out>.zip <every top-level item>` writes
forward slashes. Build from a commit in a throwaway `git worktree` (junction
`node_modules` in, `cmd /c rmdir` it before removing the worktree) so the zip
is what was pushed, not the working tree.

What production MUST provide, all of which `public/.htaccess` does for Apache:
- **Cross-origin isolation headers** — `Cross-Origin-Opener-Policy:
  same-origin` and `Cross-Origin-Embedder-Policy: credentialless` on every
  response. Without them there is no SharedArrayBuffer and the workers lose
  their threads (ONNX Runtime falls back to one, MuPDF may fail to start).
  COEP is `credentialless` (was `require-corp`) so the Microsoft Clarity
  analytics tag — a cross-origin script that sends no CORP/CORS header — can
  load while the page stays isolated. credentialless keeps SharedArrayBuffer
  on Chromium and Firefox; **Safari does not support it**, so on Safari the
  page is not isolated and the engines may fail — revert both header files to
  `require-corp` if Safari support outweighs analytics.
- **MIME types** for `.wasm` (application/wasm), `.mjs` (javascript), `.ort`
  (octet-stream), `.otf`, and `.traineddata.gz` served as-is (tesseract.js
  inflates it itself — a server that sets `Content-Encoding: gzip` on it
  breaks OCR).
- **Long caching** for `/paddle/*`, `/fonts/*`, `/tessdata/*`: 31 MB of
  models and an 8 MB font that never change under the same name; the app
  also stores the models in the Cache Storage API after the first load.
- Nothing is fetched from a CDN: ORT's WASM is a Vite asset, models and
  fonts are under `public/`, and tesseract.js's worker and WASM cores are
  under `public/tesseract/` (`workerPath`/`corePath` in `tesseractEngine.ts`
  — until 2026-09-03 they came from cdn.jsdelivr.net by the library's
  defaults, which this note wrongly denied). `corePath` is a directory and
  the three `tesseract-core*-lstm.wasm.js` names must stay as shipped: the
  worker picks one by WASM feature detection. Serve `*.wasm.js` as
  JavaScript. The only network calls are the ones the user opts into
  (Mistral OCR, and the editing assistant's OpenAI calls).

## Vite Config Notes
- COEP/COOP headers needed for SharedArrayBuffer (WASM)
- `optimizeDeps: { exclude: ['mupdf'] }` — prevents Vite pre-bundling of MuPDF
- `worker: { format: 'es' }` — ES module workers

## Important Notes
- The old v1 app at `../web-app/` uses a fundamentally different overlay approach — do not copy its patterns
- MuPDF is AGPL licensed — fine for personal use, needs commercial license for distribution
- `fontDict.length` returns 0 in MuPDF JS bindings — access fonts by name via `.get('F48')` instead of iterating
- ToUnicode stream: call `readStream()` on the unresolved indirect reference (`.isStream()` returns false after `.resolve()`)

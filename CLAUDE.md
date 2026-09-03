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

### Known Limitations
- **CID fonts with incomplete CMaps**: Some glyphs (especially ligatures like 'ti', 'fi') may not have ToUnicode mappings → decoded as '?' → fuzzy matching compensates
- **Single BT block replacement**: Each edit targets one BT/ET block. Multi-block edits need separate operations
- **Text position**: Replaced text uses the same position/size as original — no automatic reflow; justified TJ kerning is not regenerated
- **Substituted fonts are not embedded** (standard base-14, always available in viewers)

## Deploying
`npm run build` → `dist/` (≈85 MB without `public/_sweep`, which is
gitignored and must not be shipped: delete `dist/_sweep` before upload). What
production MUST provide, all of which `public/.htaccess` does for Apache:
- **Cross-origin isolation headers** — `Cross-Origin-Opener-Policy:
  same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on every
  response. Without them there is no SharedArrayBuffer and the workers lose
  their threads (ONNX Runtime falls back to one, MuPDF may fail to start).
- **MIME types** for `.wasm` (application/wasm), `.mjs` (javascript), `.ort`
  (octet-stream), `.otf`, and `.traineddata.gz` served as-is (tesseract.js
  inflates it itself — a server that sets `Content-Encoding: gzip` on it
  breaks OCR).
- **Long caching** for `/paddle/*`, `/fonts/*`, `/tessdata/*`: 31 MB of
  models and an 8 MB font that never change under the same name; the app
  also stores the models in the Cache Storage API after the first load.
- Nothing is fetched from a CDN: ORT's WASM is a Vite asset, models and
  fonts are under `public/`. The only network calls are the ones the user
  opts into (Mistral OCR).

## Vite Config Notes
- COEP/COOP headers needed for SharedArrayBuffer (WASM)
- `optimizeDeps: { exclude: ['mupdf'] }` — prevents Vite pre-bundling of MuPDF
- `worker: { format: 'es' }` — ES module workers

## Important Notes
- The old v1 app at `../web-app/` uses a fundamentally different overlay approach — do not copy its patterns
- MuPDF is AGPL licensed — fine for personal use, needs commercial license for distribution
- `fontDict.length` returns 0 in MuPDF JS bindings — access fonts by name via `.get('F48')` instead of iterating
- ToUnicode stream: call `readStream()` on the unresolved indirect reference (`.isStream()` returns false after `.resolve()`)

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

**Known unfixed:** on a Corel datasheet (`/Corel_OTF … DP` marked content, CID
font with a 29-entry ToUnicode), replacing `3/4''` still rewrites a whole row —
702 characters across 36 blocks. The block is matched as a line group and the
guards above do not catch it; the changed region begins mid-block at a `TD`, so
the run selection is what is wrong, not the size test.

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

### A partial run must not outrank the line group that covers it
A form draws "Código de Postulante" and its value "70492487" as two runs that
extraction reports as ONE line. The label alone fuzzy-matches the whole line, and
it scored a flat 1 while the line group covering both scored its similarity
ratio (~0.97) — so the label won, was rewritten, and the value was left stranded
beside the new text while the edit reported success. Single-block candidates are
now scored by `matchRatio`, i.e. by how much of the target they actually carry.

### Reflow is OFF by default — but a DRAG always makes room
`editorStore.reflowOnEdit` gates the line-count reflow, the page spill, the
image room-making and the resize room-making. It does NOT gate the move
collision, and gating it there was a mistake.

The toggle is off by default because most documents people edit are not flowing
prose. On a form or a table — labels and values drawn at fixed coordinates in
columns — "push everything below down" tears labels away from their values: on a
real inscription form one Enter turned 55 blocks into 68 and left "Teléfono 2"
printed over "Teléfono". With the toggle off an edit changes only what was
edited (measured: 55 → 56 blocks, 2 moved).

Dropping a paragraph on top of another one is not that case. The user aimed at
that spot; a content stream has no flow to make room by itself; and leaving the
two overlaid is not the conservative outcome, it is the unreadable one. Ctrl+Z
takes back the whole move, displacements included. Sweeping the drag in with the
typing under one toggle made moving text silently start overlapping it —
reported as "before this was fine, now it doesn't work".

The distinction is between an edit that rearranges a page as a SIDE EFFECT and a
gesture whose whole purpose is to put something somewhere.

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

**Known limitation:** a monospaced face has shorter ascenders again (Courier
0.63 em against Helvetica 0.72) and reads about 30% low. The correction exists
(`GLYPH_BOX_PER_EM_MONO`) but only applies once the face is known to be Courier,
which needs the advances test to fire. On a blurred scan it often does not, and
the line comes back as Helvetica at three quarters of its size. It fails toward
the default rather than toward a wrong typeface, and both are one click to fix.

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

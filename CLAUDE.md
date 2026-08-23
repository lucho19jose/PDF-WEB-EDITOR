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

### Reflow is OFF by default, and governs every page-rearranging edit
`editorStore.reflowOnEdit` gates the line-count reflow, the page spill, the
image room-making, the resize room-making AND the move-collision displacement.

Most documents people edit are not flowing prose. On a form or a table — labels
and values drawn at fixed coordinates in columns — "push everything below down"
tears labels away from their values: on a real inscription form one Enter turned
55 blocks into 68 and left "Teléfono 2" printed over "Teléfono". With the toggle
off, an edit changes only what was edited (measured: 55 → 56 blocks, 2 moved).

The reflow is not wrong, it is wrong BY DEFAULT. Prose is where it helps and it
is one click away.

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

/**
 * Merge static features (features.json) with the live editor experiments
 * (results.json) into one report per PDF, plus a flat JSONL dataset.
 *
 * Usage: node tools/pdf-sweep/report.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const features = JSON.parse(fs.readFileSync('tools/pdf-sweep/features.json', 'utf8'))
const results = JSON.parse(fs.readFileSync('tools/pdf-sweep/results.json', 'utf8'))
const outDir = 'tools/pdf-sweep/reports'
fs.mkdirSync(outDir, { recursive: true })

const byId = new Map(results.map(r => [r.pdf_id, r]))

/** Coarse CTM label for the ML feature vector. */
function ctmLabel(c) {
  if (!c || !c.total) return 'identity'
  if (c.rotated) return 'rotated'
  if (c.flipped) return 'flipped'
  if (c.scaled) return 'scaled'
  if (c.translate) return 'translated'
  return 'identity'
}

function dominantFontType(ft) {
  const e = Object.entries(ft || {})
  if (!e.length) return null
  return e.sort((a, b) => b[1] - a[1])[0][0]
}

const dataset = []
let written = 0

for (const f of features) {
  const run = byId.get(f.pdf_id)
  const feat = f.features || {}
  const experiments = (run?.experiments || []).map(e => ({
    strategy: e.strategy,
    internal_strategy: e.internal_strategy ?? null,
    block_index: e.block_index,
    original_text: e.original_text,
    observed_text: e.observed_text ?? null,
    reported_success: e.reported_success,
    success: e.success,
    landed_exactly: e.landed_exactly ?? null,
    vanished: e.vanished ?? null,
    // 0 = nothing but the target's own characters changed anywhere on the page
    char_delta: e.char_delta ?? null,
    // blocks whose text or position moved; ~1 is correct, many means over-reach
    blocks_touched: e.blocks_touched ?? null,
    block_count_delta: e.block_count_delta,
    substituted_font: e.substituted_font ?? null,
    clip_adjusted: e.clip_adjusted ?? null,
    visual_similarity: e.visual_similarity,
    geometry_error: e.geometry_error,
    error: e.error ?? null
  }))

  const perStrategy = {}
  for (const e of experiments) {
    perStrategy[e.strategy] ??= { runs: 0, ok: 0, visual: [], geom: [] }
    const s = perStrategy[e.strategy]
    s.runs++
    if (e.success) s.ok++
    if (typeof e.visual_similarity === 'number') s.visual.push(e.visual_similarity)
    if (typeof e.geometry_error === 'number') s.geom.push(e.geometry_error)
  }
  const avg = a => a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10000) / 10000 : null
  const summary = Object.fromEntries(Object.entries(perStrategy).map(([k, v]) => [k, {
    runs: v.runs, ok: v.ok,
    success_rate: v.runs ? Math.round((v.ok / v.runs) * 1000) / 1000 : 0,
    visual_similarity: avg(v.visual), geometry_error: avg(v.geom)
  }]))

  let best = null
  for (const [k, v] of Object.entries(summary)) {
    if (v.success_rate > 0 && (!best || v.success_rate > summary[best].success_rate)) best = k
  }

  const report = {
    pdf_id: f.pdf_id,
    file: f.file,
    features: {
      producer: feat.producer,
      creator: feat.creator,
      producer_family: feat.family,
      pdf_version: feat.pdf_version,
      page_count: feat.page_count,
      file_size: feat.file_size,
      encrypted: feat.encrypted,
      page_sizes: feat.page_sizes,
      font_type: dominantFontType(feat.font_types),
      font_types: feat.font_types,
      font_count: feat.font_count,
      base_fonts: feat.base_fonts,
      cid: feat.cid,
      tounicode: feat.tounicode,
      tounicode_missing: feat.tounicode_missing,
      subset_fonts: feat.subset_fonts,
      symbolic_fonts: feat.symbolic_fonts,
      actual_text: feat.actual_text,
      marked_content: feat.marked_content,
      ctm: ctmLabel(feat.ctm),
      ctm_stats: feat.ctm,
      clipping: feat.clipping,
      text_operators: feat.text_operators,
      positions_with_tm_only: feat.positions_with_tm_only,
      positions_with_td_only: feat.positions_with_td_only,
      content_stream_bytes: feat.content_stream_bytes
    },
    runtime: {
      pages_loaded: run?.pages ?? null,
      blocks_page1: run?.blocks_page1 ?? null,
      page_size: run?.page_size ?? null,
      notes: run?.notes ?? [],
      error: run?.error ?? f.error ?? null
    },
    experiments,
    summary,
    best_strategy: best
  }

  fs.writeFileSync(path.join(outDir, String(f.pdf_id).padStart(3, '0') + '.json'),
                   JSON.stringify(report, null, 2))
  written++

  // Flat row per experiment for model training
  for (const e of experiments) {
    dataset.push({
      pdf_id: f.pdf_id,
      producer_family: feat.family,
      producer: feat.producer,
      pdf_version: feat.pdf_version,
      font_type: dominantFontType(feat.font_types),
      cid: feat.cid,
      tounicode: feat.tounicode,
      tounicode_missing: feat.tounicode_missing,
      subset_fonts: feat.subset_fonts,
      symbolic_fonts: feat.symbolic_fonts,
      actual_text: feat.actual_text,
      marked_content: feat.marked_content,
      ctm: ctmLabel(feat.ctm),
      rect_clips: feat.clipping?.rect_clips ?? 0,
      op_BT: feat.text_operators?.BT ?? 0,
      op_Tj: feat.text_operators?.Tj ?? 0,
      op_TJ: feat.text_operators?.TJ ?? 0,
      op_Tm: feat.text_operators?.Tm ?? 0,
      op_Td: feat.text_operators?.Td ?? 0,
      op_Tstar: feat.text_operators?.Tstar ?? 0,
      hex_strings: feat.text_operators?.hex_strings ?? 0,
      xobject_do: feat.text_operators?.Do ?? 0,
      strategy: e.strategy,
      internal_strategy: e.internal_strategy,
      substituted_font: e.substituted_font,
      reported_success: e.reported_success,
      success: e.success,
      char_delta: e.char_delta,
      blocks_touched: e.blocks_touched,
      block_count_delta: e.block_count_delta,
      visual_similarity: e.visual_similarity,
      geometry_error: e.geometry_error,
      error: e.error
    })
  }
}

fs.writeFileSync('tools/pdf-sweep/dataset.jsonl',
  dataset.map(r => JSON.stringify(r)).join('\n') + '\n')

// Aggregate view for triage
const agg = {}
for (const r of dataset) {
  const k = r.producer_family + ' | ' + r.strategy
  agg[k] ??= { runs: 0, ok: 0, errors: {} }
  agg[k].runs++
  if (r.success) agg[k].ok++
  else { const e = (r.error || 'wrong-result').slice(0, 60); agg[k].errors[e] = (agg[k].errors[e] || 0) + 1 }
}
fs.writeFileSync('tools/pdf-sweep/aggregate.json', JSON.stringify(agg, null, 2))

console.log(`reports: ${written}  dataset rows: ${dataset.length}`)

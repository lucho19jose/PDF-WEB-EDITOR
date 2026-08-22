// Deep per-PDF feature extraction for the sweep report.
// Reads the SAME way the worker does (readStream on the indirect array element)
// so the features describe what the editor will actually see.
// Usage: node tools/pdf-sweep/features.mjs  -> tools/pdf-sweep/features.json
import fs from 'node:fs'
import path from 'node:path'
import * as mupdf from 'mupdf'

const manifest = JSON.parse(fs.readFileSync('tools/pdf-sweep/manifest.json', 'utf8'))
const MAX_PAGES = 3

function latin1(bytes) {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)))
  }
  return s
}

/** Concatenate a page's content streams (indirect array elements, not resolved). */
function readContentStream(pdfDoc, pageIndex) {
  const page = pdfDoc.loadPage(pageIndex)
  const obj = page.getObject()
  const contents = obj.get('Contents')
  let out = ''
  if (contents.isArray()) {
    for (let i = 0; i < contents.length; i++) {
      try {
        const buf = contents.get(i).readStream()
        out += latin1(new Uint8Array(buf.asUint8Array ? buf.asUint8Array() : buf))
        out += '\n'
      } catch { /* chunk unreadable */ }
    }
  } else {
    try {
      const buf = contents.readStream()
      out = latin1(new Uint8Array(buf.asUint8Array ? buf.asUint8Array() : buf))
    } catch { /* not a stream */ }
  }
  return out
}

function countMatches(s, re) {
  const m = s.match(re)
  return m ? m.length : 0
}

/** Classify the cm matrices present: identity / scaled / flipped / rotated. */
function ctmStats(stream) {
  const re = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm\b/g
  const kinds = { identity: 0, translate: 0, scaled: 0, flipped: 0, rotated: 0 }
  let m, total = 0
  while ((m = re.exec(stream)) !== null) {
    total++
    const [a, b, c, d] = [+m[1], +m[2], +m[3], +m[4]]
    if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6) kinds.rotated++
    else if (d < 0 || a < 0) kinds.flipped++
    else if (Math.abs(a - 1) > 1e-6 || Math.abs(d - 1) > 1e-6) kinds.scaled++
    else if (Math.abs(+m[5]) > 1e-6 || Math.abs(+m[6]) > 1e-6) kinds.translate++
    else kinds.identity++
  }
  return { total, ...kinds }
}

function clipStats(stream) {
  return {
    rect_clips: countMatches(stream, /[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+re\s+W\*?\s+n\b/g),
    other_clips: countMatches(stream, /\bW\*?\s+n\b/g) -
                 countMatches(stream, /[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+re\s+W\*?\s+n\b/g),
    q: countMatches(stream, /(?:^|[\s\]>])q(?=[\s(<\[/%]|$)/g)
  }
}

function textOperators(stream) {
  return {
    BT: countMatches(stream, /(?<![A-Za-z0-9])BT(?![A-Za-z0-9])/g),
    Tj: countMatches(stream, /\bTj\b/g),
    TJ: countMatches(stream, /\bTJ\b/g),
    quote: countMatches(stream, /[)>]\s*'/g),
    dquote: countMatches(stream, /[)>]\s*"/g),
    Tm: countMatches(stream, /\bTm\b/g),
    Td: countMatches(stream, /\bTd\b/g),
    TD: countMatches(stream, /\bTD\b/g),
    Tstar: countMatches(stream, /\bT\*/g),
    Tf: countMatches(stream, /\bTf\b/g),
    hex_strings: countMatches(stream, /<[0-9A-Fa-f\s]{2,}>/g),
    Do: countMatches(stream, /\/[A-Za-z0-9_.+-]+\s+Do\b/g)
  }
}

/** Font dictionaries referenced by the page, by name. */
function fontInfo(pdfDoc, pageIndex, stream) {
  const names = [...new Set([...stream.matchAll(/\/([A-Za-z0-9_.+-]+)\s+[\d.]+\s+Tf/g)].map(m => m[1]))]
  const out = { subtypes: {}, base_fonts: [], cid: false, tounicode: 0, no_tounicode: 0,
                subset: 0, symbolic: 0, count: 0 }
  let page = null
  try {
    page = pdfDoc.loadPage(pageIndex)
    const res = page.getObject().get('Resources')
    const fonts = res && res.get ? res.get('Font') : null
    if (!fonts) return out
    for (const n of names) {
      let fd
      try { fd = fonts.get(n) } catch { continue }
      if (!fd || fd.isNull?.()) continue
      const f = fd.resolve ? fd.resolve() : fd
      out.count++
      const sub = String(f.get('Subtype') || '').replace(/^\//, '')
      out.subtypes[sub] = (out.subtypes[sub] || 0) + 1
      const base = String(f.get('BaseFont') || '').replace(/^\//, '')
      if (base) {
        out.base_fonts.push(base)
        if (/^[A-Z]{6}\+/.test(base)) out.subset++
      }
      if (sub === 'Type0') out.cid = true
      // ToUnicode lives on the unresolved reference
      let hasTU = false
      try { hasTU = !fd.get('ToUnicode')?.isNull?.() } catch { hasTU = false }
      if (!hasTU) { try { hasTU = !f.get('ToUnicode')?.isNull?.() } catch { hasTU = false } }
      if (hasTU) out.tounicode++; else out.no_tounicode++
      try {
        const desc = f.get('FontDescriptor')?.resolve?.()
        const flags = desc ? Number(desc.get('Flags')) : 0
        if (flags & 4) out.symbolic++
      } catch { /* no descriptor */ }
    }
  } catch { /* resources unreadable */ }
  finally { try { page?.destroy() } catch { /* already gone */ } }
  out.base_fonts = [...new Set(out.base_fonts)].slice(0, 12)
  return out
}

const results = []
for (const entry of manifest) {
  const rec = { pdf_id: entry.pdf_id, file: entry.file, staged: entry.staged, features: {}, error: null }
  try {
    const bytes = fs.readFileSync(path.join('public/_sweep', entry.staged))
    const doc = mupdf.Document.openDocument(bytes, 'application/pdf')
    const pdfDoc = doc.asPDF ? doc.asPDF() : doc
    const pageCount = doc.countPages()
    const nPages = Math.min(pageCount, MAX_PAGES)

    let stream = ''
    const pageSizes = []
    for (let p = 0; p < nPages; p++) {
      stream += readContentStream(pdfDoc, p) + '\n'
      const pg = doc.loadPage(p)
      const b = pg.getBounds()
      pageSizes.push({ w: Math.round((b[2] - b[0]) * 10) / 10, h: Math.round((b[3] - b[1]) * 10) / 10 })
      pg.destroy?.()
    }

    const fonts = fontInfo(pdfDoc, 0, stream)
    rec.features = {
      producer: entry.producer,
      creator: entry.creator,
      family: entry.family,
      pdf_version: entry.format,
      page_count: pageCount,
      pages_sampled: nPages,
      file_size: entry.size,
      encrypted: (() => { try { return !!doc.needsPassword() } catch { return false } })(),
      page_sizes: pageSizes,
      content_stream_bytes: stream.length,
      font_types: fonts.subtypes,
      font_count: fonts.count,
      base_fonts: fonts.base_fonts,
      cid: fonts.cid,
      tounicode: fonts.tounicode > 0,
      tounicode_missing: fonts.no_tounicode,
      subset_fonts: fonts.subset,
      symbolic_fonts: fonts.symbolic,
      actual_text: /\/ActualText/.test(stream),
      marked_content: countMatches(stream, /\bBDC\b/g),
      ctm: ctmStats(stream),
      clipping: clipStats(stream),
      text_operators: textOperators(stream),
      positions_with_tm_only: countMatches(stream, /\bTm\b/g) > 0 && countMatches(stream, /\bTd\b/g) === 0,
      positions_with_td_only: countMatches(stream, /\bTd\b/g) > 0 && countMatches(stream, /\bTm\b/g) === 0
    }
    doc.destroy?.()
  } catch (e) {
    rec.error = String(e.message || e).slice(0, 200)
  }
  results.push(rec)
  process.stderr.write(`. `)
}

fs.writeFileSync('tools/pdf-sweep/features.json', JSON.stringify(results, null, 2))
process.stderr.write(`\nwrote ${results.length} feature records\n`)

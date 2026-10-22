// Runs the fidelity driver's automatic edits over a staged corpus (gitignored
// like the PDFs): `await import('/_sweep/auto-corpus.js').then(m => m.start())`.
// Results land in window.__autoResults (one report per document),
// window.__autoSheets (before/after crops, for __fidelity.show) and
// window.__autoDone when every document has been run.
export async function start({ corpus = 'ocr', pagesPerDoc = 2, maxRuns = 3, only = null } = {}) {
  if (!window.__fidelity) await import('/_sweep/fidelity-driver.js')
  const manifest = await (await fetch(`/_sweep/${corpus}/manifest.json`)).json()
  window.__autoResults = []
  window.__autoSheets = {}
  window.__autoDone = false
  for (const m of manifest) {
    if (only && !only.includes(m.staged)) continue
    const pages = (m.scanPages || []).slice(0, pagesPerDoc)
    if (!pages.length) continue
    let r
    try {
      r = await window.__fidelity.runAuto({ url: `/_sweep/${m.staged}`, pages, maxRuns })
    } catch (err) {
      r = { error: String(err?.message || err), edits: [], pages: {} }
    }
    window.__autoResults.push({ staged: m.staged, producer: m.producer, ms: r.ms, error: r.error, edits: r.edits.map(e => ({ label: e.label, mode: e.mode, found: e.found, error: e.error })), pages: r.pages })
    window.__autoSheets[m.staged] = r.sheet
  }
  window.__autoDone = true
  return window.__autoResults.length
}

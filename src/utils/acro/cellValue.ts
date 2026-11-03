/**
 * Turning a cell's TEXT into what a spreadsheet can compute with.
 *
 * "S/ 1,170.00" exported as text cannot be summed, which is the first thing
 * anyone does with a table taken out of a PDF. A value is converted only when
 * the WHOLE cell is one unambiguous number, percentage or date, and it always
 * carries a number format that prints it exactly as the PDF did — so the
 * converted sheet reads the same, and only now also adds up.
 *
 * What stays text, on purpose:
 *  - identifiers: digit strings with a leading zero or of nine digits and more
 *    (RUC, phone and account numbers) — summing them means nothing, and Excel
 *    would print a long one in scientific notation;
 *  - anything with two values in it, or a separator the document's own
 *    convention does not explain ("1,5" in a document that writes "1,234.56").
 *
 * Which character is the decimal separator is decided ONCE for the document,
 * by vote over every cell: Peruvian business documents write "1,234.56", a
 * Spanish or German one "1.234,56", and "1,234" alone means either.
 */

export interface ValueConventions {
  decimal: '.' | ','
  /** Day before month (Spanish) or month before day. */
  dayFirst: boolean
}

export interface CellValue {
  value: string | number
  /** Number format code (OOXML invariant syntax: ',' groups, '.' decimals). */
  fmt?: string
  kind: 'number' | 'date' | 'text'
}

const CURRENCY = /^(S\/\.?|US\$|U\$S|\$|USD|PEN|EUR|€|£|¥|RMB|CNY|MXN|COP|CLP|BOB|ARS)\s?/i
const DATE_RE = /^(\d{1,4})([/-])(\d{1,2})\2(\d{1,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/

/** Evidence for the decimal separator and the date order, counted over all cells. */
export function detectConventions(texts: Iterable<string>): ValueConventions {
  let us = 0, eu = 0, dmy = 0, mdy = 0
  for (const raw of texts) {
    for (const tok of raw.split(/\s+/)) {
      const t = tok.replace(/^[(\-−$€]+|[)%\-]+$/g, '').replace(CURRENCY, '')
      if (/^\d{1,3}(,\d{3})+\.\d+$/.test(t) || /^\d+\.\d{1,2}$/.test(t)) us++
      else if (/^\d{1,3}(\.\d{3})+,\d+$/.test(t) || /^\d+,\d{1,2}$/.test(t)) eu++
      const d = DATE_RE.exec(t)
      if (d && d[1].length <= 2) {
        const a = +d[1], b = +d[3]
        if (a > 12 && b <= 12) dmy++
        else if (b > 12 && a <= 12) mdy++
      }
    }
  }
  return { decimal: eu > us ? ',' : '.', dayFirst: mdy <= dmy }
}

/** Days since 1899-12-30, Excel's day zero (1900 date system). */
function excelSerial(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): number {
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000 + (hh * 3600 + mm * 60 + ss) / 86400
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || y < 1900 || y > 2200) return false
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function parseDate(t: string, conv: ValueConventions): CellValue | null {
  const m = DATE_RE.exec(t)
  if (!m) return null
  const [, p1, sep, p2, p3, hh, mi, ss] = m
  let y: number, mo: number, d: number
  let fmt: string
  const time = hh !== undefined ? ` ${hh.length === 1 ? 'h' : 'hh'}:mm${ss !== undefined ? ':ss' : ''}` : ''
  if (p1.length === 4) {
    if (p3.length > 2) return null
    y = +p1; mo = +p2; d = +p3
    fmt = `yyyy${sep}${p2.length === 1 ? 'm' : 'mm'}${sep}${p3.length === 1 ? 'd' : 'dd'}`
  } else {
    if (p3.length !== 4 && p3.length !== 2) return null
    y = p3.length === 2 ? (+p3 < 50 ? 2000 + +p3 : 1900 + +p3) : +p3
    const yf = p3.length === 2 ? 'yy' : 'yyyy'
    let dayFirst = conv.dayFirst
    // A part over 12 can only be the day, whatever the document mostly does.
    if (+p1 > 12) dayFirst = true
    else if (+p2 > 12) dayFirst = false
    const dp = dayFirst ? p1 : p2, mp = dayFirst ? p2 : p1
    d = +dp; mo = +mp
    const df = dp.length === 1 ? 'd' : 'dd', mf = mp.length === 1 ? 'm' : 'mm'
    fmt = (dayFirst ? `${df}${sep}${mf}` : `${mf}${sep}${df}`) + `${sep}${yf}`
  }
  if (!validDate(y, mo, d)) return null
  let h = 0, mn = 0, s = 0
  if (hh !== undefined) {
    h = +hh; mn = +mi; s = ss !== undefined ? +ss : 0
    if (h > 23 || mn > 59 || s > 59) return null
  }
  return { value: excelSerial(y, mo, d, h, mn, s), fmt: fmt + time, kind: 'date' }
}

function escFmtLiteral(s: string): string {
  return `"${s.replace(/"/g, '')}"`
}

export function parseCellValue(text: string, conv: ValueConventions): CellValue {
  const raw = text.replace(/[  ]/g, ' ').trim()
  const asText: CellValue = { value: text, kind: 'text' }
  if (!raw || raw.length > 40 || !/\d/.test(raw)) return asText

  const date = parseDate(raw, conv)
  if (date) return date

  let t = raw
  let negative: '' | 'lead' | 'paren' | 'trail' = ''
  if (/^\(.*\)$/.test(t)) { negative = 'paren'; t = t.slice(1, -1).trim() }
  if (/^[-−]/.test(t)) { negative = 'lead'; t = t.slice(1).trim() }
  let prefix = ''
  const cm = CURRENCY.exec(t)
  if (cm) { prefix = cm[0]; t = t.slice(cm[0].length).trim() }
  if (!negative && /^\(.*\)$/.test(t)) { negative = 'paren'; t = t.slice(1, -1).trim() }
  if (!negative && /^[-−]/.test(t)) { negative = 'lead'; t = t.slice(1).trim() }
  if (!negative && /[-−]$/.test(t)) { negative = 'trail'; t = t.slice(0, -1).trim() }
  let percent = false
  if (/%$/.test(t)) { percent = true; t = t.slice(0, -1).trim() }
  if (percent && prefix) return asText

  const dec = conv.decimal, grp = dec === '.' ? ',' : '.'
  const e = (c: string) => c === '.' ? '\\.' : c
  const grouped = new RegExp(`^\\d{1,3}(${e(grp)}\\d{3})+(${e(dec)}\\d+)?$`)
  const plain = new RegExp(`^\\d+(${e(dec)}\\d+)?$`)
  const bareFraction = new RegExp(`^${e(dec)}\\d+$`)
  let isGrouped = false
  if (grouped.test(t)) isGrouped = true
  else if (!plain.test(t) && !bareFraction.test(t)) return asText

  const [intPart, fracPart = ''] = t.split(dec)
  const digits = intPart.split(grp).join('')
  // Identifiers, not quantities.
  if (!isGrouped && !fracPart && !prefix && !percent && !negative) {
    if (digits.length >= 9 || (digits.length > 1 && digits[0] === '0')) return asText
  }
  if (!isGrouped && digits.length > 1 && digits[0] === '0' && !fracPart) return asText
  if (digits.length > 15) return asText

  let n = Number(`${digits || '0'}.${fracPart || '0'}`)
  if (!Number.isFinite(n)) return asText
  if (negative) n = -n
  if (percent) n /= 100

  let core = isGrouped ? '#,##0' : '0'
  if (fracPart) core += '.' + '0'.repeat(Math.min(fracPart.length, 10))
  if (percent) core += '%'
  const pos = prefix ? escFmtLiteral(prefix) + core : core
  let fmt: string | undefined
  if (negative === 'paren') fmt = `${pos};(${pos})`
  else if (negative === 'trail') fmt = `${pos};${pos}-`
  else if (prefix || isGrouped || fracPart || percent) fmt = pos
  return { value: percent ? +n.toPrecision(15) : n, fmt, kind: 'number' }
}

/** A digit-only text Excel would flag with its green "number stored as text" triangle. */
export function looksNumericText(text: string): boolean {
  return /^[\d.,\s-]+$/.test(text.trim()) && /\d/.test(text)
}

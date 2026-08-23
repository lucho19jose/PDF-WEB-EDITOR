/**
 * Glyph name to Unicode, for fonts that name their characters.
 *
 * A simple font may carry an /Encoding dictionary with a /Differences array
 * that says, code by code, which GLYPH each byte draws — by name, not by
 * character. LaTeX does this for every document it makes: pdfTeX's OT1 encoding
 * puts the ligatures in the low codes, so byte 12 is not a form feed but "fi",
 * and Greek capitals sit where control characters would be.
 *
 * Without this table those bytes decode to control characters, the engine's
 * reading of the content stream disagrees with the text the page actually shows,
 * and the block can never be matched — the whole document reads as uneditable.
 *
 * It is not the complete Adobe Glyph List: it covers the Latin text a document
 * of this kind is made of, plus the ligatures and accents that make LaTeX
 * different. `uniXXXX` and `uXXXX` are handled by rule.
 */
const GLYPH_NAME_TO_UNICODE: Record<string, number> = { A: 0x41, AE: 0xC6, Aacute: 0xC1, Acircumflex: 0xC2, Adieresis: 0xC4, Agrave: 0xC0, Aring: 0xC5, Atilde: 0xC3, B: 0x42, C: 0x43, Ccedilla: 0xC7, D: 0x44, Delta: 0x394, E: 0x45, Eacute: 0xC9, Ecircumflex: 0xCA, Edieresis: 0xCB, Egrave: 0xC8, Eth: 0xD0, Euro: 0x20AC, F: 0x46, G: 0x47, Gamma: 0x393, H: 0x48, I: 0x49, Iacute: 0xCD, Icircumflex: 0xCE, Idieresis: 0xCF, Igrave: 0xCC, J: 0x4A, K: 0x4B, L: 0x4C, Lambda: 0x39B, Lslash: 0x141, M: 0x4D, N: 0x4E, Ntilde: 0xD1, O: 0x4F, OE: 0x152, Oacute: 0xD3, Ocircumflex: 0xD4, Odieresis: 0xD6, Ograve: 0xD2, Omega: 0x3A9, Oslash: 0xD8, Otilde: 0xD5, P: 0x50, Phi: 0x3A6, Pi: 0x3A0, Psi: 0x3A8, Q: 0x51, R: 0x52, S: 0x53, Scaron: 0x160, Sigma: 0x3A3, T: 0x54, Theta: 0x398, Thorn: 0xDE, U: 0x55, Uacute: 0xDA, Ucircumflex: 0xDB, Udieresis: 0xDC, Ugrave: 0xD9, Upsilon: 0x3A5, V: 0x56, W: 0x57, X: 0x58, Xi: 0x39E, Y: 0x59, Yacute: 0xDD, Ydieresis: 0x178, Z: 0x5A, Zcaron: 0x17D, a: 0x61, aacute: 0xE1, acircumflex: 0xE2, acute: 0xB4, adieresis: 0xE4, ae: 0xE6, agrave: 0xE0, ampersand: 0x26, aring: 0xE5, asciicircum: 0x5E, asciitilde: 0x7E, asterisk: 0x2A, at: 0x40, atilde: 0xE3, b: 0x62, backslash: 0x5C, bar: 0x7C, braceleft: 0x7B, braceright: 0x7D, bracketleft: 0x5B, bracketright: 0x5D, breve: 0x2D8, brokenbar: 0xA6, bullet: 0x2022, c: 0x63, caron: 0x2C7, ccedilla: 0xE7, cedilla: 0xB8, cent: 0xA2, circumflex: 0x2C6, colon: 0x3A, comma: 0x2C, copyright: 0xA9, currency: 0xA4, d: 0x64, dagger: 0x2020, daggerdbl: 0x2021, degree: 0xB0, dieresis: 0xA8, divide: 0xF7, dollar: 0x24, dotaccent: 0x2D9, dotlessi: 0x131, dotlessj: 0x237, e: 0x65, eacute: 0xE9, ecircumflex: 0xEA, edieresis: 0xEB, egrave: 0xE8, eight: 0x38, ellipsis: 0x2026, emdash: 0x2014, endash: 0x2013, equal: 0x3D, eth: 0xF0, euro: 0x20AC, exclam: 0x21, exclamdown: 0xA1, f: 0x66, ff: 0xFB00, ffi: 0xFB03, ffl: 0xFB04, fi: 0xFB01, five: 0x35, fl: 0xFB02, florin: 0x192, four: 0x34, fraction: 0x2044, g: 0x67, germandbls: 0xDF, grave: 0x60, greater: 0x3E, guillemotleft: 0xAB, guillemotright: 0xBB, guilsinglleft: 0x2039, guilsinglright: 0x203A, h: 0x68, hungarumlaut: 0x2DD, hyphen: 0x2D, i: 0x69, iacute: 0xED, icircumflex: 0xEE, idieresis: 0xEF, igrave: 0xEC, j: 0x6A, k: 0x6B, l: 0x6C, less: 0x3C, logicalnot: 0xAC, lslash: 0x142, m: 0x6D, macron: 0xAF, minus: 0x2212, mu: 0xB5, multiply: 0xD7, n: 0x6E, nine: 0x39, ntilde: 0xF1, numbersign: 0x23, o: 0x6F, oacute: 0xF3, ocircumflex: 0xF4, odieresis: 0xF6, oe: 0x153, ogonek: 0x2DB, ograve: 0xF2, one: 0x31, onehalf: 0xBD, onequarter: 0xBC, onesuperior: 0xB9, oslash: 0xF8, otilde: 0xF5, p: 0x70, paragraph: 0xB6, parenleft: 0x28, parenright: 0x29, percent: 0x25, period: 0x2E, periodcentered: 0xB7, perthousand: 0x2030, plus: 0x2B, plusminus: 0xB1, q: 0x71, question: 0x3F, questiondown: 0xBF, quotedbl: 0x22, quotedblbase: 0x201E, quotedblleft: 0x201C, quotedblright: 0x201D, quoteleft: 0x2018, quoteright: 0x2019, quotesinglbase: 0x201A, quotesingle: 0x27, r: 0x72, registered: 0xAE, ring: 0x2DA, s: 0x73, scaron: 0x161, section: 0xA7, semicolon: 0x3B, seven: 0x37, six: 0x36, slash: 0x2F, space: 0x20, sterling: 0xA3, t: 0x74, thorn: 0xFE, three: 0x33, threequarters: 0xBE, threesuperior: 0xB3, tilde: 0x2DC, trademark: 0x2122, two: 0x32, twosuperior: 0xB2, u: 0x75, uacute: 0xFA, ucircumflex: 0xFB, udieresis: 0xFC, ugrave: 0xF9, underscore: 0x5F, v: 0x76, w: 0x77, x: 0x78, y: 0x79, yacute: 0xFD, ydieresis: 0xFF, yen: 0xA5, z: 0x7A, zcaron: 0x17E, zero: 0x30 }

/** Unicode for a glyph name, or -1 when the name means nothing here. */
export function glyphNameToUnicode(name: string): number {
  const direct = GLYPH_NAME_TO_UNICODE[name]
  if (direct !== undefined) return direct
  // uniXXXX / uXXXX[XX] — the escape hatch every subsetter falls back on.
  let m = /^uni([0-9A-Fa-f]{4,6})$/.exec(name)
  if (m) return parseInt(m[1], 16)
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name)
  if (m) return parseInt(m[1], 16)
  // A bare letter is its own name in some subsets.
  if (name.length === 1) return name.charCodeAt(0)
  // TeX's OT1 puts /suppress where a space would be — it draws nothing, and a
  // gap is exactly what it means, so it reads back as a space rather than as an
  // unknown glyph. `.notdef` is genuinely unknown and stays that way.
  if (name === 'suppress') return 0x20
  return -1
}

/**
 * Who signed: the signer's identity out of a PKCS#7 / CMS signature.
 *
 * Neither Intellisign nor DocuSign writes /Name into the signature
 * dictionary, so the status bar could only count signatures. The signer's
 * name IS in the file — in the Subject of the X.509 certificate carried
 * inside /Contents (`adbe.pkcs7.detached`, `ETSI.CAdES.detached`) — and this
 * is a small DER walker that reads it out: ContentInfo → SignedData →
 * certificates, pick the signer's certificate, read its Subject's CN and O,
 * and the signing time from the signed attributes.
 *
 * Nothing is VERIFIED. No hash, no signature check, no chain validation —
 * the editor's business is to say who a document claims to be signed by,
 * and every edit breaks the signature anyway. A malformed structure yields
 * `undefined`; nothing here throws.
 *
 * Dependency-free on purpose: a CMS library is hundreds of KB for a task
 * that is three nested SEQUENCEs and a string.
 */

export interface Pkcs7Signer {
  /** Subject CN of the signer's certificate. */
  commonName?: string
  /** Subject O (organisation) of the signer's certificate. */
  organisation?: string
  /** The `signingTime` signed attribute, as ISO 8601 (UTC). */
  signingTime?: string
}

/** One decoded TLV: where its content lies and what tag it carries. */
interface Tlv {
  /** Tag class bits + constructed bit + number, as the raw first byte (low-tag-number form only). */
  tag: number
  /** Tag number (the low 5 bits, or the long-form value). */
  tagNumber: number
  /** Class: 0 universal, 1 application, 2 context, 3 private. */
  cls: number
  constructed: boolean
  /** Offset of the first content byte. */
  start: number
  /** Offset one past the last content byte. */
  end: number
  /** Offset of the tag byte, so the whole element (header + content) can be sliced. */
  headerStart: number
}

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2'
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5'
const OID_CN = '2.5.4.3'
const OID_O = '2.5.4.10'

/**
 * Decode one TLV at `pos`. Handles long-form lengths and BER indefinite
 * length (some CMS writers use it) by scanning for the end-of-contents
 * octets. Returns null on anything that does not fit in the buffer.
 */
function readTlv(b: Uint8Array, pos: number): Tlv | null {
  if (pos < 0 || pos + 2 > b.length) return null
  const headerStart = pos
  const first = b[pos++]
  const cls = first >> 6
  const constructed = (first & 0x20) !== 0
  let tagNumber = first & 0x1f
  if (tagNumber === 0x1f) {
    // High-tag-number form: base-128, high bit set on every byte but the last.
    tagNumber = 0
    let guard = 0
    for (;;) {
      if (pos >= b.length || guard++ > 4) return null
      const x = b[pos++]
      tagNumber = (tagNumber << 7) | (x & 0x7f)
      if ((x & 0x80) === 0) break
    }
  }
  if (pos >= b.length) return null
  let len = b[pos++]
  if (len === 0x80) {
    // Indefinite length: content runs to the 00 00 end-of-contents marker,
    // found by walking the children (they are TLVs themselves).
    if (!constructed) return null
    const start = pos
    let p = pos
    for (let guard = 0; guard < 100000; guard++) {
      if (p + 2 > b.length) return null
      if (b[p] === 0 && b[p + 1] === 0) return { tag: first, tagNumber, cls, constructed, start, end: p, headerStart }
      const child = readTlv(b, p)
      if (!child) return null
      p = child.end + (child.end < b.length && isIndefiniteAt(b, child) ? 2 : 0)
    }
    return null
  }
  if (len & 0x80) {
    const n = len & 0x7f
    if (n === 0 || n > 4 || pos + n > b.length) return null
    len = 0
    for (let i = 0; i < n; i++) len = (len << 8) | b[pos++]
    if (len < 0) return null
  }
  const start = pos
  const end = start + len
  if (end > b.length) return null
  return { tag: first, tagNumber, cls, constructed, start, end, headerStart }
}

/** Whether the TLV at `t` was written with an indefinite length (its end sits before an EOC marker it owns). */
function isIndefiniteAt(b: Uint8Array, t: Tlv): boolean {
  // The length byte follows the tag byte(s); find it again.
  let p = t.headerStart + 1
  if ((b[t.headerStart] & 0x1f) === 0x1f) { while (p < b.length && (b[p] & 0x80)) p++; p++ }
  return p < b.length && b[p] === 0x80
}

/** The children of a constructed TLV, in order. Empty on any decoding trouble. */
function children(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = []
  if (!t.constructed) return out
  let p = t.start
  for (let guard = 0; p < t.end && guard < 100000; guard++) {
    const c = readTlv(b, p)
    if (!c) break
    out.push(c)
    p = c.end
    // Skip the end-of-contents octets of an indefinite-length child.
    if (isIndefiniteAt(b, c)) p += 2
  }
  return out
}

/** Whole element bytes (header + content), for byte-exact comparisons of Names. */
function elementBytes(b: Uint8Array, t: Tlv): Uint8Array {
  return b.subarray(t.headerStart, t.end)
}

function sameBytes(x: Uint8Array, y: Uint8Array): boolean {
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}

const isUniversal = (t: Tlv, n: number) => t.cls === 0 && t.tagNumber === n
const isContext = (t: Tlv, n: number) => t.cls === 2 && t.tagNumber === n
const SEQ = 16, SET = 17, OID = 6, INT = 2

/** Dotted OID text of an OBJECT IDENTIFIER's content. */
function decodeOid(b: Uint8Array, t: Tlv): string | undefined {
  if (!isUniversal(t, OID) || t.end <= t.start) return undefined
  const parts: number[] = []
  let v = 0
  for (let p = t.start; p < t.end; p++) {
    const x = b[p]
    v = v * 128 + (x & 0x7f)
    if ((x & 0x80) === 0) {
      if (parts.length === 0) { parts.push(Math.min(2, Math.floor(v / 40)), v - 40 * Math.min(2, Math.floor(v / 40))) }
      else parts.push(v)
      v = 0
    }
  }
  return parts.join('.')
}

/**
 * A directory string as text. The CN of a certificate may be any of the
 * DirectoryString choices; each has its own encoding.
 */
function decodeString(b: Uint8Array, t: Tlv): string | undefined {
  if (t.cls !== 0) return undefined
  const bytes = b.subarray(t.start, t.end)
  try {
    switch (t.tagNumber) {
      case 12: // UTF8String
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      case 19: // PrintableString
      case 22: // IA5String
      case 26: // VisibleString
      case 20: // TeletexString (T.61) — Latin-1 is the reading every real-world CA meant
        return new TextDecoder('latin1').decode(bytes)
      case 30: { // BMPString — UTF-16BE, no BOM
        let s = ''
        for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
        return s
      }
      case 28: { // UniversalString — UTF-32BE
        let s = ''
        for (let i = 0; i + 3 < bytes.length; i += 4) {
          const cp = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0
          if (cp <= 0x10ffff) s += String.fromCodePoint(cp)
        }
        return s
      }
      default:
        return undefined
    }
  } catch { return undefined }
}

/** UTCTime / GeneralizedTime as ISO 8601; undefined when it does not parse. */
function decodeTime(b: Uint8Array, t: Tlv): string | undefined {
  if (t.cls !== 0 || (t.tagNumber !== 23 && t.tagNumber !== 24)) return undefined
  let s = ''
  for (let p = t.start; p < t.end; p++) s += String.fromCharCode(b[p])
  let m: RegExpExecArray | null
  let Y: string, Mo: string, D: string, h: string, mi: string, sec: string, tz: string | undefined
  if (t.tagNumber === 23) {
    m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(Z|[+\-]\d{4})?$/.exec(s)
    if (!m) return undefined
    const yy = Number(m[1])
    Y = String(yy < 50 ? 2000 + yy : 1900 + yy)
    ;[, , Mo, D, h, mi] = m
    sec = m[6] ?? '00'
    tz = m[7]
  } else {
    m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})?(\d{2})?(?:[.,]\d+)?(Z|[+\-]\d{4})?$/.exec(s)
    if (!m) return undefined
    ;[, Y, Mo, D, h] = m
    mi = m[5] ?? '00'
    sec = m[6] ?? '00'
    tz = m[7]
  }
  let iso = `${Y}-${Mo}-${D}T${h}:${mi}:${sec}`
  if (!tz || tz === 'Z') iso += 'Z'
  else iso += `${tz.slice(0, 3)}:${tz.slice(3)}`
  return iso
}

/**
 * The CN and O of an X.501 Name (SEQUENCE OF SET OF SEQUENCE { OID, value }).
 * The LAST CN wins when several are present — the most specific RDN is the
 * last one, and a CA that repeats a CN puts the person's name there.
 */
function readName(b: Uint8Array, name: Tlv): { cn?: string; o?: string } {
  const out: { cn?: string; o?: string } = {}
  if (!isUniversal(name, SEQ)) return out
  for (const rdn of children(b, name)) {
    if (!isUniversal(rdn, SET)) continue
    for (const atv of children(b, rdn)) {
      if (!isUniversal(atv, SEQ)) continue
      const [oidT, valT] = children(b, atv)
      if (!oidT || !valT) continue
      const oid = decodeOid(b, oidT)
      if (oid !== OID_CN && oid !== OID_O) continue
      const text = decodeString(b, valT)?.replace(/\0/g, '').trim()
      if (!text) continue
      if (oid === OID_CN) out.cn = text
      else out.o = text
    }
  }
  return out
}

interface CertView {
  issuer: Uint8Array
  subject: Uint8Array
  serial: Uint8Array
  subjectName: Tlv
}

/** Issuer, subject and serial of a Certificate (SEQUENCE { tbs, alg, sig }). */
function readCertificate(b: Uint8Array, cert: Tlv): CertView | undefined {
  if (!isUniversal(cert, SEQ)) return undefined
  const tbs = children(b, cert)[0]
  if (!tbs || !isUniversal(tbs, SEQ)) return undefined
  const f = children(b, tbs)
  let i = 0
  if (f[i] && isContext(f[i], 0)) i++ // [0] EXPLICIT version, optional
  // serialNumber, signature (AlgorithmIdentifier), issuer, validity, subject, …
  const serial = f[i]
  const issuer = f[i + 2]
  const subject = f[i + 4]
  if (!serial || !issuer || !subject) return undefined
  if (!isUniversal(serial, INT) || !isUniversal(issuer, SEQ) || !isUniversal(subject, SEQ)) return undefined
  return {
    issuer: elementBytes(b, issuer),
    subject: elementBytes(b, subject),
    serial: b.subarray(serial.start, serial.end),
    subjectName: subject
  }
}

/**
 * The signer's certificate and signing time out of a DER-encoded PKCS#7
 * SignedData (`/Contents` of a signature dictionary, zero padding included).
 * `undefined` when the bytes are not a SignedData this reader can follow.
 */
export function readPkcs7Signer(input: Uint8Array | ArrayBuffer | null | undefined): Pkcs7Signer | undefined {
  try {
    if (!input) return undefined
    let b = input instanceof Uint8Array ? input : new Uint8Array(input)
    if (b.length < 4) return undefined
    // Some readers hand the hex text of a `<…>` string rather than its bytes.
    if (b[0] !== 0x30) {
      const hex = hexTextToBytes(b)
      if (!hex) return undefined
      b = hex
    }
    const contentInfo = readTlv(b, 0)
    if (!contentInfo || !isUniversal(contentInfo, SEQ)) return undefined
    const [ctOid, ctBody] = children(b, contentInfo)
    if (!ctOid || !ctBody || decodeOid(b, ctOid) !== OID_SIGNED_DATA || !isContext(ctBody, 0)) return undefined
    const signedData = children(b, ctBody)[0]
    if (!signedData || !isUniversal(signedData, SEQ)) return undefined

    // SignedData: version, digestAlgorithms, encapContentInfo, [0] certs, [1] crls, signerInfos.
    let certsT: Tlv | undefined
    let signerInfosT: Tlv | undefined
    for (const c of children(b, signedData)) {
      if (isContext(c, 0)) certsT = c
      else if (isUniversal(c, SET)) signerInfosT = c // the digestAlgorithms SET comes first; the last SET is signerInfos
    }

    // The first SignerInfo: its sid and signed attributes.
    let sidIssuer: Uint8Array | undefined
    let sidSerial: Uint8Array | undefined
    let signingTime: string | undefined
    const signerInfo = signerInfosT ? children(b, signerInfosT).find(c => isUniversal(c, SEQ)) : undefined
    if (signerInfo) {
      const parts = children(b, signerInfo)
      const sid = parts[1]
      if (sid && isUniversal(sid, SEQ)) {
        const [iss, ser] = children(b, sid)
        if (iss && ser && isUniversal(iss, SEQ) && isUniversal(ser, INT)) {
          sidIssuer = elementBytes(b, iss)
          sidSerial = b.subarray(ser.start, ser.end)
        }
      }
      const signedAttrs = parts.find(p => isContext(p, 0))
      if (signedAttrs) {
        for (const attr of children(b, signedAttrs)) {
          if (!isUniversal(attr, SEQ)) continue
          const [typeT, valuesT] = children(b, attr)
          if (!typeT || !valuesT || decodeOid(b, typeT) !== OID_SIGNING_TIME) continue
          const v = children(b, valuesT)[0]
          if (v) signingTime = decodeTime(b, v)
        }
      }
    }

    // The certificates: match issuer+serial to the sid when possible, else
    // the first end-entity certificate (one that issues no other), else the first.
    const certs: CertView[] = []
    if (certsT) {
      for (const c of children(b, certsT)) {
        if (!isUniversal(c, SEQ)) continue // [1]/[2]/[3] CertificateChoices are not X.509
        const view = readCertificate(b, c)
        if (view) certs.push(view)
      }
    }
    let chosen: CertView | undefined
    if (sidIssuer && sidSerial) {
      chosen = certs.find(c => sameBytes(c.issuer, sidIssuer!) && sameBytes(c.serial, sidSerial!))
    }
    if (!chosen) {
      chosen = certs.find(c => !certs.some(other => other !== c && sameBytes(other.issuer, c.subject)))
    }
    if (!chosen) chosen = certs[0]

    const name = chosen ? readName(b, chosen.subjectName) : {}
    if (!name.cn && !name.o && !signingTime) return undefined
    return { commonName: name.cn, organisation: name.o, signingTime }
  } catch {
    return undefined
  }
}

/** Bytes of a run of hex digits (whitespace ignored), or undefined when the text is not hex. */
function hexTextToBytes(b: Uint8Array): Uint8Array | undefined {
  const out: number[] = []
  let hi = -1
  for (let i = 0; i < b.length; i++) {
    const c = b[i]
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x3c || c === 0x3e) continue
    let v: number
    if (c >= 0x30 && c <= 0x39) v = c - 0x30
    else if (c >= 0x41 && c <= 0x46) v = c - 0x41 + 10
    else if (c >= 0x61 && c <= 0x66) v = c - 0x61 + 10
    else return undefined
    if (hi < 0) hi = v
    else { out.push((hi << 4) | v); hi = -1 }
  }
  if (hi >= 0) out.push(hi << 4)
  return out.length && out[0] === 0x30 ? Uint8Array.from(out) : undefined
}

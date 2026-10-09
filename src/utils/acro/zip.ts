/**
 * A minimal ZIP writer — STORE only, no compression.
 *
 * Two things here need a zip and nothing else does: a .docx is a zip of XML
 * parts, and "export every page as an image" or "split into files" hands back
 * many files where one download is wanted. The entries are mostly PNG/JPEG
 * (already compressed) or small XML, so deflate would buy little for a
 * dependency; STORE with a CRC-32 is what every unzipper reads.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

export interface ZipEntry { name: string; data: Uint8Array | string }

/** DOS date/time for "now", as ZIP stores it. */
function dosStamp(d = new Date()): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

export function makeZip(entries: ZipEntry[]): Blob {
  const enc = new TextEncoder()
  const { time, date } = dosStamp()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.name)
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034B50, true)
    local.setUint16(4, 20, true)          // version needed
    local.setUint16(6, 0x0800, true)      // UTF-8 names
    local.setUint16(8, 0, true)           // STORE
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, name.length, true)
    local.setUint16(28, 0, true)
    chunks.push(new Uint8Array(local.buffer), name, data)

    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0, 0x02014B50, true)
    cd.setUint16(4, 20, true)
    cd.setUint16(6, 20, true)
    cd.setUint16(8, 0x0800, true)
    cd.setUint16(10, 0, true)
    cd.setUint16(12, time, true)
    cd.setUint16(14, date, true)
    cd.setUint32(16, crc, true)
    cd.setUint32(20, data.length, true)
    cd.setUint32(24, data.length, true)
    cd.setUint16(28, name.length, true)
    cd.setUint32(42, offset, true)
    central.push(new Uint8Array(cd.buffer), name)
    offset += 30 + name.length + data.length
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054B50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, cdSize, true)
  end.setUint32(16, offset, true)
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: 'application/zip' })
}

// opentype.js 2.0 ships no type declarations; only what this app uses.
declare module 'opentype.js' {
  export class Path {
    moveTo(x: number, y: number): void
    lineTo(x: number, y: number): void
    curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void
    quadTo(x1: number, y1: number, x: number, y: number): void
    close(): void
    getBoundingBox(): { x1: number; y1: number; x2: number; y2: number }
  }
  export class Glyph {
    constructor(options: { name: string; unicode?: number; advanceWidth: number; path: Path })
    index: number
    name: string
    unicode?: number
    advanceWidth: number
    path: Path
  }
  export class Font {
    constructor(options: {
      familyName: string
      styleName: string
      unitsPerEm: number
      ascender: number
      descender: number
      glyphs: Glyph[]
    })
    unitsPerEm: number
    ascender: number
    descender: number
    charToGlyph(char: string): Glyph
    toArrayBuffer(): ArrayBuffer
  }
  export function parse(buffer: ArrayBuffer): Font
}

declare module 'esm-potrace-wasm' {
  export function init(): Promise<void>
  export function potrace(source: ImageBitmapSource, options?: Record<string, unknown>): Promise<string>
}

import * as mupdf from 'mupdf'
import fs from 'fs'
/**
 * Magenta, and a 3:1 shape.
 *
 * Grey was a mistake as a test colour: anti-aliased black text is grey, so the
 * detector found "the image" spread across every paragraph on the page.
 * Nothing in a text document is magenta.
 */
const W = 300, H = 100
const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, W, H], false)
pix.clear(255)
const px = pix.getPixels()
const stride = px.length / (W * H)
for (let i = 0; i < W * H; i++) { px[i*stride] = 255; px[i*stride+1] = 0; px[i*stride+2] = 255 }
fs.writeFileSync('public/_block.png', pix.asPNG())
console.log('magenta 300x100 written')

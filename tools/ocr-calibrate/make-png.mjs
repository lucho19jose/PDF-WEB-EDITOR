import * as mupdf from 'mupdf'
import fs from 'fs'
// A flat coloured block is enough to see which side of the text it lands on.
const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 240, 120], false)
pix.clear(190)
fs.writeFileSync('public/_block.png', pix.asPNG())
console.log('png written')

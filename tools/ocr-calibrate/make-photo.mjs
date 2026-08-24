import * as mupdf from 'mupdf'
import fs from 'fs'
/** A photo-sized JPEG, like one off a phone: big, and not a tidy aspect. */
const W = 1200, H = 3200
const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, W, H], false)
const px = pix.getPixels()
const stride = px.length / (W * H)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * stride
  px[i] = 255; px[i+1] = 0; px[i+2] = 255          // magenta field
  if (x < 40 || y < 40 || x > W - 40 || y > H - 40) { px[i] = 0; px[i+1] = 200; px[i+2] = 0 }  // green border
}
fs.writeFileSync('public/_tall.jpg', Buffer.from(pix.asJPEG(90, false)))
console.log('photo', W + 'x' + H, 'aspect', (W/H).toFixed(3))

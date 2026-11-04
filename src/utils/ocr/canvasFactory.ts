/**
 * Where the OCR code gets a fresh canvas. In the browser it is a DOM canvas;
 * the MCP server (Node, no DOM) sets an `@napi-rs/canvas` factory once at
 * startup. Recognition only draws, rotates, copies and reads pixels back, all
 * of which both provide.
 */
let factory: (width: number, height: number) => HTMLCanvasElement = (width, height) => {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}

export function makeCanvas(width: number, height: number): HTMLCanvasElement {
  return factory(width, height)
}

export function setCanvasFactory(fn: (width: number, height: number) => HTMLCanvasElement): void {
  factory = fn
}

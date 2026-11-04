/**
 * stdout carries the MCP JSON-RPC stream and nothing else: one stray log line
 * and the client drops the connection. Everything that would print there —
 * this server's own logs, MuPDF's warnings, Emscripten's `out` — goes to
 * stderr, which Claude keeps as the server's log.
 *
 * Imported FIRST by every entry point, before anything that might log while
 * it loads (Emscripten binds `console.log` at load time).
 */
const toStderr = (...args: unknown[]) => console.error(...args)
console.log = toStderr
console.info = toStderr
console.debug = toStderr

export {}

/**
 * Global FIFO queue for document-level operations (text edits, annotation
 * changes, page ops, undo/redo, save-sync). The MuPDF worker itself serializes
 * messages, but multi-step operations (mutate → save → reload both engines)
 * must not interleave: an op landing between another op's save and reload
 * mutates a document that is about to be replaced and is silently lost, and
 * undo snapshots read stale bytes.
 */
let chain: Promise<unknown> = Promise.resolve()

export function enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

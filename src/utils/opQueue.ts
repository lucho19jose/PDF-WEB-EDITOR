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

/**
 * Some operations are not ONE queued step but several, with gaps between them.
 *
 * Inserting an image makes room in the text, waits for the save-and-reload that
 * follows, then stamps the picture — three or four trips through the queue. The
 * queue keeps each of those from interleaving with anything else, and does
 * nothing at all about the GAPS: an undo landing in one replaced the whole
 * document underneath an operation that was still running. On a full page,
 * where making room takes half a minute, that is an easy thing to do and it
 * left the document with a blank page and a third of its bytes gone.
 *
 * A transaction is held across the whole sequence. It does not block the queue
 * — the operation's own steps still have to go through it — it only lets
 * anything that would REPLACE the document wait until the sequence is finished.
 */
let openTransactions = 0
let settledWaiters: (() => void)[] = []

/** Hold the document steady. The returned function MUST be called in a finally. */
export function beginTransaction(): () => void {
  openTransactions++
  let released = false
  return () => {
    if (released) return
    released = true
    openTransactions--
    if (openTransactions <= 0) {
      openTransactions = 0
      const waiting = settledWaiters
      settledWaiters = []
      for (const resolve of waiting) resolve()
    }
  }
}

/** Resolves once no multi-step operation is in flight. */
export function settleTransactions(): Promise<void> {
  if (openTransactions <= 0) return Promise.resolve()
  return new Promise<void>(resolve => settledWaiters.push(resolve))
}

export function transactionOpen(): boolean {
  return openTransactions > 0
}

export function createTranscriptTurnQueue({ runTurn, isReady = (_text) => true }) {
  let running = false;
  let buffered = [];
  let current = Promise.resolve();
  // Pending holds chunks the isReady predicate has not let through yet: a
  // buffer without enough substantive content keeps accumulating until a
  // later chunk makes it ready.
  let pending = [];

  function flushPending({ force = false } = {}) {
    if (pending.length === 0) return;
    const text = pending.join("\n");
    if (!force && !isReady(text)) {
      // Not enough content yet - keep pending; the next enqueue re-checks.
      return;
    }
    pending = [];
    if (running) {
      buffered.push(text);
    } else {
      current = drain(text);
    }
  }

  async function drain(text) {
    running = true;
    try {
      await runTurn(text);
    } finally {
      if (buffered.length > 0) {
        const next = buffered.join("\n");
        buffered = [];
        current = drain(next);
      } else {
        running = false;
        // If pending arrived during the turn and is now ready, flush it. If
        // it's still not ready (only fillers), leave it accumulating.
        flushPending();
      }
    }
  }

  function enqueue(text) {
    const trimmed = text.trim();
    if (!trimmed) return current;
    pending.push(trimmed);
    flushPending();
    return current;
  }

  async function idle() {
    // Force-flush any pending content (bypassing isReady) so idle() always
    // terminates - tests and shutdown paths shouldn't hang on a buffer that
    // happens to contain only fillers.
    while (running || buffered.length > 0 || pending.length > 0) {
      flushPending({ force: true });
      await current;
    }
  }

  return { enqueue, idle };
}

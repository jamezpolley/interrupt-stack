// The live-update stream with its own reconnect. A browser retries an EventSource by itself after a
// dropped connection, but gives up for good (readyState CLOSED) when the reconnect gets an HTTP error
// such as a proxy's 502 during a server restart. In that case this reconnects with a capped backoff.
const CLOSED = 2;

export function createEventStream({
  url,
  onSeq,
  onQueueSeq = () => {},
  make = (u) => new EventSource(u),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (t) => clearTimeout(t),
  baseMs = 1000,
  maxMs = 30000,
}) {
  let source = null;
  let timer = null;
  let attempt = 0;

  function connect() {
    close();
    const s = make(url);
    source = s;
    s.addEventListener("seq", onSeq);
    s.addEventListener("qseq", onQueueSeq); // the queue's own event; a client that does not know it never hears it
    s.addEventListener("open", () => {
      attempt = 0;
    });
    s.onerror = () => {
      if (s !== source || s.readyState !== CLOSED || timer) return;
      const delay = Math.min(maxMs, baseMs * 2 ** attempt);
      attempt += 1;
      timer = schedule(() => {
        timer = null;
        connect();
      }, delay);
    };
  }

  function close() {
    if (timer) cancel(timer);
    timer = null;
    source?.close();
    source = null;
  }

  return { connect, close };
}

import { EventEmitter } from "node:events";

/**
 * A stand-in for a `ws` WebSocket: text frames land in `sent`, binary ones in
 * `binary`, and `receive` delivers a server message.
 */
export function createMockSocket() {
  const socket = /** @type {any} */ (new EventEmitter());
  socket.sent = [];
  socket.binary = [];
  socket.closed = false;
  socket.send = (data) => {
    if (Buffer.isBuffer(data)) socket.binary.push(data);
    else socket.sent.push(String(data));
  };
  socket.close = () => {
    socket.closed = true;
    socket.emit("close");
  };
  socket.receive = (message) => socket.emit("message", Buffer.from(JSON.stringify(message)));
  return socket;
}

/**
 * Deterministic stand-ins for the timer functions the engines take as
 * dependencies. Node's own fake timers do not reach a module that captured
 * setTimeout at construction, so the engines accept them explicitly.
 */
export function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeoutFn: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms, repeat: null });
      return id;
    },
    clearTimeoutFn: (id) => timers.delete(id),
    setIntervalFn: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms, repeat: ms });
      return id;
    },
    clearIntervalFn: (id) => timers.delete(id),
    advance(ms) {
      const target = now + ms;
      // Fire in time order, re-arming repeats, until nothing is due.
      for (;;) {
        let due = null;
        let dueId = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === null || timer.at < due.at)) {
            due = timer;
            dueId = id;
          }
        }
        if (!due) break;
        now = due.at;
        if (due.repeat === null) timers.delete(dueId);
        else due.at = now + due.repeat;
        due.fn();
      }
      now = target;
    },
    get pending() {
      return timers.size;
    },
  };
}

import { randomUUID } from "node:crypto";

export const MAX_APPLICATION_BYTES = 2 * 1024 * 1024;
export const MAX_WIRE_BYTES = 16_384;
const MAX_QUEUE_BYTES = 4 * MAX_APPLICATION_BYTES;
const MAX_BUFFER_BYTES = 64 * 1024;

export function notifySafely(listener, ...args) {
  try { listener?.(...args)?.catch?.(() => {}); } catch { /* Application failures must not escape native callbacks. */ }
}

export function createFramedPeer({ id, write, close, bufferedAmount = () => 0, maxFrameBytes = MAX_WIRE_BYTES, transport = "p2p", route }) {
  let closed = false, queuedBytes = 0, assemblyBytes = 0, pumping = false, windowStarted = Date.now(), windowBytes = 0;
  const listeners = new Set(), closeListeners = new Set(), queue = [], assemblies = new Map(), delivered = new Set();
  const fragmentBytes = Math.min(8192, Math.floor((maxFrameBytes - 512) * 3 / 4));
  if (fragmentBytes < 256) throw new Error("Negotiated channel message limit is too small.");
  const sweep = setInterval(() => {
    const now = Date.now();
    if ([...assemblies.values()].some((entry) => now - entry.started > 10_000)) finish("Fragment assembly timed out.");
  }, 1000);
  sweep.unref?.();

  function finish(reason = "Connection closed.") {
    if (closed) return;
    closed = true;
    clearInterval(sweep);
    queue.length = 0; assemblies.clear(); delivered.clear(); assemblyBytes = queuedBytes = 0;
    try { close(); } catch { /* The native connection may already be closed. */ }
    for (const listener of closeListeners) notifySafely(listener, reason);
    listeners.clear(); closeListeners.clear();
  }

  function pump() {
    if (closed) { pumping = false; return; }
    let written = 0;
    while (queue.length && bufferedAmount() < MAX_BUFFER_BYTES && written++ < 8) {
      const item = queue[0];
      const index = item.next++;
      const data = item.bytes.subarray(index * fragmentBytes, (index + 1) * fragmentBytes).toString("base64");
      const frame = JSON.stringify({ v: 1, id: item.id, index, total: item.total, data });
      try {
        if (Buffer.byteLength(frame) > maxFrameBytes || write(frame) === false) { finish("Transport send failed."); break; }
      } catch { finish("Transport send failed."); break; }
      if (item.next === item.total) { queue.splice(queue.indexOf(item), 1); queuedBytes -= item.bytes.length; }
    }
    if (queue.length && !closed) setTimeout(pump, 5).unref?.();
    else pumping = false;
  }

  const peer = {
    id, transport, route,
    get closed() { return closed; },
    send(value) {
      if (closed) throw new Error("Connection is closed.");
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > MAX_APPLICATION_BYTES || queuedBytes + bytes.length > MAX_QUEUE_BYTES) { finish("Outgoing message limit exceeded."); throw new Error("Outgoing message limit exceeded."); }
      const priority = ["heartbeat", "ping", "pong", "request", "response"].includes(value?.type || value?.kind);
      const item = { id: randomUUID(), bytes, total: Math.max(1, Math.ceil(bytes.length / fragmentBytes)), next: 0, priority };
      if (priority && queue.length) {
        let index = 0;
        while (queue[index]?.priority) index++;
        queue.splice(index, 0, item);
      } else queue.push(item);
      queuedBytes += bytes.length;
      if (!pumping) { pumping = true; setImmediate(pump); }
    },
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onClose(listener) { if (closed) queueMicrotask(() => notifySafely(listener, "Connection is closed.")); else closeListeners.add(listener); return () => closeListeners.delete(listener); },
    close: finish,
    receive(raw) {
      if (closed) return;
      try {
        if (typeof raw !== "string" || Buffer.byteLength(raw) > maxFrameBytes) throw new Error("Invalid transport frame.");
        if (Date.now() - windowStarted > 1000) { windowStarted = Date.now(); windowBytes = 0; }
        windowBytes += Buffer.byteLength(raw);
        if (windowBytes > 8 * MAX_APPLICATION_BYTES) throw new Error("Incoming transport rate exceeded.");
        const frame = JSON.parse(raw);
        if (frame.v !== 1 || !/^[0-9a-f-]{36}$/.test(frame.id) || !Number.isInteger(frame.total) || frame.total < 1 || frame.total > Math.ceil(MAX_APPLICATION_BYTES / fragmentBytes) ||
            !Number.isInteger(frame.index) || frame.index < 0 || frame.index >= frame.total || typeof frame.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new Error("Invalid transport frame.");
        if (delivered.has(frame.id)) return;
        let assembly = assemblies.get(frame.id);
        if (!assembly) {
          if (assemblies.size >= 8) throw new Error("Too many fragment assemblies.");
          assembly = { total: frame.total, parts: new Map(), bytes: 0, started: Date.now() };
          assemblies.set(frame.id, assembly);
        }
        if (assembly.total !== frame.total) throw new Error("Fragment count changed.");
        if (assembly.parts.has(frame.index)) throw new Error("Duplicate fragment.");
        const part = Buffer.from(frame.data, "base64");
        assembly.parts.set(frame.index, part); assembly.bytes += part.length; assemblyBytes += part.length;
        if (assembly.bytes > MAX_APPLICATION_BYTES || assemblyBytes > MAX_QUEUE_BYTES) throw new Error("Incoming message limit exceeded.");
        if (assembly.parts.size === assembly.total) {
          const message = JSON.parse(Buffer.concat(Array.from({ length: assembly.total }, (_, index) => assembly.parts.get(index))).toString("utf8"));
          assemblies.delete(frame.id); assemblyBytes -= assembly.bytes; delivered.add(frame.id);
          if (delivered.size > 256) delivered.delete(delivered.values().next().value);
          for (const listener of listeners) notifySafely(listener, message);
        }
      } catch { finish("Invalid or excessive transport message."); }
    },
  };
  return peer;
}

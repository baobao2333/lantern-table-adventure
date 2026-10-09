import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { digest, verifyEnvelope } from "../local/network/identity.mjs";

const idPattern = /^[A-Za-z0-9_-]{16,96}$/;
const validId = (value) => typeof value === "string" && idPattern.test(value);
const validSdp = (value) => typeof value === "string" && value.length <= 96_000 && value.startsWith("v=0") && !/(?:^|\r?\n)a=candidate:[^\r\n]*\btyp\s+relay\b/i.test(value);

export async function startSignalServer({ host = "127.0.0.1", port = 0, tls, maxConnections = 128, maxRooms = 1024 } = {}) {
  if (!tls && !["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Public signaling requires TLS.");
  const serviceEpoch = randomUUID(), rooms = new Map(), negotiations = new Map();
  const server = (tls ? createHttpsServer : createHttpServer)({ ...tls, requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 }, (request, response) => {
    response.writeHead(request.url === "/health" ? 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ protocol: 1, status: request.url === "/health" ? "ready" : "not-found" }));
  });
  server.maxConnections = maxConnections * 2;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 128_000, perMessageDeflate: false });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/signal" || sockets.clients.size >= maxConnections || request.headers.origin) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws, request));
  });
  const send = (ws, value) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 256_000) { ws.close(1008, "Slow signaling connection."); return; }
    ws.send(JSON.stringify(value));
  };
  sockets.on("connection", (ws) => {
    const challenge = randomBytes(24).toString("base64url");
    let registeredRoom, windowStarted = Date.now(), messageCount = 0;
    ws.alive = true;
    ws.on("pong", () => { ws.alive = true; });
    send(ws, { type: "challenge", challenge, serviceEpoch, protocol: 1 });
    ws.on("message", (bytes, binary) => {
      try {
        if (Date.now() - windowStarted > 1000) { windowStarted = Date.now(); messageCount = 0; }
        if (++messageCount > 30 || binary) throw new Error("Invalid signaling traffic.");
        const message = JSON.parse(bytes.toString("utf8"));
        if (message.type === "register") {
          const payload = message.envelope?.payload;
          if (!payload || payload.kind !== "register" || !validId(payload.roomId) || payload.challenge !== challenge || payload.serviceEpoch !== serviceEpoch ||
              !Number.isSafeInteger(payload.serverEpoch) || payload.serverEpoch < 1 || typeof message.publicKey !== "string" || message.publicKey.length > 256 ||
              !verifyEnvelope(message.publicKey, message.envelope)) throw new Error("Registration authentication failed.");
          const owner = digest(Buffer.from(message.publicKey, "base64url")), existing = rooms.get(payload.roomId);
          if (existing && (existing.owner !== owner || existing.serverEpoch > payload.serverEpoch)) throw new Error("Room identity or epoch mismatch.");
          if (!existing && rooms.size >= maxRooms) throw new Error("Registration capacity reached.");
          if (existing?.socket && existing.socket !== ws) existing.socket.close(1000, "New authenticated registration.");
          rooms.set(payload.roomId, { owner, socket: ws, serverEpoch: payload.serverEpoch, expiresAt: Date.now() + 120_000 });
          registeredRoom = payload.roomId;
          send(ws, { type: "registered", roomId: payload.roomId, serviceEpoch });
        } else if (message.type === "offer") {
          if (registeredRoom || !validId(message.roomId) || !validId(message.peerId) || !validId(message.negotiationId) ||
              !validId(message.challenge) || !Number.isSafeInteger(message.expiresAt) || message.expiresAt < Date.now() || message.expiresAt > Date.now() + 60_000 ||
              !validSdp(message.sdp) || negotiations.size >= 256 || negotiations.has(message.negotiationId)) throw new Error("Invalid negotiation offer.");
          const room = rooms.get(message.roomId);
          if (room?.socket?.readyState !== WebSocket.OPEN) { send(ws, { type: "unavailable", negotiationId: message.negotiationId }); return; }
          const active = [...negotiations.values()].filter((entry) => entry.guest === ws || entry.host === room.socket).length;
          if (active >= (registeredRoom ? 16 : 8)) throw new Error("Negotiation capacity reached.");
          negotiations.set(message.negotiationId, { guest: ws, host: room.socket, roomId: message.roomId, expiresAt: message.expiresAt });
          send(room.socket, { type: "offer", roomId: message.roomId, peerId: message.peerId, negotiationId: message.negotiationId, challenge: message.challenge, expiresAt: message.expiresAt, sdp: message.sdp });
        } else if (message.type === "answer") {
          const payload = message.envelope?.payload, exchange = negotiations.get(payload?.negotiationId);
          if (!payload || !exchange || exchange.host !== ws || exchange.roomId !== registeredRoom || !validSdp(payload.sdp) || exchange.expiresAt < Date.now()) throw new Error("Invalid negotiation answer.");
          send(exchange.guest, { type: "answer", envelope: message.envelope });
          negotiations.delete(payload.negotiationId);
        } else if (message.type === "renew" && registeredRoom) {
          const room = rooms.get(registeredRoom);
          if (room?.socket === ws) room.expiresAt = Date.now() + 120_000;
        } else throw new Error("Unsupported signaling message.");
      } catch { ws.close(1008, "Signaling request rejected."); }
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      const room = rooms.get(registeredRoom);
      if (room?.socket === ws) { room.socket = undefined; room.expiresAt = Date.now() + 120_000; }
      for (const [id, entry] of negotiations) if (entry.guest === ws || entry.host === ws) negotiations.delete(id);
    });
  });
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of negotiations) if (entry.expiresAt < now) negotiations.delete(id);
    for (const [id, room] of rooms) if (room.expiresAt < now) { room.socket?.close(1008, "Registration expired."); rooms.delete(id); }
    for (const ws of sockets.clients) {
      if (!ws.alive) ws.terminate();
      else { ws.alive = false; ws.ping(); }
    }
  }, 15_000);
  cleanup.unref();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  return {
    port: server.address().port,
    protocol: 1,
    async close() {
      clearInterval(cleanup);
      for (const ws of sockets.clients) ws.terminate();
      await new Promise((resolve) => sockets.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

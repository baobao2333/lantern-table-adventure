import { createServer } from "node:https";
import { isIP } from "node:net";
import { X509Certificate, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import selfsigned from "selfsigned";
import WebSocket, { WebSocketServer } from "ws";
import { protectSecret, signEnvelope, verifyEnvelope } from "./identity.mjs";
import { certificatePin, parseInvitation } from "./invitation.mjs";
import { pinnedTlsOptions } from "./tls.mjs";
import { createFramedPeer, MAX_WIRE_BYTES, notifySafely } from "./framing.mjs";

const validHostname = (value) => typeof value === "string" && value.length <= 253 && (isIP(value) || /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value));

export async function generateTransportCertificate(hostname) {
  if (!validHostname(hostname)) throw new Error("Invalid advertised hostname or IP address.");
  const generated = await selfsigned.generate([{ name: "commonName", value: hostname }], {
    keyType: "ec", curve: "P-256", algorithm: "sha256",
    notBeforeDate: new Date(Date.now() - 60_000), notAfterDate: new Date(Date.now() + 90 * 24 * 60 * 60_000),
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [isIP(hostname) ? { type: 7, ip: hostname } : { type: 2, value: hostname }] },
    ],
  });
  return { key: generated.private, cert: generated.cert };
}

async function loadCertificate(hostname, directory) {
  if (!directory) return generateTransportCertificate(hostname);
  mkdirSync(directory, { recursive: true });
  const filename = join(directory, "room-tls.json");
  if (existsSync(filename)) {
    const saved = JSON.parse(readFileSync(filename, "utf8"));
    if (saved.hostname === hostname && saved.cert && Date.parse(new X509Certificate(saved.cert).validTo) > Date.now() + 24 * 60 * 60_000)
      return { cert: saved.cert, key: protectSecret(saved.encryptedPrivateKey, true) };
  }
  const tls = await generateTransportCertificate(hostname);
  writeFileSync(`${filename}.tmp`, JSON.stringify({ version: 1, hostname, cert: tls.cert, encryptedPrivateKey: protectSecret(tls.key) }), { mode: 0o600 });
  renameSync(`${filename}.tmp`, filename);
  return tls;
}

function socketPeer(socket, id) {
  const peer = createFramedPeer({ id, transport: "address", route: { transport: "wss" }, bufferedAmount: () => socket.bufferedAmount,
    write: (frame) => { if (socket.readyState !== WebSocket.OPEN) return false; socket.send(frame); return true; }, close: () => socket.terminate() });
  socket.on("message", (bytes, binary) => { if (binary) peer.close("Binary room messages are unsupported."); else peer.receive(bytes.toString("utf8")); });
  socket.on("close", () => peer.close("Room socket closed."));
  socket.on("error", () => peer.close("Room socket failed."));
  return peer;
}

export async function startAddressHost({ identity, roomId, serverEpoch, host = "127.0.0.1", port = 4174, advertisedHost = host, directory, onConnection }) {
  if (!identity?.privateKey || !/^[A-Za-z0-9_-]{16,96}$/.test(roomId) || !Number.isSafeInteger(serverEpoch) || serverEpoch < 1 || !validHostname(advertisedHost) || ["0.0.0.0", "::"].includes(advertisedHost)) throw new Error("A concrete advertised address and room identity are required.");
  const tls = await loadCertificate(advertisedHost, directory);
  const server = createServer({ ...tls, minVersion: "TLSv1.2", requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 }, (_request, response) => { response.writeHead(404); response.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_WIRE_BYTES, perMessageDeflate: false });
  const peers = new Set();
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== `/room/${roomId}` || request.headers.origin || sockets.clients.size >= 12) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws));
  });
  sockets.on("connection", (socket) => {
    const peer = socketPeer(socket, randomUUID()); peers.add(peer);
    peer.onClose(() => peers.delete(peer));
    notifySafely(onConnection, peer);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const advertised = isIP(advertisedHost) === 6 ? `[${advertisedHost}]` : advertisedHost;
  const url = `wss://${advertised}:${server.address().port}/room/${roomId}`, tlsPin = certificatePin(tls.cert);
  const payload = { kind: "address", roomId, serverEpoch, url, tlsPin, expiresAt: Date.parse(new X509Certificate(tls.cert).validTo) };
  let closed = false;
  return {
    invitationFields: { roomId, hostPublicKey: identity.publicKey, hostFingerprint: identity.fingerprint,
      address: { url, tlsPin, certificate: tls.cert, binding: signEnvelope(identity, payload) } },
    get status() { return closed ? "closed" : "ready"; },
    async close() {
      if (closed) return; closed = true;
      for (const peer of peers) peer.close("Host listener closed.");
      for (const socket of sockets.clients) socket.terminate();
      await new Promise((resolve) => sockets.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function connectAddress({ invitation, onState = () => {}, abortSignal }) {
  if (abortSignal?.aborted) throw new Error("Connection cancelled.");
  invitation = parseInvitation(invitation, { allowExpired: true });
  const address = invitation.address, binding = address?.binding?.payload;
  if (!address || !verifyEnvelope(invitation.hostPublicKey, address.binding) || binding.kind !== "address" || binding.roomId !== invitation.roomId || binding.url !== address.url ||
      binding.tlsPin !== address.tlsPin || !Number.isSafeInteger(binding.serverEpoch) || binding.serverEpoch < 1 || !Number.isSafeInteger(binding.expiresAt) || binding.expiresAt < Date.now())
    throw new Error("Advanced address is not bound to the trusted host identity.");
  notifySafely(onState, "connecting");
  const socket = new WebSocket(address.url, { ...pinnedTlsOptions(address), maxPayload: MAX_WIRE_BYTES, perMessageDeflate: false, followRedirects: false, handshakeTimeout: 8000 });
  const peer = socketPeer(socket, randomUUID());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => { if (settled) return; settled = true; abortSignal?.removeEventListener("abort", abort); peer.close(); reject(error); };
    const abort = () => finish(new Error("Connection cancelled."));
    abortSignal?.addEventListener("abort", abort, { once: true });
    socket.once("error", () => finish(new Error("Pinned room TLS connection failed.")));
    socket.once("close", () => finish(new Error("Room connection closed before joining.")));
    socket.once("open", () => { if (settled) return; settled = true; abortSignal?.removeEventListener("abort", abort); notifySafely(onState, "connected"); resolve(peer); });
  });
}

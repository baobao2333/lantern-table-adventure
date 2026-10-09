import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import rtc from "node-datachannel";
import WebSocket from "ws";
import { createIdentity, loadHostIdentity, signEnvelope, verifyEnvelope } from "../local/network/identity.mjs";
import { encodeInvitation, parseInvitation, validateSignal } from "../local/network/invitation.mjs";
import { createFramedPeer, MAX_APPLICATION_BYTES } from "../local/network/framing.mjs";
import { assertDirectSdp, assertDirectPair } from "../local/network/p2p.mjs";
import { startHostNetwork, connectRoom, createRoomConnector, startAddressHost, generateTransportCertificate } from "../local/network/index.mjs";
import { certificatePin } from "../local/network/invitation.mjs";
import { pinnedTlsOptions } from "../local/network/tls.mjs";
import { startSignalServer } from "../signal/server.mjs";

after(() => rtc.cleanup());
const random = () => randomBytes(24).toString("base64url");
const invitation = (fields) => ({ version: 1, ...fields, joinToken: random(), expiresAt: Date.now() + 60_000 });
async function waitFor(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error("Condition timed out."); await delay(20); }
}
function exchange(peer, payload, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Echo timed out.")); }, timeout);
    const unsubscribe = peer.onMessage((message) => { clearTimeout(timer); unsubscribe(); resolve(message); });
    peer.send(payload);
  });
}

test("host identity signatures and invitation validation reject tampering and TURN", () => {
  const identity = createIdentity(), envelope = signEnvelope(identity, { room: random(), epoch: 7 });
  assert.equal(verifyEnvelope(identity.publicKey, envelope), true);
  assert.equal(verifyEnvelope(createIdentity().publicKey, envelope), false);
  assert.equal(verifyEnvelope(identity.publicKey, { ...envelope, payload: { ...envelope.payload, epoch: 8 } }), false);
  const fields = { roomId: random(), hostPublicKey: identity.publicKey, hostFingerprint: identity.fingerprint, signal: { url: "ws://127.0.0.1:8443", stunServers: ["stun:127.0.0.1:3478"] } };
  const decoded = parseInvitation(encodeInvitation(invitation(fields)));
  assert.equal(decoded.signal.url, "ws://127.0.0.1:8443/signal");
  assert.throws(() => validateSignal({ url: "ws://203.0.113.1/signal" }), /WSS/);
  assert.throws(() => validateSignal({ url: "wss://example.com/signal" }), /identity/);
  assert.throws(() => validateSignal({ url: "ws://localhost", stunServers: ["turn:example.com"] }), /TURN/);
  assert.throws(() => validateSignal({ url: "ws://localhost", stunServers: ["stun:example.com:65536"] }), /STUN/);
  assert.throws(() => parseInvitation({ ...invitation(fields), expiresAt: Date.now() - 1 }), /expired/);
  assert.throws(() => parseInvitation({ ...invitation(fields), hostFingerprint: random() }), /identity/);
  assert.throws(() => assertDirectSdp("v=0\r\na=fingerprint:sha-256 AA:BB\r\na=candidate:1 1 UDP 1 1.2.3.4 9 typ relay\r\n"), /relay/);
  assert.throws(() => assertDirectPair({ local: { type: "host" }, remote: { type: "relay" } }), /direct/);
});

test("persistent host private key uses current-user DPAPI", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "lantern-identity-"));
  try {
    const first = loadHostIdentity(directory), second = loadHostIdentity(directory);
    assert.equal(first.publicKey, second.publicKey);
    const saved = readFileSync(join(directory, "host-identity.json"), "utf8");
    assert.ok(!saved.includes("PRIVATE KEY"));
    assert.equal(verifyEnvelope(first.publicKey, signEnvelope(second, { test: "persistent" })), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("bounded framing reassembles large messages and contains application callback errors", async () => {
  let left, right;
  left = createFramedPeer({ id: "left", write: (frame) => { right.receive(frame); return true; }, close: () => {} });
  right = createFramedPeer({ id: "right", write: (frame) => { left.receive(frame); return true; }, close: () => {} });
  try {
    right.onMessage(() => { throw new Error("Application callback failed."); });
    const payload = { text: "彩色骰子".repeat(40_000), type: "snapshot" };
    right.onMessage((message) => right.send(message));
    assert.deepEqual(await exchange(left, payload), payload);
    assert.equal(left.closed, false); assert.equal(right.closed, false);
    assert.throws(() => left.send({ text: "x".repeat(MAX_APPLICATION_BYTES) }), /limit/);
    assert.equal(left.closed, true);
  } finally { left.close(); right.close(); }
});

test("malformed and duplicate fragments close the transport once", () => {
  let closed = 0;
  const peer = createFramedPeer({ id: "bad", write: () => true, close: () => closed++ });
  const frame = JSON.stringify({ v: 1, id: "00000000-0000-0000-0000-000000000000", total: 2, index: 0, data: Buffer.from("{").toString("base64") });
  peer.receive(frame); peer.receive(frame); peer.close();
  assert.equal(peer.closed, true); assert.equal(closed, 1);
});

test("priority messages preserve FIFO and can interrupt an unfinished snapshot", async () => {
  let sender, receiver;
  const received = [];
  receiver = createFramedPeer({ id: "receiver", write: () => true, close: () => {} });
  receiver.onMessage((message) => received.push(message.type === "request" ? message.order : message.type));
  let frames = 0;
  sender = createFramedPeer({ id: "sender", close: () => {}, write(frame) {
    receiver.receive(frame);
    if (++frames === 8) { sender.send({ type: "request", order: 1 }); sender.send({ type: "request", order: 2 }); }
    return true;
  } });
  try { sender.send({ type: "snapshot", text: "x".repeat(256_000) }); await waitFor(() => received.length === 3); assert.deepEqual(received, [1, 2, "snapshot"]); }
  finally { sender.close(); receiver.close(); }
});

test("native multi-peer P2P survives signaling restart and reconnects with a new transport", { timeout: 20_000 }, async () => {
  let service = await startSignalServer();
  const port = service.port, hostPeers = new Set(), states = [];
  const host = await startHostNetwork({ identity: createIdentity(), roomId: random(), serverEpoch: 1, signal: { url: `ws://127.0.0.1:${port}`, stunServers: [] },
    onState: (state) => states.push(state), onConnection(peer) { hostPeers.add(peer); peer.onClose(() => hostPeers.delete(peer)); peer.onMessage((message) => peer.send(message)); } });
  const invite = invitation(host.invitationFields), guests = [];
  let connector;
  try {
    guests.push(...await Promise.all(Array.from({ length: 3 }, () => connectRoom({ invitation: invite }))));
    for (const [index, peer] of guests.entries()) {
      assert.equal(peer.transport, "p2p"); assert.notEqual(peer.route.remoteType, "relay");
      assert.deepEqual(await exchange(peer, { index, text: "x".repeat(256_000) }), { index, text: "x".repeat(256_000) });
    }
    await service.close();
    assert.deepEqual(await exchange(guests[0], { offlineSignal: true }), { offlineSignal: true });
    service = await startSignalServer({ port });
    await waitFor(() => states.filter((state) => state === "ready").length >= 2, 6000);
    const connected = [];
    connector = createRoomConnector({ invitation: invite, onPeer: (peer) => connected.push(peer) });
    await waitFor(() => connected.length === 1);
    assert.deepEqual(await exchange(connected[0], { before: true }), { before: true });
    connected[0].close("Simulated connection loss.");
    await waitFor(() => connected.length === 2, 6000);
    assert.notEqual(connected[0].id, connected[1].id);
    assert.deepEqual(await exchange(connected[1], { after: true }), { after: true });
    connector.reconnect(); connector.close();
    await delay(100);
    assert.equal(connector.status, "closed"); assert.equal(connector.peer, undefined);
  } finally { connector?.close(); guests.forEach((peer) => peer.close()); host.close(); await service.close(); }
});

test("advanced WSS verifies the pinned certificate and persistent host binding", { timeout: 10_000 }, async () => {
  const identity = createIdentity();
  const host = await startAddressHost({ identity, roomId: random(), serverEpoch: 1, port: 0, onConnection(peer) { peer.onMessage((message) => peer.send(message)); } });
  let peer;
  try {
    const invite = invitation(host.invitationFields);
    peer = await connectRoom({ invitation: invite, mode: "address" });
    assert.equal(peer.transport, "address");
    assert.deepEqual(await exchange(peer, { tls: true }), { tls: true });
    const changed = structuredClone(invite); changed.address.binding.payload.serverEpoch++;
    await assert.rejects(connectRoom({ invitation: changed }), /trusted host/);
    const wrongPin = structuredClone(invite); wrongPin.address.tlsPin = randomBytes(32).toString("base64url");
    await assert.rejects(connectRoom({ invitation: wrongPin }), /TLS identity/);
  } finally { peer?.close(); await host.close(); }
});

test("TLS signaling works with a pinned IP certificate and rejects the wrong pin before WebSocket", { timeout: 10_000 }, async () => {
  const tls = await generateTransportCertificate("127.0.0.1"), service = await startSignalServer({ tls });
  const config = { url: `wss://127.0.0.1:${service.port}/signal`, certificate: tls.cert, tlsPin: certificatePin(tls.cert), stunServers: [] };
  let host, peer;
  try {
    const rejected = new WebSocket(config.url, { ...pinnedTlsOptions({ ...config, tlsPin: randomBytes(32).toString("base64url") }), handshakeTimeout: 2000 });
    await new Promise((resolve, reject) => { rejected.once("open", () => { rejected.terminate(); reject(new Error("Untrusted TLS pin was accepted.")); }); rejected.once("error", resolve); });
    host = await startHostNetwork({ identity: createIdentity(), roomId: random(), serverEpoch: 1, signal: config, onConnection(opened) { opened.onMessage((message) => opened.send(message)); } });
    peer = await connectRoom({ invitation: invitation(host.invitationFields) });
    assert.deepEqual(await exchange(peer, { pinnedSignal: true }), { pinnedSignal: true });
  } finally { peer?.close(); host?.close(); await service.close(); }
});

test("failed signaling cancels unfinished STUN gathering and an aborted attempt cannot reopen", { timeout: 3000 }, async () => {
  const service = await startSignalServer(), port = service.port;
  await service.close();
  const identity = createIdentity();
  const invite = invitation({ roomId: random(), hostPublicKey: identity.publicKey, hostFingerprint: identity.fingerprint,
    signal: { url: `ws://127.0.0.1:${port}`, stunServers: ["stun:192.0.2.1:3478"] } });
  const start = Date.now();
  await assert.rejects(connectRoom({ invitation: invite }));
  assert.ok(Date.now() - start < 2000);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(connectRoom({ invitation: invite, abortSignal: controller.signal }), /cancelled/);
});

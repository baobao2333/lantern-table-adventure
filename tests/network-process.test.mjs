import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { randomBytes } from "node:crypto";
import rtc from "node-datachannel";
import { startSignalServer } from "../signal/server.mjs";
import { createIdentity, digest, signEnvelope } from "../local/network/identity.mjs";
import { connectRoom } from "../local/network/index.mjs";

const indexUrl = new URL("../local/network/index.mjs", import.meta.url).href;
const rtcUrl = import.meta.resolve("node-datachannel");
const workerSource = `
  import { createIdentity, startHostNetwork, connectRoom } from ${JSON.stringify(indexUrl)};
  import rtc from ${JSON.stringify(rtcUrl)};
  let host, peer;
  process.on("message", (message) => run(message).catch(error => process.send({type:"failure",error:error.message})));
  async function run(message) {
    if (message.type === "host") {
      host = await startHostNetwork({...message.options, identity:createIdentity(), onConnection(opened){opened.onMessage(value=>opened.send(value));}});
      process.send({type:"host-ready",fields:host.invitationFields});
    } else if (message.type === "guest") {
      peer = await connectRoom({invitation:message.invitation});
      peer.onMessage(value=>process.send({type:"echo",value}));
      process.send({type:"guest-ready",route:peer.route});
    } else if (message.type === "echo") peer.send(message.value);
    else if (message.type === "stop") {peer?.close();host?.close();rtc.cleanup();process.send({type:"stopped"});process.disconnect();}
  }
`;

function worker() {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", workerSource], { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const backlog = [], waiters = [];
  let diagnostics = "";
  child.stderr.on("data", (data) => { diagnostics += data.toString(); });
  child.stdout.resume();
  child.on("message", (message) => {
    const index = waiters.findIndex((entry) => entry.type === message.type || message.type === "failure");
    if (index < 0) backlog.push(message);
    else { const entry = waiters.splice(index, 1)[0]; clearTimeout(entry.timer); message.type === "failure" ? entry.reject(new Error(message.error)) : entry.resolve(message); }
  });
  const next = (type) => new Promise((resolve, reject) => {
    const index = backlog.findIndex((message) => message.type === type || message.type === "failure");
    if (index >= 0) { const message = backlog.splice(index, 1)[0]; message.type === "failure" ? reject(new Error(message.error)) : resolve(message); return; }
    const entry = { type, resolve, reject, timer: setTimeout(() => reject(new Error(`Worker ${type} timed out: ${diagnostics}`)), 8000) };
    waiters.push(entry);
  });
  return { child, next, send: (value) => child.send(value), async stop() {
    for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error("Worker stopped.")); }
    waiters.length = 0;
    if (child.exitCode !== null || child.killed) return;
    const exited = once(child, "exit");
    child.send({ type: "stop" });
    const kill = setTimeout(() => child.kill(), 3000);
    await exited; clearTimeout(kill);
  } };
}

test("host and guest use real native DataChannels in separate Node processes", { timeout: 15_000 }, async () => {
  const signal = await startSignalServer(), host = worker(), guest = worker();
  try {
    host.send({ type: "host", options: { roomId: randomBytes(24).toString("base64url"), serverEpoch: 1, signal: { url: `ws://127.0.0.1:${signal.port}`, stunServers: [] } } });
    const ready = await host.next("host-ready");
    guest.send({ type: "guest", invitation: { version: 1, ...ready.fields, joinToken: randomBytes(24).toString("base64url"), expiresAt: Date.now() + 60_000 } });
    const connected = await guest.next("guest-ready");
    assert.equal(connected.route.transport, "UDP"); assert.notEqual(connected.route.remoteType, "relay");
    const payload = { processIsolation: true, text: "x".repeat(256_000) };
    guest.send({ type: "echo", value: payload });
    assert.deepEqual((await guest.next("echo")).value, payload);
    await signal.close();
    guest.send({ type: "echo", value: { signalingStopped: true } });
    assert.deepEqual((await guest.next("echo")).value, { signalingStopped: true });
  } finally { await Promise.all([host.stop(), guest.stop()]); await signal.close(); }
});

test("an untrusted signaling service cannot substitute a different host answer", { timeout: 10_000 }, async () => {
  const trusted = createIdentity(), attacker = createIdentity();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 128_000 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (bytes) => {
      const offer = JSON.parse(bytes.toString());
      if (offer.type !== "offer") return;
      const payload = { kind: "answer", roomId: offer.roomId, publicKey: trusted.publicKey, serverEpoch: 1, peerId: offer.peerId, negotiationId: offer.negotiationId,
        challenge: offer.challenge, offerDigest: digest(offer.sdp), expiresAt: Date.now() + 20_000, sdp: offer.sdp };
      socket.send(JSON.stringify({ type: "answer", envelope: signEnvelope(attacker, payload) }));
    });
  });
  try {
    await assert.rejects(connectRoom({ invitation: { version: 1, roomId: randomBytes(24).toString("base64url"), hostPublicKey: trusted.publicKey, hostFingerprint: trusted.fingerprint,
      joinToken: randomBytes(24).toString("base64url"), expiresAt: Date.now() + 60_000, signal: { url: `ws://127.0.0.1:${server.address().port}`, stunServers: [] } } }), /identity/);
  } finally { for (const socket of server.clients) socket.terminate(); await new Promise((resolve) => server.close(resolve)); rtc.cleanup(); }
});

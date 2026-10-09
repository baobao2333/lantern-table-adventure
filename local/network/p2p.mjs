import { randomBytes, randomUUID } from "node:crypto";
import rtc from "node-datachannel";
import WebSocket from "ws";
import { digest, signEnvelope, verifyEnvelope } from "./identity.mjs";
import { parseInvitation, validateSignal } from "./invitation.mjs";
import { pinnedTlsOptions } from "./tls.mjs";
import { createFramedPeer, MAX_WIRE_BYTES, notifySafely } from "./framing.mjs";

rtc.initLogger("Error", () => {});
const NEGOTIATION_MS = 25_000;
const RETRY_MS = [1000, 2000, 4000, 8000, 15_000];

export function assertDirectSdp(sdp) {
  if (typeof sdp !== "string" || sdp.length > 96_000 || !sdp.startsWith("v=0") || !/^a=fingerprint:sha-256 [A-F0-9:]+\r?$/im.test(sdp) ||
      /(?:^|\r?\n)a=candidate:[^\r\n]*\btyp\s+relay\b/i.test(sdp)) throw new Error("Invalid SDP or relay candidate rejected.");
  return sdp;
}

export function assertDirectPair(pair) {
  if (!pair || !["host", "srflx", "prflx"].includes(pair.local?.type) || !["host", "srflx", "prflx"].includes(pair.remote?.type)) throw new Error("No verified direct ICE candidate pair.");
  return { localType: pair.local.type, remoteType: pair.remote.type, transport: pair.local.transportType };
}

function openSignal(config) {
  const socket = new WebSocket(config.url, { ...pinnedTlsOptions(config), maxPayload: 128_000, perMessageDeflate: false, followRedirects: false, handshakeTimeout: 8000 });
  const ready = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("Signaling connection closed.")));
  });
  socket.on("error", () => {});
  return { socket, ready };
}

function writeSignal(socket, message) {
  if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256_000) throw new Error("Signaling unavailable or congested.");
  socket.send(JSON.stringify(message));
}

function makeConnection(id, signal) {
  return new rtc.PeerConnection(id, { iceServers: signal.stunServers, enableIceTcp: false, maxMessageSize: MAX_WIRE_BYTES, disableFingerprintVerification: false });
}

function gatherDescription(pc) {
  let cancel;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, sdp) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(sdp); };
    cancel = () => finish(new Error("ICE gathering cancelled."));
    const timer = setTimeout(() => finish(new Error("ICE gathering timed out.")), 10_000);
    const complete = () => {
      if (settled) return;
      try {
        const description = pc.localDescription();
        if (!description) return;
        assertDirectSdp(description.sdp);
        finish(undefined, description.sdp);
      } catch (error) { finish(error); }
    };
    try {
      pc.onGatheringStateChange((state) => { if (state === "complete") complete(); });
      if (pc.gatheringState() === "complete") complete();
    } catch (error) { finish(error); }
  });
  promise.catch(() => {});
  return Object.assign(promise, { cancel: () => cancel() });
}

function attachChannel(pc, channel, id, onOpen, onClose) {
  let peer, closed = false, notified = false;
  const notifyClosed = (reason) => { if (!notified) { notified = true; notifySafely(onClose, reason); } };
  const finish = (reason) => {
    if (closed) return;
    closed = true;
    clearInterval(check);
    if (peer) peer.close(reason); else { try { pc.close(); } catch {} }
    notifyClosed(reason);
  };
  const check = setInterval(() => {
    if (closed || !peer) return;
    try { assertDirectPair(pc.getSelectedCandidatePair()); } catch { finish("Non-direct connection rejected."); }
  }, 1000);
  check.unref();
  channel.onMessage((message) => { if (peer && !closed) peer.receive(typeof message === "string" ? message : Buffer.from(message).toString("utf8")); });
  channel.onClosed(() => finish("Data channel closed."));
  channel.onError(() => finish("Data channel failed."));
  channel.onOpen(() => {
    if (closed) return;
    try {
      if (channel.getLabel() !== "lantern-room-v1") throw new Error("Unexpected data channel.");
      const route = assertDirectPair(pc.getSelectedCandidatePair());
      peer = createFramedPeer({ id, route, write: (frame) => channel.sendMessage(frame), bufferedAmount: () => channel.bufferedAmount(), maxFrameBytes: Math.min(MAX_WIRE_BYTES, channel.maxMessageSize()), close: () => { clearInterval(check); pc.close(); } });
      peer.onClose(() => { closed = true; clearInterval(check); notifyClosed("Data channel closed."); });
      onOpen(peer);
    } catch (error) { finish(error.message); }
  });
  return { close: finish };
}

export async function startHostNetwork({ identity, roomId, serverEpoch, signal, onConnection, onState = () => {} }) {
  signal = validateSignal(signal);
  if (!identity?.privateKey || !/^[A-Za-z0-9_-]{16,96}$/.test(roomId) || !Number.isSafeInteger(serverEpoch) || serverEpoch < 1) throw new Error("Invalid host registration.");
  let closed = false, generation = 0, socket, retry, renewal, failures = 0, state = "connecting";
  const connections = new Map();
  let resolveStarted, rejectStarted;
  const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  const timeout = setTimeout(() => rejectStarted(new Error("Signaling registration timed out.")), 12_000);

  async function acceptOffer(message) {
    if (connections.size >= 12 || message.roomId !== roomId || ![message.peerId, message.negotiationId, message.challenge].every((value) => typeof value === "string" && /^[A-Za-z0-9_-]{16,96}$/.test(value)) ||
        !Number.isSafeInteger(message.expiresAt) || message.expiresAt < Date.now() || message.expiresAt > Date.now() + 60_000 || connections.has(message.negotiationId)) return;
    assertDirectSdp(message.sdp);
    const pc = makeConnection(message.peerId, signal);
    const exchange = { pc, timer: undefined, channel: undefined };
    connections.set(message.negotiationId, exchange);
    const close = () => { if (!connections.delete(message.negotiationId)) return; clearTimeout(exchange.timer); exchange.gathered?.cancel(); try { pc.close(); } catch {} };
    exchange.timer = setTimeout(close, NEGOTIATION_MS);
    pc.onStateChange((status) => { if (["failed", "closed"].includes(status)) close(); });
    pc.onDataChannel((channel) => {
      if (exchange.channel) { channel.close(); return; }
      exchange.channel = attachChannel(pc, channel, message.peerId, (peer) => {
        clearTimeout(exchange.timer);
        peer.onClose(close);
        notifySafely(onConnection, peer);
      }, close);
    });
    try {
      const gathered = exchange.gathered = gatherDescription(pc);
      pc.setRemoteDescription(message.sdp, "offer");
      const sdp = await gathered;
      if (closed || !connections.has(message.negotiationId)) return;
      const payload = { kind: "answer", roomId, publicKey: identity.publicKey, serverEpoch, peerId: message.peerId, negotiationId: message.negotiationId,
        challenge: message.challenge, offerDigest: digest(message.sdp), expiresAt: Math.min(message.expiresAt, Date.now() + NEGOTIATION_MS), sdp };
      writeSignal(socket, { type: "answer", envelope: signEnvelope(identity, payload) });
    } catch { close(); }
  }

  function register() {
    if (closed) return;
    const current = ++generation;
    state = "connecting"; notifySafely(onState, state);
    const opened = openSignal(signal); socket = opened.socket;
    opened.ready.catch(() => {});
    socket.on("message", (bytes) => {
      if (closed || current !== generation) return;
      try {
        const message = JSON.parse(bytes.toString("utf8"));
        if (message.type === "challenge" && message.protocol === 1) {
          writeSignal(socket, { type: "register", publicKey: identity.publicKey, envelope: signEnvelope(identity, { kind: "register", roomId, serverEpoch, challenge: message.challenge, serviceEpoch: message.serviceEpoch }) });
        } else if (message.type === "registered" && message.roomId === roomId) {
          failures = 0; state = "ready"; notifySafely(onState, state); clearTimeout(timeout); resolveStarted();
          clearInterval(renewal); renewal = setInterval(() => { try { writeSignal(socket, { type: "renew" }); } catch {} }, 30_000); renewal.unref();
        } else if (message.type === "offer") acceptOffer(message).catch(() => {});
      } catch { socket.close(1008, "Invalid signaling message."); }
    });
    socket.on("close", () => {
      if (closed || current !== generation) return;
      clearInterval(renewal); state = "signal-unavailable"; notifySafely(onState, state);
      retry = setTimeout(register, RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)] + Math.floor(Math.random() * 250)); retry.unref();
    });
  }
  const result = {
    invitationFields: { hostPublicKey: identity.publicKey, hostFingerprint: identity.fingerprint, roomId, signal },
    get status() { return state; },
    close() { if (closed) return; closed = true; generation++; clearTimeout(timeout); clearTimeout(retry); clearInterval(renewal); socket?.terminate(); for (const exchange of connections.values()) { clearTimeout(exchange.timer); exchange.gathered?.cancel(); exchange.pc.close(); } connections.clear(); state = "closed"; },
  };
  register();
  try { await started; return result; } catch (error) { result.close(); throw error; }
}

export async function connectP2p({ invitation, onState = () => {}, abortSignal }) {
  if (abortSignal?.aborted) throw new Error("Connection cancelled.");
  invitation = parseInvitation(invitation, { allowExpired: true });
  const signal = validateSignal(invitation.signal), peerId = randomUUID(), negotiationId = randomUUID(), challenge = randomBytes(24).toString("base64url");
  const pc = makeConnection(peerId, signal);
  const { socket, ready } = openSignal(signal);
  let accepted = false, peer, done = false, gathered;
  let resolveConnection, rejectConnection;
  const connected = new Promise((resolve, reject) => { resolveConnection = resolve; rejectConnection = reject; });
  connected.catch(() => {});
  const finish = (error) => { if (done) return; done = true; clearTimeout(timer); gathered?.cancel(); socket.terminate(); pc.close(); rejectConnection(error instanceof Error ? error : new Error(error)); };
  const timer = setTimeout(() => finish("Direct connection timed out. Try advanced IP or LAN."), NEGOTIATION_MS);
  const abort = () => { if (peer) peer.close("Connection cancelled."); else finish("Connection cancelled."); };
  abortSignal?.addEventListener("abort", abort, { once: true });
  connected.finally(() => abortSignal?.removeEventListener("abort", abort)).catch(() => {});
  let offerSdp;
  socket.on("message", (bytes) => {
    if (done) return;
    try {
      const message = JSON.parse(bytes.toString("utf8"));
      if (message.type === "unavailable") { finish("Host is not registered with the signaling service."); return; }
      if (message.type !== "answer") return;
      const payload = message.envelope?.payload;
      if (!verifyEnvelope(invitation.hostPublicKey, message.envelope) || payload.kind !== "answer" || payload.publicKey !== invitation.hostPublicKey || payload.roomId !== invitation.roomId ||
          payload.peerId !== peerId || payload.negotiationId !== negotiationId || payload.challenge !== challenge || payload.offerDigest !== digest(offerSdp) ||
          !Number.isSafeInteger(payload.serverEpoch) || payload.serverEpoch < 1 || payload.expiresAt < Date.now() || payload.expiresAt > Date.now() + NEGOTIATION_MS + 1000)
        throw new Error("Host identity or negotiation binding mismatch.");
      assertDirectSdp(payload.sdp);
      accepted = true;
      pc.setRemoteDescription(payload.sdp, "answer");
    } catch (error) { finish(error); }
  });
  socket.on("close", () => { if (!accepted && !done) finish("Signaling service disconnected."); });
  pc.onStateChange((state) => {
    if (!done) notifySafely(onState, state);
    if (["failed", "closed"].includes(state)) { if (!done) finish("Direct connection failed."); else peer?.close("Direct connection failed."); }
  });
  const channel = pc.createDataChannel("lantern-room-v1", { unordered: false });
  attachChannel(pc, channel, peerId, (opened) => {
    if (!accepted || done) { opened.close("Host authentication is incomplete."); return; }
    done = true; peer = opened; clearTimeout(timer); socket.close(); notifySafely(onState, "connected"); resolveConnection(opened);
  }, (reason) => { if (!done) finish(reason); });
  try {
    notifySafely(onState, "gathering");
    if (done) return connected;
    gathered = gatherDescription(pc);
    await ready;
    offerSdp = await gathered;
    writeSignal(socket, { type: "offer", roomId: invitation.roomId, peerId, negotiationId, challenge, expiresAt: Date.now() + NEGOTIATION_MS, sdp: offerSdp });
  } catch (error) { finish(error); }
  return connected;
}

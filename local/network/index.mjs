export { createIdentity, loadHostIdentity } from "./identity.mjs";
export { encodeInvitation, parseInvitation, certificatePin, validateSignal } from "./invitation.mjs";
export { startHostNetwork } from "./p2p.mjs";
export { startAddressHost, generateTransportCertificate } from "./address.mjs";
import { connectP2p } from "./p2p.mjs";
import { connectAddress } from "./address.mjs";
import { parseInvitation } from "./invitation.mjs";
import { notifySafely } from "./framing.mjs";

export async function connectRoom({ invitation, mode = "auto", onState, abortSignal }) {
  invitation = parseInvitation(invitation, { allowExpired: true });
  if (!["auto", "p2p", "address"].includes(mode)) throw new Error("Unknown connection mode.");
  if (mode !== "address" && invitation.signal) {
    try { return await connectP2p({ invitation, onState, abortSignal }); }
    catch (error) { if (mode === "p2p" || !invitation.address || abortSignal?.aborted) throw error; }
  }
  if (mode !== "p2p" && invitation.address) return connectAddress({ invitation, onState, abortSignal });
  throw new Error("Invitation has no route for the selected mode.");
}

export function createRoomConnector({ invitation, mode = "auto", onPeer, onState }) {
  invitation = parseInvitation(invitation, { allowExpired: true });
  let closed = false, generation = 0, peer, timer, controller, attempt = 0, status = "connecting";
  const update = (state, detail) => { status = state; notifySafely(onState, state, detail); };
  const schedule = (error) => {
    if (closed) return;
    const delayMs = [1000, 2000, 4000, 8000, 15_000][Math.min(attempt, 4)] + Math.floor(Math.random() * 250);
    timer = setTimeout(connect, delayMs); timer.unref?.();
    update("retrying", { attempt: ++attempt, delayMs, error: error?.message || String(error) });
  };
  async function connect() {
    if (closed) return;
    const current = ++generation;
    controller = new AbortController();
    update("connecting");
    try {
      const opened = await connectRoom({ invitation, mode, abortSignal: controller.signal, onState: (state) => { if (!closed && current === generation) update(state); } });
      if (closed || current !== generation) { opened.close("Stale connection attempt."); return; }
      peer = opened; attempt = 0; update("connected");
      opened.onClose((reason) => { if (!closed && current === generation) { peer = undefined; schedule(new Error(reason)); } });
      notifySafely(onPeer, opened);
    } catch (error) { if (!closed && current === generation) schedule(error); }
  }
  const connector = {
    get peer() { return peer; }, get status() { return status; },
    reconnect() { if (closed) return; generation++; clearTimeout(timer); controller?.abort(); const old = peer; peer = undefined; old?.close("Reconnect requested."); attempt = 0; connect(); },
    close() { if (closed) return; closed = true; generation++; clearTimeout(timer); controller?.abort(); peer?.close("Connector closed."); peer = undefined; update("closed"); },
  };
  queueMicrotask(connect);
  return connector;
}

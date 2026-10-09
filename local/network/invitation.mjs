import { createPublicKey, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { digest } from "./identity.mjs";

export const NETWORK_PROTOCOL = 1;
export const INVITATION_PREFIX = "lantern://join/";
export const MAX_INVITATION_BYTES = 24_000;
export const isLoopback = (hostname) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);

function validStunAddress(server) {
  if (typeof server !== "string" || server.length > 255) return false;
  const match = /^stun:(?:\[([A-Fa-f0-9:.]+)\]|([A-Za-z0-9.-]+))(?::([0-9]{1,5}))?$/.exec(server);
  return Boolean(match && (!match[1] || isIP(match[1]) === 6) && (!match[3] || (Number(match[3]) > 0 && Number(match[3]) <= 65535)));
}

export function certificatePin(pem) {
  return digest(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" }));
}

export function validateSignal(input) {
  if (!input || typeof input.url !== "string") throw new Error("A signaling service is required.");
  const url = new URL(input.url);
  if (!["wss:", "ws:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      (url.protocol === "ws:" && !isLoopback(url.hostname)) || !["", "/", "/signal"].includes(url.pathname))
    throw new Error("Signaling requires WSS, or local loopback WS.");
  const tlsPin = input.tlsPin || "";
  const certificate = input.certificate || "";
  if (url.protocol === "wss:" && !/^[A-Za-z0-9_-]{43}$/.test(tlsPin)) throw new Error("The signaling service identity is missing.");
  if (certificate && (certificate.length > 12_000 || certificatePin(certificate) !== tlsPin)) throw new Error("The signaling certificate does not match its identity.");
  url.pathname = "/signal";
  const stunServers = input.stunServers || [];
  if (!Array.isArray(stunServers) || stunServers.length > 4 || stunServers.some((server) => !validStunAddress(server)))
    throw new Error("Only bounded STUN addresses are supported; TURN is disabled.");
  return { protocol: NETWORK_PROTOCOL, url: url.href, tlsPin, certificate, stunServers: [...stunServers] };
}

export function validateAddress(input) {
  if (!input || typeof input.url !== "string") throw new Error("Invalid advanced room address.");
  const url = new URL(input.url);
  if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash || !/^\/room\/[A-Za-z0-9_-]{16,96}$/.test(url.pathname)) throw new Error("Advanced room addresses require WSS.");
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.tlsPin || "") || typeof input.certificate !== "string" || input.certificate.length > 12_000 || certificatePin(input.certificate) !== input.tlsPin) throw new Error("Invalid room TLS identity.");
  return { url: url.href, tlsPin: input.tlsPin, certificate: input.certificate, binding: input.binding };
}

export function parseInvitation(value, { allowExpired = false } = {}) {
  let raw;
  if (typeof value === "string") {
    if (value.length > MAX_INVITATION_BYTES * 2) throw new Error("Invitation is too large.");
    const encoded = value.startsWith(INVITATION_PREFIX) ? value.slice(INVITATION_PREFIX.length) : value.trim();
    raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } else raw = value;
  if (!raw || raw.version !== NETWORK_PROTOCOL || typeof raw.roomId !== "string" || !/^[A-Za-z0-9_-]{16,96}$/.test(raw.roomId) ||
      typeof raw.joinToken !== "string" || !/^[A-Za-z0-9_-]{24,160}$/.test(raw.joinToken) || !Number.isSafeInteger(raw.expiresAt) ||
      (!allowExpired && raw.expiresAt < Date.now()) || raw.expiresAt > Date.now() + 24 * 60 * 60_000)
    throw new Error("Invitation is invalid or expired.");
  if (typeof raw.hostPublicKey !== "string" || raw.hostPublicKey.length > 256) throw new Error("Invalid host public key.");
  const key = createPublicKey({ key: Buffer.from(raw.hostPublicKey, "base64url"), type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "ed25519" || digest(Buffer.from(raw.hostPublicKey, "base64url")) !== raw.hostFingerprint) throw new Error("Host identity mismatch.");
  const signal = raw.signal ? validateSignal(raw.signal) : undefined;
  const address = raw.address ? validateAddress(raw.address) : undefined;
  if (!signal && !address) throw new Error("Invitation has no connection route.");
  const result = { version: NETWORK_PROTOCOL, roomId: raw.roomId, hostPublicKey: raw.hostPublicKey, hostFingerprint: raw.hostFingerprint, joinToken: raw.joinToken, expiresAt: raw.expiresAt, signal, address };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_INVITATION_BYTES) throw new Error("Invitation is too large.");
  return result;
}

export function encodeInvitation(fields) {
  return INVITATION_PREFIX + Buffer.from(JSON.stringify(parseInvitation({ version: NETWORK_PROTOCOL, ...fields }))).toString("base64url");
}

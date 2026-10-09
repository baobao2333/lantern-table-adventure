import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function digest(value) {
  return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("base64url");
}

export function protectSecret(value, decrypt = false) {
  if (process.platform !== "win32") throw new Error("Windows credential protection is required.");
  const command = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); ${decrypt
    ? "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"
    : "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"}`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    input: value, encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  if (result.error || result.status !== 0) throw new Error("Credential protection failed for the current Windows user.");
  return result.stdout.trim();
}

export function createIdentity() {
  const pair = generateKeyPairSync("ed25519");
  return identityFromPrivateKey(pair.privateKey.export({ type: "pkcs8", format: "pem" }));
}

function identityFromPrivateKey(pem) {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Unsupported host identity.");
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64url");
  return { publicKey, fingerprint: digest(Buffer.from(publicKey, "base64url")), privateKey };
}

export function loadHostIdentity(directory) {
  mkdirSync(directory, { recursive: true });
  const filename = join(directory, "host-identity.json");
  if (existsSync(filename)) {
    const saved = JSON.parse(readFileSync(filename, "utf8"));
    if (saved.version !== 1 || typeof saved.encryptedPrivateKey !== "string") throw new Error("Invalid stored host identity.");
    return identityFromPrivateKey(protectSecret(saved.encryptedPrivateKey, true));
  }
  const identity = createIdentity();
  const pem = identity.privateKey.export({ type: "pkcs8", format: "pem" });
  writeFileSync(`${filename}.tmp`, JSON.stringify({ version: 1, encryptedPrivateKey: protectSecret(pem) }), { mode: 0o600 });
  renameSync(`${filename}.tmp`, filename);
  return identity;
}

export function signEnvelope(identity, payload) {
  return { payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), identity.privateKey).toString("base64url") };
}

export function verifyEnvelope(publicKey, envelope) {
  if (!envelope || typeof envelope.signature !== "string" || !envelope.payload) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), type: "spki", format: "der" });
    return key.asymmetricKeyType === "ed25519" && verify(null, Buffer.from(JSON.stringify(envelope.payload)), key, Buffer.from(envelope.signature, "base64url"));
  } catch { return false; }
}

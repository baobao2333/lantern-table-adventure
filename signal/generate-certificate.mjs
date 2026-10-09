import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import selfsigned from "selfsigned";

const [hostname, output = "./signal-private", portValue = "8443"] = process.argv.slice(2);
const port = Number(portValue);
if (!hostname || (!isIP(hostname) && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,251}[A-Za-z0-9]$/.test(hostname)) || !Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Usage: node signal/generate-certificate.mjs <public-IP-or-hostname> [output-directory] [port]");
const directory = resolve(output);
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (existsSync(join(directory, "server-key.pem"))) throw new Error("Existing TLS key preserved; use another output directory to rotate.");
const generated = await selfsigned.generate([{ name: "commonName", value: hostname }], {
  keyType: "ec", curve: "P-256", algorithm: "sha256", notBeforeDate: new Date(Date.now() - 60_000), notAfterDate: new Date(Date.now() + 90 * 24 * 60 * 60_000),
  extensions: [{ name: "basicConstraints", cA: false }, { name: "keyUsage", digitalSignature: true }, { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [isIP(hostname) ? { type: 7, ip: hostname } : { type: 2, value: hostname }] }],
});
writeFileSync(join(directory, "server-key.pem"), generated.private, { mode: 0o600 });
writeFileSync(join(directory, "server-cert.pem"), generated.cert, { mode: 0o644 });
const tlsPin = createHash("sha256").update(new X509Certificate(generated.cert).publicKey.export({ type: "spki", format: "der" })).digest("base64url");
const address = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
writeFileSync(join(directory, "signal-client.json"), JSON.stringify({ protocol: 1, url: `wss://${address}:${port}/signal`, tlsPin, certificate: generated.cert, stunServers: [`stun:${address}:3478`] }, null, 2));
console.log(`Created TLS files and public client configuration in ${directory}. Keep server-key.pem private.`);

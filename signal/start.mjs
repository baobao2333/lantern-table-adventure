import { readFileSync } from "node:fs";
import { startSignalServer } from "./server.mjs";

const host = process.env.SIGNAL_HOST || "127.0.0.1";
const port = Number(process.env.SIGNAL_PORT || 8443);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SIGNAL_PORT must be a valid TCP port.");
const cert = process.env.SIGNAL_TLS_CERT, key = process.env.SIGNAL_TLS_KEY;
if (Boolean(cert) !== Boolean(key)) throw new Error("Both TLS certificate and private key paths are required.");
const tls = cert ? { cert: readFileSync(cert), key: readFileSync(key), minVersion: "TLSv1.2" } : undefined;
const service = await startSignalServer({ host, port, tls });
console.log(`Lantern signaling protocol 1 listening on ${tls ? "wss" : "ws"}://${host}:${service.port}/signal`);
let closing = false;
const close = async () => { if (closing) return; closing = true; await service.close(); };
process.on("SIGINT", close);
process.on("SIGTERM", close);

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] || join(root, "dist", "release"));
const metadata = JSON.parse(readFileSync(join(root, "signal", "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(metadata.version)) throw new Error("Invalid signal package version.");

// An explicit allowlist prevents runtime keys, local config, and save files entering a release.
const sourceFiles = [
  "LICENSE", "local/network/identity.mjs", "signal/package.json", "signal/package-lock.json",
  "signal/server.mjs", "signal/start.mjs", "signal/generate-certificate.mjs", "signal/package.mjs",
  "signal/README_CN.md", "signal/signal-client.example.json", "signal/Dockerfile", "signal/compose.yml",
  "signal/stun-only.conf", "signal/lantern-signal.service", "signal/.gitignore",
];
const entries = sourceFiles.sort().map(name => ({ name, data: readFileSync(join(root, name)) }));
const sha256 = data => createHash("sha256").update(data).digest("hex");
entries.push({ name: "MANIFEST.json", data: Buffer.from(JSON.stringify({
  kind: "lantern-table-signal-selfdeploy", version: metadata.version, node: metadata.engines.node,
  files: Object.fromEntries(entries.map(({ name, data }) => [name, sha256(data)])),
}, null, 2) + "\n") });
entries.push({ name: "START_HERE_CN.txt", data: Buffer.from(
  `灯桌联机辅助服务 ${metadata.version}\n\n` +
  "先阅读 signal/README_CN.md。在此解压目录执行 npm ci --prefix signal。\n" +
  "本包只有信令/STUN部署源码与无凭据示例，没有游戏存档、API Key、TLS私钥或公共服务器。\n" +
  "服务器需自行安装 Node.js 24 和 coturn；不启用 TURN。客户端安装包另行分发。\n" +
  "MANIFEST.json 记录随包源码 SHA-256；旁边的 .zip.sha256 校验下载完整性。\n") });

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

// STORE entries and a fixed DOS date make the small source archive reproducible without a ZIP dependency.
function zip(files) {
  const parts = [], directory = [];
  let offset = 0;
  for (const { name, data } of files) {
    const filename = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    parts.push(local, filename, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(0x81a40000, 38); central.writeUInt32LE(offset, 42);
    directory.push(central, filename); offset += local.length + filename.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}
mkdirSync(output, { recursive: true });
const filename = `lantern-table-signal-${metadata.version}.zip`, destination = join(output, filename);
const archive = zip(entries), temporary = `${destination}.${process.pid}.tmp`;
writeFileSync(temporary, archive, { flag: "wx" });
renameSync(temporary, destination);
writeFileSync(`${destination}.sha256`, `${sha256(archive)}  ${filename}\n`);
console.log(`Created ${destination} (${archive.length} bytes, SHA-256 ${sha256(archive)}).`);

import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  cp,
  mkdtemp,
  readdir,
} from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertReleaseVersion } from "./check-release-version.mjs";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceIndex = process.argv.indexOf("--source");
const version = await assertReleaseVersion(
  sourceIndex < 0 ? projectRoot : resolve(process.argv[sourceIndex + 1]),
);
const buildDirectory = resolve(projectRoot, "dist", "local"),
  releaseDirectory = resolve(projectRoot, "dist", "release");
const metadata = JSON.parse(
  await readFile(join(buildDirectory, "release.json"), "utf8"),
);
if (metadata.version !== version)
  throw new Error("Built runtime version is stale. Rebuild before packaging.");
if (process.platform !== "win32")
  throw new Error(
    "Windows packaging uses native PowerShell archive tools. Run this on Windows or the Windows CI job.",
  );
if (
  !/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.[1-9]\d*)?$/.test(metadata.version) ||
  !/^\d+\.\d+\.\d+$/.test(metadata.nodeVersion) ||
  !/^[a-f0-9]{64}$/.test(metadata.nodeArchiveSha256)
)
  throw new Error("Invalid release metadata.");
await mkdir(releaseDirectory, { recursive: true });
const vendorDirectory = resolve(projectRoot, "dist", "vendor");
await mkdir(vendorDirectory, { recursive: true });
const archiveName = `node-v${metadata.nodeVersion}-win-x64.zip`,
  vendorArchive = join(vendorDirectory, archiveName);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const vendorBase = `https://nodejs.org/dist/v${metadata.nodeVersion}/`;
function powershell(command, environment = {}) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; ${command}`,
    ],
    {
      env: { ...process.env, ...environment },
      windowsHide: true,
      stdio: "inherit",
      timeout: 180_000,
    },
  );
  if (result.status !== 0 || result.error)
    throw new Error("PowerShell packaging step failed.");
}
async function download(url, filename) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok)
    throw new Error(`Official Node download failed: HTTP ${response.status}`);
  await writeFile(filename, Buffer.from(await response.arrayBuffer()));
}
const checksumsFile = join(
  vendorDirectory,
  `node-${metadata.nodeVersion}-SHASUMS256.txt`,
);
await download(`${vendorBase}SHASUMS256.txt`, checksumsFile);
const checksums = await readFile(checksumsFile, "utf8");
const officialHash = checksums
  .split(/\r?\n/)
  .find((line) => line.endsWith(`  ${archiveName}`))
  ?.split(/\s+/)[0];
if (officialHash !== metadata.nodeArchiveSha256)
  throw new Error(
    "Official Node checksum differs from the pinned release checksum. Stop and review the vendor update.",
  );
let vendorBytes;
try {
  vendorBytes = await readFile(vendorArchive);
} catch {}
if (!vendorBytes || sha256(vendorBytes) !== officialHash) {
  console.log(`Downloading official Node.js ${metadata.nodeVersion}...`);
  await download(`${vendorBase}${archiveName}`, vendorArchive);
  vendorBytes = await readFile(vendorArchive);
  if (sha256(vendorBytes) !== officialHash)
    throw new Error("Node archive SHA256 verification failed.");
  await writeFile(vendorArchive, vendorBytes);
}
const staging = await mkdtemp(join(releaseDirectory, ".stage-")),
  bundleName = `lantern-table-${metadata.version}-windows-x64`,
  packageDirectory = join(staging, bundleName);
const extracted = join(staging, "vendor");
powershell(
  "Expand-Archive -LiteralPath $env:LANTERN_ARCHIVE -DestinationPath $env:LANTERN_EXTRACT -Force",
  { LANTERN_ARCHIVE: vendorArchive, LANTERN_EXTRACT: extracted },
);
await mkdir(packageDirectory, { recursive: true });
// Release payload is an explicit allowlist. No checkout, development secrets, auth or user data is copied.
for (const name of [
  "client",
  "server.mjs",
  "migrations",
  "README_CN.md",
  "CHANGELOG.md",
  "ROADMAP.md",
  "START.cmd",
  "release.json",
  "THIRD_PARTY_NOTICES.txt",
  "node_modules",
  "CODEX_LICENSE.txt",
  "LICENSE",
])
  await cp(join(buildDirectory, name), join(packageDirectory, name), {
    recursive: true,
  });
const runtimeDirectory = join(packageDirectory, "runtime");
await mkdir(runtimeDirectory);
const vendorRoot = join(extracted, `node-v${metadata.nodeVersion}-win-x64`);
for (const name of ["node.exe", "LICENSE"])
  await cp(join(vendorRoot, name), join(runtimeDirectory, name));
await writeFile(
  join(runtimeDirectory, "SHASUMS256.txt"),
  `${officialHash}  ${archiveName}\n`,
);
await writeFile(
  join(runtimeDirectory, "SOURCE.txt"),
  `${vendorBase}${archiveName}\nChecksum verified against official SHASUMS256.txt and pinned local/release.json.\n`,
);
const manifest = [];
async function record(directory, prefix = "") {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const name = prefix + entry.name;
    if (entry.isDirectory())
      await record(join(directory, entry.name), `${name}/`);
    else
      manifest.push(
        `${sha256(await readFile(join(directory, entry.name)))}  ${name}`,
      );
  }
}
await record(packageDirectory);
await writeFile(
  join(packageDirectory, "FILES_SHA256.txt"),
  manifest.join("\n") + "\n",
);
const zipPath = join(releaseDirectory, `${bundleName}.zip`);
powershell(
  "Compress-Archive -LiteralPath $env:LANTERN_PACKAGE -DestinationPath $env:LANTERN_ZIP -Force",
  { LANTERN_PACKAGE: packageDirectory, LANTERN_ZIP: zipPath },
);
const zipHash = sha256(await readFile(zipPath));
await writeFile(`${zipPath}.sha256`, `${zipHash}  ${bundleName}.zip\n`);
console.log(`Windows release ready: ${zipPath}\nSHA256: ${zipHash}`);

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, resolve, sep } from "node:path";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const desktopFiles = [
  "main.mjs",
  "preload.cjs",
  "runtime-controller.mjs",
];
export const runtimeFiles = [
  "client",
  "server.mjs",
  "migrations",
  "release.json",
  "THIRD_PARTY_NOTICES.txt",
  "node_modules",
];
export async function runtimeInventory(runtimeDirectory) {
  const frontend = [],
    migrations = [],
    dependencies = [],
    nativeBinaries = [];
  async function visit(directory, prefix, collect) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("Runtime inventories cannot contain symlinks.");
      const name = `${prefix}${entry.name}`,
        filename = join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename, `${name}/`, collect);
      else await collect(name, filename);
    }
  }
  const fingerprint = async (name, filename) => ({
    name,
    sha256: sha256(await readFile(filename)),
  });
  await visit(join(runtimeDirectory, "client"), "", async (name, filename) =>
    frontend.push(await fingerprint(name, filename)),
  );
  await visit(
    join(runtimeDirectory, "migrations"),
    "",
    async (name, filename) =>
      migrations.push(await fingerprint(name, filename)),
  );
  await visit(
    join(runtimeDirectory, "node_modules"),
    "",
    async (name, filename) => {
      if (name.endsWith(".node"))
        nativeBinaries.push(await fingerprint(name, filename));
      if (name.endsWith("/package.json")) {
        const pkg = JSON.parse(await readFile(filename, "utf8"));
        if (pkg.name && pkg.version)
          dependencies.push({
            path: name,
            name: pkg.name,
            version: pkg.version,
          });
      }
    },
  );
  for (const entries of [frontend, migrations, dependencies, nativeBinaries])
    entries.sort((a, b) => (a.path || a.name).localeCompare(b.path || b.name));
  return { frontend, migrations, dependencies, nativeBinaries };
}
export async function prepareElectron(version) {
  const pin = JSON.parse(
    await readFile(new URL("./electron-release.json", import.meta.url), "utf8"),
  );
  if (version !== pin.version)
    throw new Error(
      "Review and update the official Electron digest before changing its version.",
    );
  if (
    process.env.LANTERN_ELECTRON_MIRROR &&
    process.env.LANTERN_ELECTRON_MIRROR !== "npmmirror"
  )
    throw new Error("Unsupported Electron cache mirror.");
  const { downloadArtifact } = await import("@electron/get");
  let downloadedFrom;
  const archive = await downloadArtifact({
    artifactName: "electron",
    version,
    platform: "win32",
    arch: "x64",
    checksums: { [`electron-v${version}-win32-x64.zip`]: pin.sha256 },
    downloader: {
      async download(url, filename) {
        if (url !== pin.officialSource)
          throw new Error(
            "Desktop builds only download official Electron releases.",
          );
        downloadedFrom =
          process.env.LANTERN_ELECTRON_MIRROR === "npmmirror"
            ? `https://npmmirror.com/mirrors/electron/${version}/electron-v${version}-win32-x64.zip`
            : `${url}?download=1`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 600_000);
        let stalled = setTimeout(() => controller.abort(), 60_000);
        try {
          const response = await fetch(downloadedFrom, {
            headers: { Range: "bytes=0-", "Accept-Encoding": "identity" },
            signal: controller.signal,
          });
          if (!response.ok || !response.body)
            throw new Error(
              `Official Electron download failed: HTTP ${response.status}`,
            );
          let transferred = 0,
            lastReport = Date.now();
          const total = Number(response.headers.get("content-length")) || 0;
          await mkdir(resolve(filename, ".."), { recursive: true });
          await pipeline(
            Readable.fromWeb(response.body),
            async function* (source) {
              for await (const chunk of source) {
                clearTimeout(stalled);
                stalled = setTimeout(() => controller.abort(), 60_000);
                transferred += chunk.length;
                if (transferred > 512 * 1024 * 1024)
                  throw new Error(
                    "Official Electron artifact exceeds the reviewed size bound.",
                  );
                if (Date.now() - lastReport > 15_000) {
                  console.log(
                    `Official Electron: ${Math.round(transferred / 1024 / 1024)} / ${total ? Math.round(total / 1024 / 1024) : "?"} MiB`,
                  );
                  lastReport = Date.now();
                }
                yield chunk;
              }
            },
            createWriteStream(filename),
          );
        } finally {
          clearTimeout(timeout);
          clearTimeout(stalled);
        }
      },
    },
  });
  if (sha256(await readFile(archive)) !== pin.sha256)
    throw new Error(
      "Electron cache differs from the reviewed official GitHub digest.",
    );
  const receiptPath = `${archive}.lantern-source.json`;
  let cachedReceipt;
  try {
    cachedReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch {}
  const receipt = {
    version,
    sha256: pin.sha256,
    officialSource: pin.officialSource,
    digestSource: pin.digestSource,
    downloadedFrom:
      downloadedFrom ||
      (cachedReceipt?.sha256 === pin.sha256
        ? cachedReceipt.downloadedFrom
        : "preexisting locally verified cache"),
  };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  return receipt;
}
export function contained(root, filename) {
  const absoluteRoot = resolve(root),
    absoluteFilename = resolve(filename);
  if (!absoluteFilename.startsWith(absoluteRoot + sep))
    throw new Error(
      "Refusing an operation outside the desktop build directory.",
    );
  return absoluteFilename;
}
export function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`Build command failed with exit ${code}.`)),
    );
  });
}
async function download(url, filename) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        `Official runtime download failed: HTTP ${response.status}`,
      );
    await writeFile(filename, Buffer.from(await response.arrayBuffer()));
  } finally {
    clearTimeout(timeout);
  }
}
export async function prepareNode(projectRoot, runtimeDirectory, metadata) {
  if (process.platform !== "win32")
    throw new Error("The Windows desktop runtime must be built on Windows.");
  if (
    !/^\d+\.\d+\.\d+$/.test(metadata.nodeVersion) ||
    !/^[a-f0-9]{64}$/.test(metadata.nodeArchiveSha256)
  )
    throw new Error("Invalid pinned Node release.");
  const vendor = join(projectRoot, "dist", "vendor");
  await mkdir(vendor, { recursive: true });
  const archiveName = `node-v${metadata.nodeVersion}-win-x64.zip`;
  const archive = join(vendor, archiveName);
  const base = `https://nodejs.org/dist/v${metadata.nodeVersion}/`;
  const checksums = join(vendor, `node-${metadata.nodeVersion}-SHASUMS256.txt`);
  await download(`${base}SHASUMS256.txt`, checksums);
  const official = (await readFile(checksums, "utf8"))
    .split(/\r?\n/)
    .find((line) => line.endsWith(`  ${archiveName}`))
    ?.split(/\s+/)[0];
  if (official !== metadata.nodeArchiveSha256)
    throw new Error("Official Node checksum differs from the reviewed pin.");
  let bytes;
  try {
    bytes = await readFile(archive);
  } catch {}
  if (!bytes || sha256(bytes) !== official) {
    await download(`${base}${archiveName}`, archive);
    bytes = await readFile(archive);
  }
  if (sha256(bytes) !== official)
    throw new Error("Node archive checksum verification failed.");
  const extracted = contained(
    join(projectRoot, "dist", "desktop"),
    join(projectRoot, "dist", "desktop", `node-vendor-${randomUUID()}`),
  );
  await mkdir(extracted, { recursive: true });
  try {
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:LANTERN_NODE_ARCHIVE -DestinationPath $env:LANTERN_NODE_EXTRACT -Force",
      ],
      {
        env: {
          ...process.env,
          LANTERN_NODE_ARCHIVE: archive,
          LANTERN_NODE_EXTRACT: extracted,
        },
      },
    );
    const { cp } = await import("node:fs/promises");
    for (const filename of ["node.exe", "LICENSE"])
      await cp(
        join(extracted, `node-v${metadata.nodeVersion}-win-x64`, filename),
        join(
          runtimeDirectory,
          filename === "LICENSE" ? "NODE_LICENSE.txt" : filename,
        ),
      );
    await writeFile(
      join(runtimeDirectory, "NODE_SOURCE.txt"),
      `${base}${archiveName}\nSHA256 ${official}\nVerified against the official checksum and local/release.json.\n`,
    );
  } finally {
    await rm(extracted, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}

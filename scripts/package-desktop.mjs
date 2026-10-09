import { createRequire } from "node:module";
import { readFile, readdir, mkdir, rm, cp, writeFile } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseVersion } from "./check-release-version.mjs";
import {
  contained,
  run,
  sha256,
  prepareElectron,
} from "../desktop/distribution.mjs";

if (process.platform !== "win32")
  throw new Error("Squirrel.Windows packaging must run on Windows.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = await assertReleaseVersion(root);
const app = join(root, "dist", "desktop", "app");
const manifest = JSON.parse(
  await readFile(
    join(root, "dist", "desktop", "runtime", "desktop-release.json"),
    "utf8",
  ),
);
const stagedPackage = JSON.parse(
  await readFile(join(app, "package.json"), "utf8"),
);
if (manifest.application !== version || stagedPackage.version !== version)
  throw new Error("Desktop build is stale. Run build-desktop first.");
const electronDistribution = await prepareElectron(manifest.electron);
await writeFile(
  join(root, "dist", "desktop", "runtime", "ELECTRON_SOURCE.json"),
  JSON.stringify(electronDistribution, null, 2),
);
const require = createRequire(join(root, "package.json"));
const forgePackageFile = require.resolve("@electron-forge/cli/package.json");
const forge = JSON.parse(await readFile(forgePackageFile, "utf8"));
await run(
  join(root, "dist", "desktop", "runtime", "node.exe"),
  [
    resolve(dirname(forgePackageFile), forge.bin["electron-forge"]),
    "make",
    "--platform=win32",
    "--arch=x64",
  ],
  { cwd: app },
);
const output = contained(
  join(root, "dist", "desktop"),
  join(root, "dist", "desktop", "release"),
);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) await collect(filename);
    else if (/\.(exe|zip|nupkg)$|^RELEASES$/i.test(entry.name)) {
      if (files.some((file) => file.name === basename(filename)))
        throw new Error("Duplicate desktop release artifact name.");
      const destination = join(output, basename(filename));
      await cp(filename, destination);
      const bytes = await readFile(destination);
      files.push({
        name: basename(filename),
        size: bytes.length,
        sha256: sha256(bytes),
      });
    }
  }
}
await collect(join(app, "out", "make"));
if (
  !files.some((file) => /-Setup\.exe$/.test(file.name)) ||
  !files.some((file) => /\.zip$/.test(file.name))
)
  throw new Error("Forge did not produce both Setup.exe and portable ZIP.");
files.sort((a, b) => a.name.localeCompare(b.name));
await writeFile(
  join(output, "desktop-release.json"),
  JSON.stringify(
    { ...manifest, electronDistribution, artifacts: files },
    null,
    2,
  ),
);
await writeFile(
  join(output, "SHA256SUMS.txt"),
  files.map((file) => `${file.sha256}  ${file.name}`).join("\n") + "\n",
);
console.log(`Desktop release ready: ${output}`);

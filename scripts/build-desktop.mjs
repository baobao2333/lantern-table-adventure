import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseVersion } from "./check-release-version.mjs";
import {
  contained,
  desktopFiles,
  runtimeFiles,
  prepareNode,
  run,
  runtimeInventory,
  sha256,
} from "../desktop/distribution.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = await assertReleaseVersion(root);
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const metadata = JSON.parse(
  await readFile(join(root, "local", "release.json"), "utf8"),
);
const electronVersion = pkg.devDependencies.electron;
if (!/^\d+\.\d+\.\d+$/.test(electronVersion || ""))
  throw new Error(
    "Pin an exact reviewed Electron version in devDependencies before building.",
  );
if (!process.argv.includes("--skip-local"))
  await run(process.execPath, [join(root, "scripts", "build-local.mjs")], {
    cwd: root,
  });
const build = join(root, "dist", "desktop");
await mkdir(build, { recursive: true });
const app = contained(build, join(build, "app")),
  runtime = contained(build, join(build, "runtime"));
for (const directory of [app, runtime]) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}
for (const filename of desktopFiles)
  await cp(join(root, "desktop", filename), join(app, filename));
await cp(
  join(root, "desktop", "forge.config.cjs"),
  join(app, "forge.config.cjs"),
);
await cp(join(root, "LICENSE"), join(app, "LICENSE"));
await writeFile(
  join(app, "package.json"),
  JSON.stringify(
    {
      name: "lantern-table-adventure",
      productName: "LanternTable",
      version,
      description: "A local-first tabletop adventure with an AI narrator",
      author: "Lantern Table contributors",
      license: "UNLICENSED",
      private: true,
      type: "module",
      main: "main.mjs",
      devDependencies: { electron: electronVersion },
      config: { forge: "./forge.config.cjs" },
    },
    null,
    2,
  ),
);
const builtMetadata = JSON.parse(
  await readFile(join(root, "dist", "local", "release.json"), "utf8"),
);
if (builtMetadata.version !== version)
  throw new Error(
    "Local runtime is stale; rebuild before making a desktop release.",
  );
for (const filename of runtimeFiles)
  await cp(join(root, "dist", "local", filename), join(runtime, filename), {
    recursive: true,
  });
for (const filename of ["README_CN.md", "CHANGELOG.md"])
  await cp(
    join(root, filename === "README_CN.md" ? "desktop" : "", filename),
    join(runtime, filename),
  );
await cp(join(root, "LICENSE"), join(runtime, "LICENSE"));
await cp(
  join(root, "desktop", "codex-release.json"),
  join(runtime, "codex-release.json"),
);
await cp(
  join(root, "desktop", "CODEX_LICENSE.txt"),
  join(runtime, "CODEX_LICENSE.txt"),
);
await prepareNode(root, runtime, metadata);
const inventory = await runtimeInventory(runtime);
const roomSchemaSource = "local/rooms/store.ts";
await writeFile(
  join(runtime, "desktop-release.json"),
  JSON.stringify(
    {
      application: version,
      frontend: version,
      electron: electronVersion,
      node: metadata.nodeVersion,
      platform: "win32-x64",
      roomProtocol: 1,
      signalingProtocol: 1,
      invitationFormat: 1,
      storage: "desktop/adventures-desktop.sqlite",
      roomSchema: {
        source: roomSchemaSource,
        sha256: sha256(await readFile(join(root, roomSchemaSource))),
      },
      codex: JSON.parse(
        await readFile(join(root, "desktop", "codex-release.json"), "utf8"),
      ).version,
      inventory,
    },
    null,
    2,
  ),
);
console.log(`Desktop build ready: ${build}`);

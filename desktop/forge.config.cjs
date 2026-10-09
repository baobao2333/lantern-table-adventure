const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { readFile, writeFile } = require("node:fs/promises");
const pkg = require("./package.json");
const { readSigningConfig } = require("./windows-signing.cjs");
const signing = readSigningConfig();
const windowsSign = signing
  ? { hookModulePath: path.resolve(__dirname, "windows-signing.cjs") }
  : undefined;

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: "LanternTable",
    appBundleId: "com.lantern-table.adventure",
    appCopyright: "Lantern Table contributors",
    extraResource: [path.resolve(__dirname, "../runtime")],
    ignore: [/^\/(?:forge\.config|windows-signing)\.cjs$/],
    ...(windowsSign ? { windowsSign } : {}),
  },
  hooks: {
    postPackage: async (_config, result) => {
      if (!signing) return;
      const { runtimeInventory } = await import(
        pathToFileURL(path.resolve(__dirname, "../../../desktop/distribution.mjs")).href
      );
      for (const output of result.outputPaths) {
        const runtime = path.join(output, "resources", "runtime");
        const filename = path.join(runtime, "desktop-release.json");
        const manifest = JSON.parse(await readFile(filename, "utf8"));
        manifest.inventory = await runtimeInventory(runtime);
        await writeFile(filename, JSON.stringify(manifest, null, 2));
      }
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "lantern_table_adventure",
        authors: "Lantern Table contributors",
        description: "A local-first tabletop adventure with an AI narrator",
        setupExe: `LanternTable-${pkg.version}-Setup.exe`,
        noMsi: true,
        ...(windowsSign ? { windowsSign } : {}),
      },
    },
    { name: "@electron-forge/maker-zip", platforms: ["win32"] },
  ],
};

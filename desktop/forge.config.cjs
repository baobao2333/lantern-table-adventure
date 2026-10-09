const path = require("node:path");
const pkg = require("./package.json");

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: "LanternTable",
    appBundleId: "com.lantern-table.adventure",
    appCopyright: "Lantern Table contributors",
    extraResource: [path.resolve(__dirname, "../runtime")],
    ignore: [/^\/forge\.config\.cjs$/],
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
      },
    },
    { name: "@electron-forge/maker-zip", platforms: ["win32"] },
  ],
};

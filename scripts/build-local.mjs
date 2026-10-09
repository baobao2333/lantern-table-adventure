import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, cp, readdir, readFile, writeFile } from "node:fs/promises";
import { localViteConfig } from "../local/vite.config.mjs";
import { assertReleaseVersion } from "./check-release-version.mjs";
import { copyRuntimeDependencies, runtimeDependencies } from "./copy-runtime-dependencies.mjs";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceIndex = process.argv.indexOf("--source");
const sourceRoot =
  sourceIndex < 0 ? projectRoot : resolve(process.argv[sourceIndex + 1]);
await assertReleaseVersion(sourceRoot);
const outputDirectory = resolve(projectRoot, "dist", "local");
const require = createRequire(resolve(sourceRoot, "package.json"));
const { build: buildClient } = await import(
  pathToFileURL(require.resolve("vite")).href
);
const { build: buildServer } = await import(
  pathToFileURL(require.resolve("esbuild")).href
);
await mkdir(outputDirectory, { recursive: true });
await buildClient(
  await localViteConfig(
    sourceRoot,
    resolve(projectRoot, "local"),
    outputDirectory,
  ),
);
await buildServer({
  entryPoints: [resolve(projectRoot, "local", "server.ts")],
  outfile: resolve(outputDirectory, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  legalComments: "inline",
  external: runtimeDependencies,
  tsconfigRaw: {
    compilerOptions: { baseUrl: sourceRoot, paths: { "@/*": ["./*"] } },
  },
  nodePaths: [resolve(sourceRoot, "node_modules")],
});
await mkdir(resolve(outputDirectory, "migrations"), { recursive: true });
for (const name of await readdir(resolve(sourceRoot, "drizzle")))
  if (name.endsWith(".sql"))
    await cp(
      resolve(sourceRoot, "drizzle", name),
      resolve(outputDirectory, "migrations", name),
    );
for (const name of ["README_CN.md", "START.cmd", "release.json"])
  await cp(resolve(projectRoot, "local", name), resolve(outputDirectory, name));
for (const name of ["CHANGELOG.md", "ROADMAP.md"])
  await cp(resolve(projectRoot, name), resolve(outputDirectory, name));
await cp(resolve(projectRoot, "desktop", "CODEX_LICENSE.txt"), resolve(outputDirectory, "CODEX_LICENSE.txt"));
await cp(resolve(projectRoot, "LICENSE"), resolve(outputDirectory, "LICENSE"));
const notices = await copyRuntimeDependencies(sourceRoot, outputDirectory);
for (const name of [
  "react",
  "react-dom",
  "scheduler",
  "lucide-react",
  "zod",
  "tw-animate-css",
  "ajv",
  "fast-deep-equal",
  "fast-uri",
  "json-schema-traverse",
  "require-from-string",
]) {
  const directory = resolve(sourceRoot, "node_modules", name);
  const filename = (await readdir(directory)).find((filename) =>
    /^licen[sc]e/i.test(filename),
  );
  if (!filename)
    throw new Error(`Missing license for bundled dependency ${name}`);
  notices.push(
    `${name}\n${await readFile(resolve(directory, filename), "utf8")}`,
  );
}
const vendorLicense = resolve(
  sourceRoot,
  "vendor",
  "shadcn-tailwind-4.13.0.LICENSE.md",
);
notices.push(`shadcn-tailwind\n${await readFile(vendorLicense, "utf8")}`);
await writeFile(
  resolve(outputDirectory, "THIRD_PARTY_NOTICES.txt"),
  notices.join("\n\n-----\n\n"),
);
console.log(`Local runtime built: ${outputDirectory}`);

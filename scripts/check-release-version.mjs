import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function assertReleaseVersion(
  sourceRoot = projectRoot,
  tag = process.env.GITHUB_REF?.startsWith("refs/tags/")
    ? process.env.GITHUB_REF.slice(10)
    : "",
) {
  const pkg = JSON.parse(
    await readFile(join(sourceRoot, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(join(sourceRoot, "package-lock.json"), "utf8"),
  );
  const metadata = JSON.parse(
    await readFile(join(projectRoot, "local", "release.json"), "utf8"),
  );
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version))
    throw new Error("Release version must be a stable semantic version.");
  if (
    pkg.version !== lock.version ||
    pkg.version !== lock.packages?.[""].version ||
    pkg.version !== metadata.version
  )
    throw new Error(
      "package.json, package-lock.json and local/release.json versions must match.",
    );
  if (metadata.platform !== "windows-x64")
    throw new Error("Portable release platform must be windows-x64.");
  const server = await readFile(
    join(projectRoot, "local", "server.ts"),
    "utf8",
  );
  if (
    server.match(/export const VERSION\s*=\s*["']([^"']+)["']/)?.[1] !==
    pkg.version
  )
    throw new Error("Local server VERSION must match package.json.");
  const changes = await readFile(join(projectRoot, "CHANGELOG.md"), "utf8");
  if (!changes.split(/\r?\n/).includes(`## v${pkg.version}`))
    throw new Error("CHANGELOG.md must contain the release version heading.");
  const startupGuide = await readFile(
    join(projectRoot, "local", "README_CN.md"),
    "utf8",
  );
  if (!startupGuide.startsWith(`# 灯火之下 ${pkg.version} · Windows 本机版`))
    throw new Error("Local startup guide must match the release version.");
  if (tag && tag !== `v${pkg.version}`)
    throw new Error("Git tag must match the package release version.");
  return pkg.version;
}
if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const sourceIndex = process.argv.indexOf("--source"),
    tagIndex = process.argv.indexOf("--tag");
  const version = await assertReleaseVersion(
    sourceIndex < 0 ? projectRoot : resolve(process.argv[sourceIndex + 1]),
    tagIndex < 0 ? undefined : process.argv[tagIndex + 1],
  );
  console.log(`PASS release version ${version}`);
}

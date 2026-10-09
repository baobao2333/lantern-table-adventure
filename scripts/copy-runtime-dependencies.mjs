import { createRequire } from "node:module";
import { readFile, cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve, relative, sep } from "node:path";

export const runtimeDependencies = ["node-datachannel", "@node-datachannel/win32-x64-msvc", "ws", "selfsigned"];

// Keep native addons and CJS dependencies outside the ESM server bundle.
// Resolve each package from its actual parent to preserve nested dependency versions.
export async function copyRuntimeDependencies(sourceRoot, destination) {
  const visited = new Set();
  const notices = [];
  const sourceModules = resolve(sourceRoot, "node_modules");
  const targetModules = resolve(destination, "node_modules");
  if (!targetModules.startsWith(resolve(destination) + sep)) throw new Error("Invalid runtime dependency directory.");
  await rm(targetModules, { recursive: true, force: true });
  async function copy(name, parent) {
    const require = createRequire(join(parent, "package.json"));
    let source;
    try { source = dirname(require.resolve(`${name}/package.json`)); }
    catch {
      let cursor = dirname(require.resolve(name));
      for (;;) {
        try {
          const pkg = JSON.parse(await readFile(join(cursor, "package.json"), "utf8"));
          if (pkg.name === name) { source = cursor; break; }
        } catch {}
        const next = dirname(cursor);
        if (next === cursor) throw new Error(`Cannot locate runtime dependency ${name}`);
        cursor = next;
      }
    }
    if (!source.startsWith(sourceModules + sep)) throw new Error("Runtime dependency resolves outside the installed dependency tree.");
    const target = join(targetModules, relative(sourceModules, source));
    if (visited.has(source)) return;
    visited.add(source);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, filter: path => path !== join(source, "node_modules") });
    const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    const license = (await readdir(source)).find(file => /^licen[sc]e/i.test(file));
    if (license) notices.push(`${name}@${pkg.version}\n${await readFile(join(source, license), "utf8")}`);
    for (const dependency of Object.keys(pkg.dependencies || {}))
      await copy(dependency, source);
  }
  for (const name of runtimeDependencies)
    await copy(name, resolve(sourceRoot));
  return notices;
}

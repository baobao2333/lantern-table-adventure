import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseVersion } from "./check-release-version.mjs";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceIndex = process.argv.indexOf("--source");
const version = await assertReleaseVersion(
  sourceIndex < 0 ? projectRoot : resolve(process.argv[sourceIndex + 1]),
);
const lines = (await readFile(join(projectRoot, "CHANGELOG.md"), "utf8")).split(
  /\r?\n/,
);
const start = lines.indexOf(`## v${version}`),
  next = lines.findIndex(
    (line, index) => index > start && line.startsWith("## "),
  );
const notes =
  lines
    .slice(start + 1, next < 0 ? undefined : next)
    .join("\n")
    .trim() + "\n";
await mkdir(join(projectRoot, "dist", "release"), { recursive: true });
await writeFile(
  join(projectRoot, "dist", "release", "RELEASE_NOTES.md"),
  notes,
);

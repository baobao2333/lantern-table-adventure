import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export async function localViteConfig(sourceRoot, localRoot, outputDirectory) {
  const require = createRequire(resolve(sourceRoot, "package.json"));
  const react = (await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href)).default;
  const tailwind = require("@tailwindcss/postcss");
  return {
    configFile: false, root: localRoot, publicDir: resolve(sourceRoot, "public"), plugins: [{ name: "local-font-imports", enforce: "pre", transform(code, id) { if (id.replaceAll("\\", "/").endsWith("/app/table.css")) return code.replace(/^@import[^\r\n]*fonts\.googleapis\.com[^\r\n]*(?:\r?\n|$)/m, ""); } }, react()],
    resolve: { alias: [{ find: "next/link", replacement: resolve(localRoot, "link.tsx") }, { find: "@", replacement: sourceRoot }, { find: "react", replacement: resolve(sourceRoot, "node_modules/react") }, { find: "react-dom", replacement: resolve(sourceRoot, "node_modules/react-dom") }] },
    css: { postcss: { plugins: [{ postcssPlugin: "local-fonts", AtRule: { import(rule) { if (rule.params.includes("fonts.googleapis.com")) rule.remove(); } } }, tailwind({ base: sourceRoot })] } },
    build: { outDir: resolve(outputDirectory, "client"), emptyOutDir: true, sourcemap: false },
  };
}

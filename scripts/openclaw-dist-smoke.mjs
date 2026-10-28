// Import the built plugin bundles in a real ESM context. esbuild's CJS
// interop shim throws "Dynamic require of node:assert is not supported"
// unless the bundle defines require via createRequire; importing here
// catches that packaging bug before publish.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "packages", "openclaw", "dist");

for (const entry of ["index.js", "setup-entry.js"]) {
  await import(pathToFileURL(path.join(dist, entry)).href);
  console.log(`ok ${entry}`);
}

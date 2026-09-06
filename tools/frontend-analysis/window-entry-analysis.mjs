import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Count each static JS dependency once, including the small HTML bootstrap. */
export function analyzeWindowEntries(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, ".vite/manifest.json"), "utf8"));
  const entries = manifest["index.html"].dynamicImports;
  if (!entries?.length) throw new Error("Expected dynamic window entries in the Vite manifest");
  return entries.map((entry) => {
    const visited = new Set();
    const visit = (key) => {
      if (visited.has(key)) return;
      visited.add(key);
      for (const dependency of manifest[key].imports ?? []) visit(dependency);
    };
    visit("index.html"); visit(entry);
    const files = [...visited].map((key) => manifest[key].file).sort();
    return {
      entry,
      surface: entries.length === 1 ? "combined" : entry.includes("petMain") ? "desktop-pet" : entry.includes("quickChatMain") ? "desktop-pet-chat" : "main",
      staticJsBytes: files.reduce((total, file) => total + fs.statSync(path.join(directory, file)).size, 0),
      files,
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: node tools/frontend-analysis/window-entry-analysis.mjs <Vite build directory with --manifest>");
  console.log(JSON.stringify(analyzeWindowEntries(path.resolve(process.argv[2])), null, 2));
}

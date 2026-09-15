import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { build } from "vite";

test("production bootstrap loads each window with its own CSS before importing it", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tinybot-window-entry-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  // Keep the real bootstrap and Vite production transforms; replace the heavy
  // renderers with distinct styles so this catches preload dependency hoisting.
  await fs.writeFile(path.join(root, "index.html"), '<script type="module" src="/src/main.ts"></script>');
  const bootstrap = await fs.readFile(new URL("../../src/main.ts", import.meta.url), "utf8");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/main.ts"), bootstrap);
  const result = await build({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [{
      name: "window-entry-fixtures",
      resolveId(id) {
        if (id.startsWith("./")) return `\0fixture:${id}`;
      },
      load(id) {
        if (!id.startsWith("\0fixture:")) return;
        if (id.endsWith(".css")) return `.fixture { --entry: ${path.basename(id, ".css")}; }`;
        const entry = /\/react-workbench\/(petMain|quickChatMain|main)$/.exec(id)?.[1];
        if (entry) return `import "./${entry}.css"; window.mounted = ${JSON.stringify(entry)};`;
        if (id.endsWith("rendererDiagnostics")) return "export const buildRendererDiagnostic = () => ({}), recordRendererDiagnostic = () => {}, showRendererDiagnosticOverlay = () => {};";
        if (id.endsWith("startupSplash")) return "export const removeStartupSplash = () => {};";
        if (id.endsWith("rendererPerformance")) return "export const installRendererPerformanceTracking = () => {};";
        if (id.endsWith("desktopNativeChatDebug")) return "export const createDesktopNativeStartupTrace = () => ({mark(){}, start(){}, complete(){}, fail(){}});";
        throw new Error(`Unexpected bootstrap dependency: ${id}`);
      },
    }],
    build: { write: false },
  });
  const output = result.output;
  const entryChunk = output.find((item) => item.type === "chunk" && item.isEntry);
  assert.ok(entryChunk);
  for (const [surface, entry] of [["main", "main"], ["desktop-pet", "petMain"], ["desktop-pet-chat", "quickChatMain"]]) {
    await context.test(surface, async () => {
      const styles = [];
      const loads = [];
      const imports = [];
      const documentEvents = new EventTarget();
      const sandbox = vm.createContext({
        URL,
        URLSearchParams,
        window: { location: { search: `?surface=${surface}` } },
        document: {
          addEventListener: documentEvents.addEventListener.bind(documentEvents),
          createElement: () => ({
            relList: { supports: () => true },
            addEventListener(event, callback) { if (event === "load") loads.push(callback); },
          }),
          querySelector: () => null,
          getElementsByTagName: () => [],
          head: { appendChild(link) { if (link.rel === "stylesheet") styles.push(link.href); } },
        },
      });
      const entryModule = new vm.SourceTextModule(entryChunk.code, {
        context: sandbox,
        identifier: `https://tinybot.test/${entryChunk.fileName}`,
        initializeImportMeta(meta, module) {
          meta.url = module.identifier;
          meta.resolve = (specifier) => new URL(specifier, module.identifier).href;
        },
        async importModuleDynamically(specifier) {
          imports.push(specifier);
          const renderer = new vm.SyntheticModule([], () => {}, { context: sandbox });
          await renderer.link(() => { throw new Error("Unexpected renderer import"); });
          await renderer.evaluate();
          return renderer;
        },
      });
      await entryModule.link((specifier) => { throw new Error(`Unexpected bootstrap import: ${specifier}`); });
      await entryModule.evaluate();
      const contextMenu = new Event("contextmenu", { cancelable: true });
      documentEvents.dispatchEvent(contextMenu);
      assert.equal(contextMenu.defaultPrevented, true, "production windows must suppress the browser context menu");
      await new Promise(setImmediate);
      assert.deepEqual(imports, [], "entry must wait for its stylesheets");
      assert.equal(styles.length, 1);
      const cssPath = new URL(styles[0], entryModule.identifier).pathname.slice(1);
      const css = output.find((item) => item.fileName === cssPath);
      assert.ok(css && css.type === "asset");
      assert.match(String(css.source), new RegExp(`--entry:\\s*${entry}[;}]`), `wrong stylesheet loaded for ${surface}`);
      for (const complete of loads) complete();
      await new Promise(setImmediate);
      assert.equal(imports.length, 1);
      assert.match(imports[0], new RegExp(`/${entry}-`));
    });
  }
});

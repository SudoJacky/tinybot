import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "../..");
const webuiRoot = path.resolve(repoRoot, "webui");

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [webuiStaticPlugin(webuiRoot)],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    fs: {
      allow: [dirname, webuiRoot],
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
}));

function webuiStaticPlugin(root: string): Plugin {
  const assetRoots = [
    { route: "/assets", dir: path.join(root, "assets") },
    { route: "/docs", dir: path.join(root, "docs") },
  ];
  return {
    name: "tinybot-webui-static",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!serveWebuiStatic(root, request.url ?? "", response)) {
          next();
        }
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!serveWebuiStatic(root, request.url ?? "", response)) {
          next();
        }
      });
    },
    generateBundle() {
      for (const assetRoot of assetRoots) {
        for (const file of walkFiles(assetRoot.dir)) {
          if (isSourceTestFile(file)) {
            continue;
          }
          const relative = path.relative(assetRoot.dir, file).replaceAll(path.sep, "/");
          this.emitFile({
            type: "asset",
            fileName: `${assetRoot.route.slice(1)}/${relative}`,
            source: fs.readFileSync(file),
          });
        }
      }
    },
  };
}

function isSourceTestFile(file: string): boolean {
  return /\.test\.[cm]?js$/i.test(file) || /\.test\.mjs$/i.test(file);
}

function serveWebuiStatic(
  root: string,
  url: string,
  response: {
    statusCode: number;
    setHeader: (name: string, value: string) => void;
    end: (body?: Buffer | string) => void;
  },
): boolean {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const file = resolveWebuiStaticFile(root, pathname);
  if (!file) {
    return false;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType(file));
  response.end(fs.readFileSync(file));
  return true;
}

function resolveWebuiStaticFile(root: string, pathname: string): string | null {
  if (pathname === "/docs") {
    return path.join(root, "docs", "index.html");
  }
  for (const prefix of ["/assets/", "/docs/"]) {
    if (pathname.startsWith(prefix)) {
      const candidate = path.resolve(root, pathname.slice(1));
      if (candidate.startsWith(root) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }
  return null;
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
  });
}

function contentType(file: string): string {
  const extension = path.extname(file).toLowerCase();
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  };
  return types[extension] ?? "application/octet-stream";
}

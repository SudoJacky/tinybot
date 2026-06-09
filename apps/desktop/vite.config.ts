import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

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
    include: ["src/**/*.test.ts", "workers/**/*.test.ts"],
  },
}));

type WebuiStaticAssetRoot = {
  route: "/assets" | "/docs";
  dir: string;
};

type WebuiStaticBundleFile = {
  fileName: string;
  sourcePath: string;
};

function webuiStaticPlugin(root: string): Plugin {
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
      for (const file of collectWebuiStaticBundleFiles(root)) {
        this.emitFile({
          type: "asset",
          fileName: file.fileName,
          source: fs.readFileSync(file.sourcePath),
        });
      }
    },
  };
}

function webuiStaticAssetRoots(root: string): WebuiStaticAssetRoot[] {
  return [
    { route: "/assets", dir: path.join(root, "assets") },
    { route: "/docs", dir: path.join(root, "docs") },
  ];
}

export function collectWebuiStaticBundleFiles(root: string): WebuiStaticBundleFile[] {
  const files: WebuiStaticBundleFile[] = [];
  for (const assetRoot of webuiStaticAssetRoots(root)) {
    for (const file of walkFiles(assetRoot.dir)) {
      if (isSourceTestFile(file)) {
        continue;
      }
      const relative = path.relative(assetRoot.dir, file).split(path.sep).join("/");
      const routePrefix = assetRoot.route.slice(1);
      files.push({ fileName: `${routePrefix}/${relative}`, sourcePath: file });

      if (assetRoot.route === "/docs" && relative !== "index.html" && path.extname(file).toLowerCase() === ".html") {
        const routeName = relative.slice(0, -".html".length);
        files.push({ fileName: `docs/${routeName}`, sourcePath: file });
      }
    }
  }
  return files.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

export function isSourceTestFile(file: string): boolean {
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

export function resolveWebuiStaticFile(root: string, pathname: string): string | null {
  if (pathname.split("/").includes("..")) {
    return null;
  }
  if (pathname === "/docs" || pathname === "/docs/") {
    return path.join(root, "docs", "index.html");
  }
  if (pathname.startsWith("/docs/")) {
    const candidate = resolveStaticRoute(root, pathname);
    if (candidate) {
      return candidate;
    }
    return resolveStaticRoute(root, `${pathname}.html`);
  }
  for (const prefix of ["/assets/", "/docs/"]) {
    if (pathname.startsWith(prefix)) {
      const candidate = resolveStaticRoute(root, pathname);
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveStaticRoute(root: string, pathname: string): string | null {
  const candidate = path.resolve(root, pathname.slice(1));
  if (isInsideRoot(root, candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }
  return null;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

export function contentType(file: string): string {
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

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;
const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname;
const desktopStaticRoot = path.resolve(repoRoot, "public");

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), desktopStaticPlugin(desktopStaticRoot)],
  publicDir: desktopStaticRoot,
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
      allow: [dirname, desktopStaticRoot],
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "workers/**/*.test.ts"],
  },
}));

type DesktopStaticAssetRoot = {
  route: "/assets" | "/docs";
  dir: string;
};

type DesktopStaticBundleFile = {
  fileName: string;
  sourcePath: string;
};

function desktopStaticPlugin(root: string): Plugin {
  return {
    name: "tinybot-desktop-static",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!serveDesktopStatic(root, request.url ?? "", response)) {
          next();
        }
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!serveDesktopStatic(root, request.url ?? "", response)) {
          next();
        }
      });
    },
  };
}

function desktopStaticAssetRoots(root: string): DesktopStaticAssetRoot[] {
  return [
    { route: "/assets", dir: path.join(root, "assets") },
    { route: "/docs", dir: path.join(root, "docs") },
  ];
}

export function collectDesktopStaticBundleFiles(root: string): DesktopStaticBundleFile[] {
  const files: DesktopStaticBundleFile[] = [];
  for (const assetRoot of desktopStaticAssetRoots(root)) {
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

function serveDesktopStatic(
  root: string,
  url: string,
  response: {
    statusCode: number;
    setHeader: (name: string, value: string) => void;
    end: (body?: Buffer | string) => void;
  },
): boolean {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const file = resolveDesktopStaticFile(root, pathname);
  if (!file) {
    return false;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType(file));
  response.end(fs.readFileSync(file));
  return true;
}

export function resolveDesktopStaticFile(root: string, pathname: string): string | null {
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

import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  collectDesktopStaticBundleFiles,
  contentType,
  isSourceTestFile,
  resolveDesktopStaticFile,
} from "../vite.config";

const publicRoot = path.resolve(__dirname, "../public");

describe("desktop static routing", () => {
  test("resolves docs index and desktop asset routes from public assets", () => {
    expect(resolveDesktopStaticFile(publicRoot, "/docs")).toBe(path.join(publicRoot, "docs", "index.html"));
    expect(resolveDesktopStaticFile(publicRoot, "/docs/")).toBe(path.join(publicRoot, "docs", "index.html"));
    expect(resolveDesktopStaticFile(publicRoot, "/docs/config.html")).toBeNull();
    expect(resolveDesktopStaticFile(publicRoot, "/assets/src/main.js")).toBeNull();
    expect(resolveDesktopStaticFile(publicRoot, "/assets/styles/components/desktop-settings.css")).toBe(
      path.join(publicRoot, "assets", "styles", "components", "desktop-settings.css"),
    );
  });

  test("leaves non-static and path traversal requests unresolved", () => {
    expect(resolveDesktopStaticFile(publicRoot, "/api/sessions")).toBeNull();
    expect(resolveDesktopStaticFile(publicRoot, "/webui/bootstrap")).toBeNull();
    expect(resolveDesktopStaticFile(publicRoot, "/assets/../index.html")).toBeNull();
  });

  test("identifies source tests for bundle exclusion", () => {
    expect(isSourceTestFile(path.join(publicRoot, "assets", "src", "provider-cards.test.mjs"))).toBe(true);
    expect(isSourceTestFile(path.join(publicRoot, "assets", "src", "agent-ui-events.test.js"))).toBe(true);
    expect(isSourceTestFile(path.join(publicRoot, "assets", "styles", "main.css"))).toBe(false);
  });

  test("serves core WebUI content types", () => {
    expect(contentType("docs/index.html")).toBe("text/html; charset=utf-8");
    expect(contentType("assets/styles/main.css")).toBe("text/css; charset=utf-8");
    expect(contentType("assets/docs.js")).toBe("text/javascript; charset=utf-8");
    expect(contentType("assets/logo.svg")).toBe("image/svg+xml");
  });

  test("resolves and bundles the docs index with local docs assets", () => {
    const expectedFile = path.join(publicRoot, "docs", "index.html");
    expect(resolveDesktopStaticFile(publicRoot, "/docs")).toBe(expectedFile);
    expect(resolveDesktopStaticFile(publicRoot, "/docs/index.html")).toBe(expectedFile);
    expect(resolveDesktopStaticFile(publicRoot, "/docs/index")).toBe(expectedFile);

    const bundleFiles = collectDesktopStaticBundleFiles(publicRoot).map((file) => file.fileName);
    expect(bundleFiles).toEqual(
      expect.arrayContaining([
        "docs/index.html",
        "assets/styles/components/desktop-settings.css",
        "assets/docs-styles.css",
        "assets/docs.js",
        "assets/logo-mark.svg",
      ]),
    );
    expect(bundleFiles).not.toContain("assets/src/main.js");
    expect(bundleFiles).not.toContain("docs");
    expect(bundleFiles.some((file) => file.startsWith("docs/") && file !== "docs/index.html")).toBe(false);
    expect(bundleFiles.some((file) => /\.test\.[cm]?js$/i.test(file) || /\.test\.mjs$/i.test(file))).toBe(false);
  });
});

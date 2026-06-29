import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  collectWebuiStaticBundleFiles,
  contentType,
  isSourceTestFile,
  resolveWebuiStaticFile,
} from "../vite.config";

const webuiRoot = path.resolve(__dirname, "../../../webui");

describe("desktop WebUI static routing", () => {
  test("resolves docs index and asset routes from the root WebUI", () => {
    expect(resolveWebuiStaticFile(webuiRoot, "/docs")).toBe(path.join(webuiRoot, "docs", "index.html"));
    expect(resolveWebuiStaticFile(webuiRoot, "/docs/")).toBe(path.join(webuiRoot, "docs", "index.html"));
    expect(resolveWebuiStaticFile(webuiRoot, "/docs/config.html")).toBeNull();
    expect(resolveWebuiStaticFile(webuiRoot, "/assets/src/main.js")).toBe(
      path.join(webuiRoot, "assets", "src", "main.js"),
    );
    expect(resolveWebuiStaticFile(webuiRoot, "/assets/styles/components/desktop-settings.css")).toBe(
      path.join(webuiRoot, "assets", "styles", "components", "desktop-settings.css"),
    );
  });

  test("leaves non-static and path traversal requests unresolved", () => {
    expect(resolveWebuiStaticFile(webuiRoot, "/api/sessions")).toBeNull();
    expect(resolveWebuiStaticFile(webuiRoot, "/webui/bootstrap")).toBeNull();
    expect(resolveWebuiStaticFile(webuiRoot, "/assets/../index.html")).toBeNull();
  });

  test("identifies root WebUI source tests for bundle exclusion", () => {
    expect(isSourceTestFile(path.join(webuiRoot, "assets", "src", "provider-cards.test.mjs"))).toBe(true);
    expect(isSourceTestFile(path.join(webuiRoot, "assets", "src", "agent-ui-events.test.js"))).toBe(true);
    expect(isSourceTestFile(path.join(webuiRoot, "assets", "src", "main.js"))).toBe(false);
  });

  test("serves core WebUI content types", () => {
    expect(contentType("docs/index.html")).toBe("text/html; charset=utf-8");
    expect(contentType("assets/styles/main.css")).toBe("text/css; charset=utf-8");
    expect(contentType("assets/src/main.js")).toBe("text/javascript; charset=utf-8");
    expect(contentType("assets/logo.svg")).toBe("image/svg+xml");
  });

  test("resolves and bundles the docs index with local docs assets", () => {
    const expectedFile = path.join(webuiRoot, "docs", "index.html");
    expect(resolveWebuiStaticFile(webuiRoot, "/docs")).toBe(expectedFile);
    expect(resolveWebuiStaticFile(webuiRoot, "/docs/index.html")).toBe(expectedFile);
    expect(resolveWebuiStaticFile(webuiRoot, "/docs/index")).toBe(expectedFile);

    const bundleFiles = collectWebuiStaticBundleFiles(webuiRoot).map((file) => file.fileName);
    expect(bundleFiles).toEqual(
      expect.arrayContaining([
        "docs/index.html",
        "assets/styles.css",
        "assets/styles/components/desktop-settings.css",
        "assets/docs-styles.css",
        "assets/docs.js",
        "assets/logo-mark.svg",
      ]),
    );
    expect(bundleFiles).not.toContain("docs");
    expect(bundleFiles.some((file) => file.startsWith("docs/") && file !== "docs/index.html")).toBe(false);
    expect(bundleFiles.some((file) => /\.test\.[cm]?js$/i.test(file) || /\.test\.mjs$/i.test(file))).toBe(false);
  });
});

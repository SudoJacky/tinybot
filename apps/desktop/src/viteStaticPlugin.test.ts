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
  test("resolves docs and asset routes from the root WebUI", () => {
    expect(resolveWebuiStaticFile(webuiRoot, "/docs")).toBe(path.join(webuiRoot, "docs", "index.html"));
    expect(resolveWebuiStaticFile(webuiRoot, "/docs/")).toBe(path.join(webuiRoot, "docs", "index.html"));
    expect(resolveWebuiStaticFile(webuiRoot, "/docs/config.html")).toBe(
      path.join(webuiRoot, "docs", "config.html"),
    );
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

  test("resolves and bundles every docs page route with local docs assets", () => {
    const docsPages = [
      "cli.html",
      "config.html",
      "gateway.html",
      "index.html",
      "knowledge.html",
      "providers.html",
      "quickstart.html",
      "skills.html",
      "tasks.html",
      "tools.html",
      "webui.html",
    ];

    for (const page of docsPages) {
      const expectedFile = path.join(webuiRoot, "docs", page);
      const routeName = path.basename(page, ".html");
      const extensionlessRoute = routeName === "index" ? "/docs" : `/docs/${routeName}`;

      expect(resolveWebuiStaticFile(webuiRoot, extensionlessRoute)).toBe(expectedFile);
      expect(resolveWebuiStaticFile(webuiRoot, `/docs/${page}`)).toBe(expectedFile);
    }

    const bundleFiles = collectWebuiStaticBundleFiles(webuiRoot).map((file) => file.fileName);
    expect(bundleFiles).toEqual(
      expect.arrayContaining([
        "docs/index.html",
        "docs/quickstart",
        "docs/quickstart.html",
        "assets/styles.css",
        "assets/styles/components/desktop-settings.css",
        "assets/docs-styles.css",
        "assets/docs.js",
        "assets/logo-mark.svg",
      ]),
    );
    expect(bundleFiles).not.toContain("docs");
    expect(bundleFiles.some((file) => /\.test\.[cm]?js$/i.test(file) || /\.test\.mjs$/i.test(file))).toBe(false);
  });
});

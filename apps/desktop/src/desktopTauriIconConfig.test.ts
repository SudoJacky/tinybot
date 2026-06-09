import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("desktop Tauri icon config", () => {
  test("uses the Tinybot icon for the native window and Windows taskbar", () => {
    const config = JSON.parse(readFileSync(resolve(__dirname, "../src-tauri/tauri.conf.json"), "utf8"));

    expect(config.app.windows[0].icon).toBeUndefined();
    expect(config.bundle.icon).toContain("icons/icon.ico");
    expect(readFileSync(resolve(__dirname, "../src-tauri/icons/icon.ico")).byteLength).toBeGreaterThan(0);
  });

  test("rebuilds the native executable when icon assets change", () => {
    const buildScript = readFileSync(resolve(__dirname, "../src-tauri/build.rs"), "utf8");

    expect(buildScript).toContain("cargo:rerun-if-changed=tauri.conf.json");
    expect(buildScript).toContain("cargo:rerun-if-changed=icons/icon.ico");
    expect(buildScript).toContain("cargo:rerun-if-changed=icons/32x32.png");
    expect(buildScript).toContain("cargo:rerun-if-changed=icons/128x128.png");
  });
});

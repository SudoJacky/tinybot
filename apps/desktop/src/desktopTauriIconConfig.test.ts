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
});

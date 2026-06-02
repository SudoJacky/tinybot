import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));
const bootstrapSource = readFileSync(resolve(currentDir, "desktopBootstrap.ts"), "utf8");

function callPosition(call: string): number {
  const position = bootstrapSource.indexOf(call);
  expect(position).toBeGreaterThanOrEqual(0);
  return position;
}

describe("desktop root WebUI bootstrap order", () => {
  test("lets the WebUI entry bind its original DOM before installing the desktop root adapter", () => {
    const shellPosition = callPosition("installWebUiShell(webUiHtml);");
    const webUiEntryPosition = callPosition("await import(/* @vite-ignore */ WEBUI_ENTRY);");
    const rootAdapterPosition = callPosition("installDesktopRootWebUiWorkbenchAdapter();");

    expect(webUiEntryPosition).toBeGreaterThan(shellPosition);
    expect(webUiEntryPosition).toBeLessThan(rootAdapterPosition);
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("desktop workbench shell static Vue imports", () => {
  test("statically imports the tools and skills pane island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountToolsSkillsPaneIsland } from "./native-vue/toolsSkillsPaneIsland";');
    expect(source).not.toContain('void import("./native-vue/toolsSkillsPaneIsland")');
  });
});

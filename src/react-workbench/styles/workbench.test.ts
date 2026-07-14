import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const stylesheet = readFileSync(new URL("./workbench.css", import.meta.url), "utf8");

describe("workbench CSS interaction contracts", () => {
  test("keeps the TinyOS backdrop translucent while it is hovered or focused", () => {
    const backdropInteractionRule = stylesheet.match(
      /button\.tinyos-overlay-backdrop:hover,\s*button\.tinyos-overlay-backdrop:focus-visible\s*\{([^}]+)\}/,
    );

    expect(backdropInteractionRule?.[1]).toContain("background: rgb(20 20 19 / 18%)");
  });
});

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

  test("keeps TinyOS shell overlays compact and removes non-essential reduced-motion transitions", () => {
    expect(stylesheet).toContain("@container (max-width: 520px)");
    expect(stylesheet).toContain(".tinyos-shell-overlay");
    expect(stylesheet).toContain("max-height: calc(100% - 8px)");
    expect(stylesheet).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(stylesheet).toContain("@media (prefers-reduced-motion: reduce)");
    expect(stylesheet).toContain("animation-duration: 1ms !important");
    expect(stylesheet).toContain("transition-duration: 0ms !important");
  });
});

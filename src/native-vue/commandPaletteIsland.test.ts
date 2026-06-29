// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountCommandPaletteIsland } from "./commandPaletteIsland";

describe("command palette Vue island", () => {
  test("renders the hidden command palette shell", () => {
    const host = document.createElement("section");

    const mounted = mountCommandPaletteIsland(host);

    expect(host.getAttribute("data-desktop-vue-island")).toBe("command-palette");
    expect(host.id).toBe("desktop-command-palette");
    expect(host.className).toBe("desktop-command-palette");
    expect(host.getAttribute("role")).toBe("dialog");
    expect(host.getAttribute("aria-modal")).toBe("false");
    expect(host.getAttribute("aria-label")).toBe("Command palette");
    expect(host.hidden).toBe(true);
    expect(host.querySelector("h2")?.textContent).toBe("Command Palette");

    const close = host.querySelector<HTMLButtonElement>("#desktop-command-palette-close");
    expect(close?.getAttribute("type")).toBe("button");
    expect(close?.className).toBe("desktop-command-palette-close");
    expect(close?.getAttribute("aria-label")).toBe("Close command palette");
    expect(close?.textContent).toBe("Close");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders search input, results region, and status", () => {
    const host = document.createElement("section");

    mountCommandPaletteIsland(host);

    const input = host.querySelector<HTMLInputElement>("#desktop-command-palette-input");
    expect(input?.className).toBe("desktop-command-palette-input");
    expect(input?.getAttribute("type")).toBe("search");
    expect(input?.getAttribute("aria-label")).toBe("Search commands and workbench data");
    expect(input?.getAttribute("placeholder")).toBe("Search commands, sessions, files, knowledge, tools, skills, Cowork");

    const results = host.querySelector("#desktop-command-palette-results");
    expect(results?.className).toBe("desktop-command-palette-results");
    expect(results?.getAttribute("aria-live")).toBe("polite");
    expect(host.querySelector("#desktop-command-palette-status")?.textContent).toBe("Type to search.");
  });
});

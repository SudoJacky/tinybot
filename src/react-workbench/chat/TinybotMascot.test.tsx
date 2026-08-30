// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { projectTinybotMascotMood, TinybotMascot } from "./TinybotMascot";

describe("TinybotMascot", () => {
  it.each([
    [{ responding: false }, "calm"],
    [{ responding: false, turnStatus: "awaiting_user" as const }, "curious"],
    [{ responding: true, turnStatus: "running" as const }, "working"],
    [{ responding: false, turnStatus: "failed" as const }, "angry"],
    [{ responding: false, turnStatus: "interrupted" as const }, "angry"],
    [{ responding: false, turnStatus: "completed" as const }, "pleased"],
  ])("projects %o to the %s mood", (state, expectedMood) => {
    expect(projectTinybotMascotMood(state)).toBe(expectedMood);
  });

  it("keeps the logo geometry and exposes the current state accessibly", () => {
    const { container } = render(<TinybotMascot label="Tinybot is working" mood="working" />);
    const mascot = screen.getByRole("img", { name: "Tinybot is working" });

    expect(mascot.getAttribute("data-mood")).toBe("working");
    expect(mascot.getAttribute("data-appearance")).toBe("dimensional");
    expect(container.querySelectorAll("circle")).toHaveLength(4);
    expect(container.querySelector(".react-tinybot-mascot__core")?.getAttribute("r")).toBe("15.5");
    expect(container.querySelector(".react-tinybot-mascot__core")?.getAttribute("style")).toContain("url(#tinybot-");
  });

  it("keeps classic fills flat and gives each dimensional mascot unique paint definitions", () => {
    const { container } = render(
      <>
        <TinybotMascot appearance="classic" label="Classic Tinybot" mood="calm" />
        <TinybotMascot appearance="dimensional" label="Dimensional Tinybot" mood="calm" />
        <TinybotMascot appearance="dimensional" label="Another Tinybot" mood="calm" />
      </>,
    );
    const mascots = Array.from(container.querySelectorAll(".react-tinybot-mascot"));
    const classicCore = mascots[0].querySelector(".react-tinybot-mascot__core");
    const dimensionalCores = mascots.slice(1).map((mascot) => (
      mascot.querySelector(".react-tinybot-mascot__core")?.getAttribute("style")
    ));

    expect(classicCore?.getAttribute("style")).toBeNull();
    expect(container.querySelectorAll("radialGradient")).toHaveLength(8);
    expect(dimensionalCores[0]).not.toBe(dimensionalCores[1]);
  });

  it("provides a reduced-motion fallback for every moving part", () => {
    const css = readFileSync("src/react-workbench/chat/TinybotMascot.css", "utf8");

    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none !important");
    expect(css).toContain("transition: none !important");
  });
});

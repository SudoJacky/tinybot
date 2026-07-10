// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantMarkdown } from "./AssistantMarkdown";

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: mocks.openUrl,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AssistantMarkdown", () => {
  it("repairs incomplete Markdown and animates only while streaming", async () => {
    const { container, rerender } = render(<AssistantMarkdown streaming text="Checking **the current state" />);

    expect(container.querySelector("strong")?.textContent).toBe("the current state");
    expect(container.querySelector("[data-sd-animate]")).toBeTruthy();

    rerender(<AssistantMarkdown streaming={false} text="Checking **the current state**" />);

    expect(container.querySelector("strong")?.textContent).toBe("the current state");
    await waitFor(() => expect(container.querySelector("[data-sd-animate]")).toBeNull());
  });

  it("renders common technical Markdown and CJK-adjacent emphasis", async () => {
    const { container } = render(
      <AssistantMarkdown
        streaming={false}
        text={'## 结果\n\n这是**重要**，请检查。\n\n- 第一项\n- 第二项\n\n| 名称 | 状态 |\n| --- | --- |\n| API | 正常 |\n\n```ts\nconst ok = true;\n```'}
      />,
    );

    expect(screen.getByRole("heading", { name: "结果" })).toBeTruthy();
    expect(screen.getByText("重要", { selector: "strong" })).toBeTruthy();
    expect(screen.getByRole("list")).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    await waitFor(() => expect(container.querySelector('[data-streamdown="code-block"]')).toBeTruthy());
    expect(screen.getByText("const ok = true;")).toBeTruthy();
  });

  it("skips raw HTML and remote images", () => {
    const { container } = render(
      <AssistantMarkdown
        streaming={false}
        text={'<script>window.compromised = true</script>\n\n![tracking](https://example.com/tracker.png)'}
      />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("opens allowed links through Tauri and disables unsafe links", async () => {
    const { container } = render(
      <AssistantMarkdown
        streaming={false}
        text={'[Open docs](https://example.com/docs) [Local file](file:///tmp/private.txt) [Relative](./private.txt)'}
      />,
    );

    const allowedLink = screen.getByRole("link", { name: "Open docs" });
    fireEvent.click(allowedLink);
    await waitFor(() => expect(mocks.openUrl).toHaveBeenCalledWith("https://example.com/docs"));

    expect(container.querySelector('a[href^="file:"]')).toBeNull();
    expect(container.querySelector('a[href^="./"]')).toBeNull();
    expect(screen.queryByRole("link", { name: "Local file" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Relative" })).toBeNull();
  });
});

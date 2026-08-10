// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ToolActivityItem } from "./ToolActivityItem";

afterEach(cleanup);

describe("ToolActivityItem", () => {
  it("renders a completed command as two expandable preview blocks", async () => {
    const user = userEvent.setup();
    render(<ToolActivityItem
      status="completed"
      toolCall={{
        argsJson: { command: "npm test" },
        durationMs: 2_400,
        id: "command-1",
        name: "exec_command",
        resultJson: { exitCode: 0, stdout: "> vitest run\n248 tests passed" },
      }}
    />);

    expect(screen.getByText("Ran npm test")).toBeTruthy();
    expect(screen.getByText("Terminal · 2.4s")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText("$", { selector: ".react-tool-activity__prompt" })).toBeTruthy();
    expect(screen.getByText(/248 tests passed/)).toBeTruthy();
    expect(document.querySelectorAll(".react-tool-activity__preview")).toHaveLength(2);

    const toggle = screen.getByRole("button", { name: "Toggle details for Ran npm test" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("tool-activity-details").hasAttribute("hidden")).toBe(true);
  });

  it("extracts retained command chunks without rendering raw result JSON", () => {
    render(<ToolActivityItem
      status="completed"
      toolCall={{
        argsJson: { command: "npm test" },
        id: "command-chunks",
        name: "exec_command",
        resultJson: {
          chunks: [
            { content: "Test Files  3 passed (3)\n", sequence: 1, stream: "stdout" },
            { content: "Tests  107 passed (107)", sequence: 2, stream: "stdout" },
          ],
        },
        resultPreview: '{"chunks":[{"content":"duplicate"}]}',
      }}
    />);

    expect(screen.getByText(/Test Files\s+3 passed/)).toBeTruthy();
    expect(screen.getByText(/Tests\s+107 passed/)).toBeTruthy();
    expect(screen.queryByText(/"chunks"/)).toBeNull();
  });

  it("renders a file path and line-numbered file preview", () => {
    render(<ToolActivityItem
      status="completed"
      toolCall={{
        argsJson: { endLine: 42, path: "src/react-workbench/chat/ChatPage.tsx", startLine: 40 },
        durationMs: 320,
        id: "file-1",
        name: "workspace.read_file",
        resultPreview: "const value = 1;\nexport { value };",
      }}
    />);

    expect(screen.getByText("Inspected ChatPage.tsx")).toBeTruthy();
    expect(screen.getByText("src/react-workbench/chat/ChatPage.tsx")).toBeTruthy();
    expect(screen.getByText("Lines 40–42")).toBeTruthy();
    expect(screen.getByText("40")).toBeTruthy();
    expect(screen.getByText("41")).toBeTruthy();
  });

  it("keeps web tools collapsed until requested", async () => {
    const user = userEvent.setup();
    render(<ToolActivityItem
      status="completed"
      toolCall={{
        argsJson: { url: "https://learn.microsoft.com/microsoft-edge/webview2/" },
        durationMs: 1_100,
        id: "web-1",
        name: "web.open",
        resultJson: { title: "WebView2 APIs", url: "https://learn.microsoft.com/microsoft-edge/webview2/" },
        resultPreview: "Reviewed the composition controller APIs.",
      }}
    />);

    expect(screen.getByText("Opened WebView2 APIs")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Toggle details for Opened WebView2 APIs" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("tool-activity-details").hasAttribute("hidden")).toBe(true);
    await user.click(toggle);
    expect(screen.getByText("Reviewed the composition controller APIs.")).toBeTruthy();
  });

  it("surfaces failed command output without raw result JSON", () => {
    render(<ToolActivityItem
      status="failed"
      toolCall={{
        argsJson: { command: "cargo check" },
        id: "command-failed",
        name: "exec_command",
        resultJson: { exitCode: 1, stderr: "error[E0308]: mismatched types" },
        resultPreview: "{\"stderr\":\"error[E0308]\"}",
      }}
    />);

    expect(screen.getByText("Command failed")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("error[E0308]: mismatched types")).toBeTruthy();
    expect(screen.queryByText(/\{\"stderr\"/)).toBeNull();
  });

  it("labels a failed data view publication as failed", () => {
    render(<ToolActivityItem
      status="failed"
      toolCall={{
        argsJson: {},
        id: "data-view-failed",
        name: "publish_data_view",
        resultPreview: "data_view_invalid_shape: missing field insight",
      }}
    />);

    expect(screen.getByText("Data view publication failed")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
  });
});

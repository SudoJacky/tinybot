// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { saveComposerRichText } from "../../app-core/settings/composerPreferences";
import { ClaudeStyleAiInput, type ClaudeStyleAiInputProps } from "./claude-style-ai-input";

beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); window.localStorage.clear(); });

function paste(input: HTMLElement, text: string, files: File[] = []) {
  act(() => input.focus());
  fireEvent.paste(input, { clipboardData: { files, getData: (format: string) => format === "text/plain" ? text : "" } });
}

function Draft(props: ClaudeStyleAiInputProps) {
  const [value, setValue] = useState(props.value ?? "");
  const [skills, setSkills] = useState<string[]>([]);
  return <ClaudeStyleAiInput {...props} value={value} onValueChange={setValue}
    selectedSkillIds={skills} onAddSkill={(id) => setSkills((current) => [...current, id])}
    onRemoveSkill={(id) => setSkills((current) => current.filter((skill) => skill !== id))}
    onClearSkills={() => setSkills([])} />;
}

describe("rich text composer", () => {
  it("joins successive pastes at the caret and preserves literal prompt tags and image references", async () => {
    const send = vi.fn();
    render(<Draft onSendMessage={send} />);
    const editor = await screen.findByRole("textbox", { name: "Message" });
    paste(editor, "Before ");
    paste(editor, "**中文**");
    paste(editor, " after");
    expect(editor.querySelectorAll("p")).toHaveLength(1);
    expect(editor.textContent).toBe("Before 中文 after");
    expect(editor.querySelector("strong")?.textContent).toBe("中文");
    paste(editor, "\n\n<request>保留提示</request>\n\n![示意图](https://example.com/image.png)");
    expect(editor.textContent).toContain("<request>保留提示</request>");
    expect(editor.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send.mock.calls[0][0]).toContain("![示意图](https://example.com/image.png)");
  });

  it("reacts to preference changes from another window", async () => {
    render(<Draft value="## Draft" />);
    expect((await screen.findByRole("textbox", { name: "Message" })).querySelector("h2")).toBeTruthy();
    act(() => {
      window.localStorage.setItem("tinybot.ui.composer.rich-text", "false");
      window.dispatchEvent(new StorageEvent("storage", { key: "tinybot.ui.composer.rich-text", newValue: "false" }));
    });
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("## Draft");
  });

  it("defaults to editable Markdown and preserves a draft across setting changes", async () => {
    const source = "# 标题\n\n**加粗**与 `code`\n\n- 第一项\n- 第二项\n\n| 商品 | 金额 |\n| --- | --- |\n| 书 | 123 |";
    render(<Draft value={source} />);
    const editor = await screen.findByRole("textbox", { name: "Message" });
    expect(editor.getAttribute("contenteditable")).toBe("true");
    expect(editor.querySelector("h1")?.textContent).toBe("标题");
    expect(editor.querySelector("strong")?.textContent).toBe("加粗");
    expect(editor.querySelectorAll("li")).toHaveLength(2);
    expect(editor.querySelector("table")?.textContent).toContain("123");
    act(() => saveComposerRichText(false));
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(source);
    act(() => saveComposerRichText(true));
    expect((await screen.findByRole("textbox", { name: "Message" })).querySelector("table")).toBeTruthy();
  });

  it("parses a full Markdown paste and sends Markdown without an extra paste heading", async () => {
    const send = vi.fn();
    render(<Draft onSendMessage={send} />);
    const editor = await screen.findByRole("textbox", { name: "Message" });
    paste(editor, "## 计划\n\n**完整内容**\n\n| 项目 | 金额 |\n| --- | --- |\n| 中文_A | 123 |\n\n```ts\nconst a = 1;\n```\n\n- [x] 完成");
    expect(editor.querySelector("h2")?.textContent).toBe("计划");
    expect(editor.querySelector("table")?.textContent).toContain("中文_A");
    expect(editor.querySelector("pre")?.textContent).toBe("const a = 1;");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send.mock.calls[0][0]).toContain("## 计划");
    expect(send.mock.calls[0][0]).toContain("**完整内容**");
    expect(send.mock.calls[0][0]).toContain("中文\\_A");
    expect(send.mock.calls[0][0]).toContain("- [x] 完成");
    expect(send.mock.calls[0][0]).not.toContain("Pasted content:");
    await waitFor(() => expect(editor.textContent).toBe(""));
  });

  it("keeps composition Enter from sending and uses Shift+Enter for new blocks", async () => {
    const send = vi.fn();
    render(<Draft value="Hello" onSendMessage={send} />);
    const editor = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.keyDown(editor, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(editor.querySelectorAll("p").length).toBeGreaterThan(1);
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
  });

  it("imports clipboard files through the existing attachment pipeline", async () => {
    const importFiles = vi.fn(async () => [{ name: "note.md", path: "/note.md", mimeType: "text/markdown", sizeBytes: 3 }]);
    render(<Draft onImportFiles={importFiles} />);
    const file = new File(["abc"], "note.md", { type: "text/markdown" });
    paste(await screen.findByRole("textbox", { name: "Message" }), "", [file]);
    await waitFor(() => expect(importFiles).toHaveBeenCalledWith([file]));
    expect(await screen.findByRole("button", { name: "Remove note.md" })).toBeTruthy();
  });

  it("replaces a slash query with an atomic skill without leaking it into the sent text", async () => {
    const send = vi.fn();
    render(<Draft onSendMessage={send} skillOptions={[{ id: "design", label: "Design", description: "Design a page", sourceLabel: "Workspace" }]} />);
    const editor = await screen.findByRole("textbox", { name: "Message" });
    paste(editor, "/");
    paste(editor, "des");
    expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeTruthy();
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(await screen.findByRole("button", { name: "Remove Design" })).toBeTruthy();
    expect(editor.textContent).not.toContain("/des");
    paste(editor, "Build a page");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send.mock.calls[0][0]).toBe("Build a page");
  });
});

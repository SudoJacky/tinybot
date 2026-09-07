// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatPageUnderTest as ChatPage, createStores } from "./test/ChatPageTestHarness";
import { timelineFromReactMessages } from "./test/timelineFixtures";

vi.mock("docx-preview", () => ({ renderAsync: async (_bytes: ArrayBuffer, host: HTMLElement) => {
  host.innerHTML = "<p>Project goal</p><p>Improve customer retention</p>";
} }));
vi.mock("pptx-preview", () => ({ init: (host: HTMLElement) => ({ destroy: () => host.replaceChildren(), preview: async () => {
  host.innerHTML = '<div class="pptx-preview-wrapper"><div class="pptx-preview-slide-wrapper"><p>Project goal</p></div></div>';
} }) }));

function setup(extension: "docx" | "pptx") {
  const stores = createStores({ sessions: [{ id: "s1", chatId: "chat-1", title: "Files", updatedAtMs: 1, status: "idle", workingDirectory: "D:\\work" }] });
  stores.chatStore.load = vi.fn(async (id) => timelineFromReactMessages(id, [{ id: "file", role: "assistant", createdAtMs: 1, status: "complete", text: `Open [brief](brief.${extension}).` }]));
  const artifactReviews = { prepare: vi.fn().mockResolvedValue({}), load: vi.fn().mockResolvedValue(null), compare: vi.fn(), resolve: vi.fn() };
  render(<ChatPage chatStore={stores.chatStore} sessionStore={stores.sessionStore} workspaceStore={{ artifactReviews,
    readThreadFile: vi.fn().mockResolvedValue({ path: `brief.${extension}`, contentType: "binary", revision: "viewed-v1", sizeBytes: 4 }),
    readThreadFileBytes: vi.fn().mockResolvedValue(new Uint8Array([80, 75, 3, 4])),
  }} />);
  return { ...stores, artifactReviews };
}

describe("Office selection to chat", () => {
  it("sends Word text and preview position through the protected file edit workflow", async () => {
    const stores = setup("docx");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "brief" }));
    const paragraph = await screen.findByText("Improve customer retention");
    await screen.findByText("Select text to request a change");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    await user.click(await screen.findByRole("button", { name: "Ask for change" }));
    await user.type(screen.getByRole("textbox", { name: "Change request for selected content" }), "Make the goal measurable");
    await user.click(screen.getByRole("button", { name: "Add change request" }));
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(stores.chatStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ references: [expect.objectContaining({ referenceKind: "file", sourcePath: "brief.docx", revision: "viewed-v1", sourceText: expect.stringContaining("Word preview paragraphs: 2") })] }) })));
    const reference = vi.mocked(stores.chatStore.dispatch).mock.calls[0][0];
    expect(JSON.stringify(reference)).toContain("Make the goal measurable");
    expect(JSON.stringify(reference)).toContain("Improve customer retention");
    expect(stores.artifactReviews.prepare).toHaveBeenCalledWith(expect.objectContaining({ path: "brief.docx", threadId: "s1", expectedRevision: "viewed-v1" }));
    expect(stores.artifactReviews.prepare.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(stores.chatStore.dispatch).mock.invocationCallOrder[0]);
  });
  it("submits an entire PowerPoint slide with its position and source revision", async () => {
    const stores = setup("pptx");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "brief" }));
    await user.click(await screen.findByRole("button", { name: "Change slide 1" }));
    await user.type(screen.getByRole("textbox", { name: "Change request for selected content" }), "Simplify this slide");
    await user.click(screen.getByRole("button", { name: "Add change request" }));
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(stores.artifactReviews.prepare).toHaveBeenCalledWith(expect.objectContaining({ path: "brief.pptx", expectedRevision: "viewed-v1" })));
    await waitFor(() => expect(stores.chatStore.dispatch).toHaveBeenCalled());
    expect(JSON.stringify(vi.mocked(stores.chatStore.dispatch).mock.calls[0][0])).toContain("PowerPoint slides: 1");
  });
});

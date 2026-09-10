// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatPageUnderTest as ChatPage, createStores } from "./test/ChatPageTestHarness";
import { timelineFromReactMessages } from "./test/timelineFixtures";

function setup(href = "report.md", workingDirectory = "D:\\work") {
  const stores = createStores({ sessions: [{ id: "s1", chatId: "chat-1", title: "Files", updatedAtMs: 1, status: "idle", workingDirectory }] });
  stores.chatStore.load = vi.fn(async (id) => timelineFromReactMessages(id, [{
    id: "file-message", role: "assistant", createdAtMs: 1, status: "complete",
    text: `Open [report](${href}).`,
  }]));
  let revision = "v1";
  let content = "# Original report";
  const readThreadFile = vi.fn(async () => ({ path: "report.md", revision, content, contentType: "text" as const, sizeBytes: content.length }));
  const artifactReviews = { prepare: vi.fn().mockResolvedValue({}), load: vi.fn().mockResolvedValue(null), compare: vi.fn(), resolve: vi.fn() };
  const view = render(<ChatPage chatStore={stores.chatStore} sessionStore={stores.sessionStore} workspaceStore={{ readThreadFile, artifactReviews }} />);
  return { ...stores, ...view, readThreadFile, artifactReviews, change: () => { revision = "v2"; content = "# Updated report"; } };
}

describe("Artifact collaboration", () => {
  it("opens CSV as a table, refreshes it, and references the viewed source revision", async () => {
    const user = userEvent.setup();
    const stores = createStores();
    stores.chatStore.load = vi.fn(async (id) => timelineFromReactMessages(id, [{
      id: "csv-message", role: "assistant", createdAtMs: 1, status: "complete", text: "[repos.csv](repos.csv)",
    }]));
    let revision = "csv-v1";
    let content = "Repository,Stars\nAutoGPT,187218";
    const readThreadFile = vi.fn(async () => ({ path: "repos.csv", revision, content, contentType: "text" as const, sizeBytes: content.length }));
    render(<ChatPage chatStore={stores.chatStore} sessionStore={stores.sessionStore} workspaceStore={{ readThreadFile, artifactReviews: { prepare: vi.fn().mockResolvedValue({}), load: vi.fn().mockResolvedValue(null), compare: vi.fn(), resolve: vi.fn() } }} />);
    await user.click(await screen.findByRole("link", { name: "repos.csv" }));
    expect(within(await screen.findByRole("table", { name: "repos.csv" })).getByText("187218")).toBeTruthy();
    content = "Repository,Stars\nAutoGPT,187219";
    revision = "csv-v2";
    fireEvent.focus(window);
    await screen.findByText("187219");
    await user.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByLabelText("repos.csv", { selector: "pre" }).textContent).toBe(content);
    await user.click(screen.getByRole("button", { name: "Reference in chat" }));
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Explain this data");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(stores.chatStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ references: [expect.objectContaining({ sourcePath: "repos.csv", revision: "csv-v2", sourceText: expect.stringContaining(content) })] }),
    })));
  });


  it("opens a report's sibling PPT relative to the displayed Markdown file", async () => {
    const user = userEvent.setup();
    const root = "C:/Users/viewer/.tinybot/workspace";
    const report = `${root}/github-agent-report/report.md`;
    const ppt = `${root}/github-agent-report/github_agent_projects.pptx`;
    const stores = createStores({ sessions: [{ id: "s1", chatId: "chat-1", title: "Files", updatedAtMs: 1, status: "idle", workingDirectory: "" }] });
    stores.chatStore.load = vi.fn(async (id) => timelineFromReactMessages(id, [{
      id: "file-message", role: "assistant", createdAtMs: 1, status: "complete",
      text: `Open [report](${report}).`,
    }]));
    const readThreadFile = vi.fn(async ({ path }: { path: string }) => {
      if (path === report) return { path, revision: "v1", content: "[Download PPT](./github_agent_projects.pptx)", contentType: "text" as const, sizeBytes: 55 };
      if (path === ppt) return { path, revision: "v2", contentType: "binary" as const, sizeBytes: 158198 };
      throw new Error(`failed to resolve workspace path; path=${root}/${path}`);
    });
    render(<ChatPage chatStore={stores.chatStore} sessionStore={stores.sessionStore} workspaceStore={{ readThreadFile }} />);
    await user.click(await screen.findByRole("link", { name: "report" }));
    await user.click(await screen.findByRole("link", { name: "Download PPT" }));
    await waitFor(() => expect(readThreadFile).toHaveBeenCalledWith({ path: ppt, threadId: "s1" }));
  });

  it("attaches the displayed file and its revision without replacing the draft", async () => {
    const user = userEvent.setup();
    const stores = setup();
    await user.click(await screen.findByRole("link", { name: "report" }));
    await screen.findByRole("heading", { name: "Original report" });
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Explain this report");
    await user.click(screen.getByRole("button", { name: "Reference in chat" }));
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Explain this report");
    expect(within(screen.getByLabelText("Composer attachments")).getByText("report.md")).toBeTruthy();
    stores.change();
    fireEvent.focus(window);
    await screen.findByRole("heading", { name: "Updated report" });
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(stores.chatStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ references: [expect.objectContaining({ sourcePath: "report.md", revision: "v1", referenceKind: "file", sourceText: expect.stringContaining("Original report") })] }),
    })));
    expect(stores.artifactReviews.prepare).toHaveBeenCalledWith(expect.objectContaining({ path: "report.md", threadId: "s1", expectedRevision: "v1" }));
    expect(stores.artifactReviews.prepare.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(stores.chatStore.dispatch).mock.invocationCallOrder[0]);
  });

  it("retains the request and blocks dispatch when saving the original fails", async () => {
    const user = userEvent.setup();
    const stores = setup();
    stores.artifactReviews.prepare.mockRejectedValue(new Error("File changed since viewing; reference it again"));
    await user.click(await screen.findByRole("link", { name: "report" }));
    await screen.findByRole("heading", { name: "Original report" });
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Update report");
    await user.click(screen.getByRole("button", { name: "Reference in chat" }));
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText(/File changed since viewing/);
    expect(stores.chatStore.dispatch).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Update report");
  });

  it("passes an intact absolute Windows file path from Markdown to the native reader", async () => {
    const user = userEvent.setup();
    const stores = setup(String.raw`C:\Users\viewer\.tinybot\workspace\report.md`, "");
    await user.click(await screen.findByRole("link", { name: "report" }));
    await screen.findByRole("heading", { name: "Original report" });
    expect(stores.readThreadFile).toHaveBeenCalledWith({ path: "C:/Users/viewer/.tinybot/workspace/report.md", threadId: "s1" });
  });

  it("refreshes changed local files on focus and leaves closed tabs closed", async () => {
    const user = userEvent.setup();
    const stores = setup();
    await user.click(await screen.findByRole("link", { name: "report" }));
    await screen.findByRole("heading", { name: "Original report" });
    stores.change();
    fireEvent.focus(window);
    await screen.findByRole("heading", { name: "Updated report" });
    expect(stores.readThreadFile).toHaveBeenLastCalledWith({ path: "report.md", threadId: "s1", knownRevision: "v1" });
    await user.click(screen.getByRole("button", { name: "Close report.md tab" }));
    const calls = stores.readThreadFile.mock.calls.length;
    await act(async () => { fireEvent.focus(window); });
    expect(stores.readThreadFile).toHaveBeenCalledTimes(calls);
    expect(screen.queryByRole("heading", { name: "Updated report" })).toBeNull();
  });
});

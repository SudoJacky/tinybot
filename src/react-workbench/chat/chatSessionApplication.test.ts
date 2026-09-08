import { describe, expect, it, vi } from "vitest";
import type { SessionStore, SessionSummary } from "../services";
import { createChatSessionApplication } from "./chatSessionApplication";

const session = (id: string, title = "New chat"): SessionSummary => ({ id, chatId: id, title, status: "idle", updatedAtMs: 1 });
function setup() {
  const store: SessionStore = {
    list: vi.fn(async () => []), create: vi.fn(async () => session("s1")),
    rename: vi.fn(async () => {}), delete: vi.fn(async () => {}), archive: vi.fn(async () => {}), pin: vi.fn(async () => {}),
  };
  return { store, application: createChatSessionApplication(store, () => 1) };
}

describe("Chat session application", () => {
  it("deduplicates materialization per draft without sharing another draft's creation", async () => {
    const { store, application } = setup();
    let complete!: (value: SessionSummary) => void;
    vi.mocked(store.create).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const first = application.createDraft({ workingDirectory: "D:/first" });
    const second = application.createDraft({ workingDirectory: "D:/second" });
    const pending = application.materializeDraft(first.id, first, { model: "chosen" });
    expect(application.materializeDraft(first.id, first, {})).toBe(pending);
    await application.materializeDraft(second.id, second, {});
    expect(store.create).toHaveBeenCalledTimes(2);
    expect(application.snapshot().creating).toBe(true);
    complete(session("first"));
    await pending;
    expect(application.snapshot().creating).toBe(false);
    expect(application.snapshot().sessions.map((value) => value.id)).toEqual(["first", "s1"]);
  });

  it("reconciles an optimistic session ID and title with the persisted session", async () => {
    const { store, application } = setup();
    const changed = vi.fn();
    application.onChange(changed);
    application.accept(session("temporary"));
    application.preview(session("temporary", "First prompt"));
    vi.mocked(store.list).mockResolvedValue([session("persisted")]);
    await application.refresh();
    expect(application.snapshot().sessions).toMatchObject([{ id: "persisted", title: "First prompt" }]);
    expect(changed).toHaveBeenCalledWith({ type: "replaced", previousSessionId: "temporary", sessionId: "persisted" });
    await application.rename("persisted", "Renamed");
    vi.mocked(store.list).mockResolvedValue([session("persisted", "Renamed")]);
    await application.refresh();
    expect(application.snapshot().sessions[0].title).toBe("Renamed");
  });

  it("reports deletion with the removed row so presentation can finish its animation independently", async () => {
    const { application } = setup();
    const removed = session("s1", "Deleting");
    application.accept(removed);
    const changed = vi.fn();
    application.onChange(changed);
    await application.delete(removed);
    expect(application.snapshot().sessions).toEqual([]);
    expect(changed).toHaveBeenCalledWith({ type: "removed", session: removed, reason: "delete" });
  });

  it("retains creation errors and releases pending state for an explicit retry", async () => {
    const { store, application } = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(store.create).mockRejectedValueOnce(new Error("workspace missing"));
    const draft = application.createDraft({ workingDirectory: "Z:/missing" });
    await expect(application.materializeDraft(draft.id, draft, {})).rejects.toThrow("workspace missing");
    expect(application.snapshot()).toMatchObject({ creating: false, error: "workspace missing" });
    await application.materializeDraft(draft.id, draft, {});
    expect(application.snapshot()).toMatchObject({ creating: false, error: "" });
    log.mockRestore();
  });
});

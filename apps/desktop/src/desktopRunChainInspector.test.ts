import { describe, expect, test } from "vitest";
import {
  buildDesktopMemoryReferenceView,
  buildDesktopRunChainItems,
  buildDesktopRunChainSummary,
  createDesktopRunChainInspectorView,
  resolveDesktopMemoryHighlightLine,
} from "./desktopRunChainInspector";

describe("desktop run-chain inspector helpers", () => {
  test("projects reasoning and tool-call response pairs into inspectable run-chain items", () => {
    const items = buildDesktopRunChainItems([
      {
        role: "assistant",
        message_id: "m-plan",
        reasoning_content: "Look at the workspace before editing.",
      },
      {
        role: "assistant",
        message_id: "m-tools",
        tool_calls: [
          {
            id: "call-read",
            function: {
              name: "read_file",
              arguments: "{\"path\":\"README.md\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-read",
        name: "read_file",
        content: "README contents",
      },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "planning",
      title: "Planning",
      preview: "Look at the workspace before editing.",
      detailSubtitle: "Thinking trace",
    });
    expect(items[1]).toMatchObject({
      key: "m-tools:call-read",
      kind: "tool",
      title: "Read | read_file",
      preview: "README contents",
      status: "completed",
      detailSubtitle: "Tool call and response",
    });
    expect(items[1].detailSections).toEqual([
      {
        type: "text",
        label: "Arguments",
        text: "{\n  \"path\": \"README.md\"\n}",
      },
      {
        type: "text",
        label: "Response",
        text: "README contents",
      },
    ]);
    expect(buildDesktopRunChainSummary(items)).toBe("Completed | 2 items | 1 tool | planning");
  });

  test("recognizes browser activity from exec tool commands and exposes browser inspector sections", () => {
    const items = buildDesktopRunChainItems([
      {
        role: "assistant",
        message_id: "m-browser",
        tool_calls: [
          {
            id: "call-browser",
            function: {
              name: "exec",
              arguments: {
                command: "opencli browser open https://example.test",
              },
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-browser",
        name: "exec",
        content: "URL: https://example.test\nTitle: Example\nviewport: 1280x720\n---\nbutton Submit",
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "browser",
      title: "Command | Open",
      preview: "Example | https://example.test | 1280x720",
      detailTitle: "Example",
    });
    expect(items[0].detailSections[0]).toMatchObject({
      type: "browserActivity",
      activity: {
        action: "open",
        actionLabel: "Open",
        url: "https://example.test",
        title: "Example",
        viewport: "1280x720",
        snapshotText: "button Submit",
      },
    });
    expect(items[0].detailSections).toContainEqual({
      type: "text",
      label: "Page snapshot",
      text: "button Submit",
      collapsed: true,
    });
  });

  test("pairs progress tool detail and result messages without requiring root WebUI DOM state", () => {
    const items = buildDesktopRunChainItems([
      {
        role: "progress",
        message_id: "progress-detail",
        _tool_name: "shell_exec",
        _tool_detail: true,
        content: "cargo check",
      },
      {
        role: "progress",
        message_id: "progress-result",
        _tool_name: "shell_exec",
        _tool_result: true,
        content: "Finished dev profile",
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "progress-detail:detail",
      kind: "tool",
      title: "Command | shell_exec",
      preview: "Finished dev profile",
      status: "completed",
      detailSubtitle: "Tool detail and response",
    });
    expect(items[0].detailSections).toEqual([
      {
        type: "text",
        label: "Detail",
        text: "cargo check",
      },
      {
        type: "text",
        label: "Response",
        text: "Finished dev profile",
      },
    ]);
  });

  test("projects citations, references, memory, artifacts, and files into inspectable items", () => {
    const items = buildDesktopRunChainItems([
      {
        role: "assistant",
        message_id: "m-context",
        citations: [
          {
            id: "cite-1",
            title: "Spec citation",
            url: "https://example.test/spec",
            snippet: "Quoted spec",
          },
        ],
        references: [
          {
            id: "ref-1",
            title: "Reference note",
            source: "docs/design.md",
            content: "Reference content",
          },
        ],
        memory_references: [
          {
            view_file: "memory/MEMORY.md",
            view_line: 12,
            note_id: "note-1",
            content: "Remember workspace context",
            scope: "workspace",
          },
        ],
        artifacts: [
          {
            id: "artifact-1",
            title: "Trace artifact",
            path: "outputs/trace.json",
            content: "{\"ok\":true}",
          },
        ],
        file_references: [
          {
            path: "apps/desktop/src/desktopBootstrap.ts",
            line: 42,
            content: "bootDesktopWebUi()",
          },
        ],
      },
    ]);

    expect(items.map((item) => item.kind)).toEqual(["citation", "reference", "memory", "artifact", "file"]);
    expect(items.map((item) => item.title)).toEqual([
      "Citation | Spec citation",
      "Reference | Reference note",
      "Memory | memory/MEMORY.md",
      "Artifact | Trace artifact",
      "File | apps/desktop/src/desktopBootstrap.ts",
    ]);
    expect(items[0]).toMatchObject({
      key: "m-context:citation:cite-1",
      preview: "Quoted spec",
      detailTitle: "Spec citation",
      detailSubtitle: "Citation detail",
      detailSections: [
        { type: "text", label: "URL", text: "https://example.test/spec" },
        { type: "text", label: "Snippet", text: "Quoted spec" },
      ],
    });
    expect(items[2]).toMatchObject({
      key: "m-context:memory:memory/MEMORY.md:12:note-1",
      preview: "Remember workspace context",
      detailTitle: "memory/MEMORY.md",
      detailSubtitle: "Line 12",
    });
    expect(items[4].detailSections).toEqual([
      { type: "text", label: "Location", text: "apps/desktop/src/desktopBootstrap.ts:42" },
      { type: "text", label: "Content", text: "bootDesktopWebUi()" },
    ]);
  });

  test("builds inspector views and memory reference source metadata for stable right-pane mounting", () => {
    const [item] = buildDesktopRunChainItems([
      {
        role: "assistant",
        message_id: "m-plan",
        reasoning_content: "Inspect the run chain",
      },
    ]);
    const inspector = createDesktopRunChainInspectorView(item);

    expect(inspector).toMatchObject({
      title: "Planning",
      subtitle: "Thinking trace",
      emptyText: "No saved detail.",
    });
    expect(inspector.sections).toEqual([
      {
        type: "text",
        label: "Thinking",
        text: "Inspect the run chain",
      },
    ]);

    const reference = buildDesktopMemoryReferenceView({
      view_file: "memory/MEMORY.md",
      view_line: 42,
      note_id: "note-1",
      content: "important source",
      scope: "workspace",
    });

    expect(reference).toEqual({
      key: "memory/MEMORY.md:42:note-1",
      file: "memory/MEMORY.md",
      line: 42,
      locationLabel: "Line 42",
      content: "important source",
      metadata: ["workspace", "note-1"],
    });
    expect(resolveDesktopMemoryHighlightLine("first\nimportant source\nthird", reference.line, reference)).toBe(2);
  });
});

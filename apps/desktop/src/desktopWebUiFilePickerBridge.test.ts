import { describe, expect, test, vi } from "vitest";
import {
  installDesktopWebUiFilePickerBridge,
  selectDesktopFileForWebUiInput,
} from "./desktopWebUiFilePickerBridge";

class FakeDataTransfer {
  private readonly storedFiles: File[] = [];

  public readonly items = {
    add: (file: File) => {
      this.storedFiles.push(file);
    },
  };

  get files(): File[] {
    return this.storedFiles;
  }
}

class FakeElement {
  private readonly listeners = new Map<string, Array<(event: FakeEvent) => unknown>>();

  addEventListener(type: string, handler: (event: FakeEvent) => unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  async emit(type: string, event = new FakeEvent(type)): Promise<FakeEvent> {
    for (const handler of this.listeners.get(type) ?? []) {
      await handler(event);
    }
    return event;
  }
}

class FakeInput extends FakeElement {
  public files: File[] = [];
  public dispatchedEvents: string[] = [];

  dispatchEvent(event: Event): boolean {
    this.dispatchedEvents.push(event.type);
    return true;
  }
}

class FakeEvent {
  public defaultPrevented = false;
  public propagationStopped = false;

  constructor(public readonly type: string) {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true;
  }
}

class FakeDocument {
  constructor(private readonly nodes: Record<string, unknown>) {}

  querySelector(selector: string): unknown {
    return this.nodes[selector] ?? null;
  }
}

const pickedFile = {
  name: "notes.md",
  path: "C:\\Users\\tinybot\\notes.md",
  mime_type: "text/markdown",
  size_bytes: 5,
  bytes: [...new TextEncoder().encode("hello")],
};

describe("desktop WebUI file picker bridge", () => {
  test("assigns a native-picked file to an existing WebUI file input and dispatches change", async () => {
    const input = new FakeInput();

    const selected = await selectDesktopFileForWebUiInput({
      input: input as unknown as HTMLInputElement,
      kind: "knowledge-document",
      pickFile: async () => pickedFile,
      createDataTransfer: () => new FakeDataTransfer() as unknown as DataTransfer,
    });

    expect(selected).toBe(true);
    expect(input.files).toHaveLength(1);
    expect(input.files[0].name).toBe("notes.md");
    expect(input.files[0].type).toBe("text/markdown");
    expect(await input.files[0].text()).toBe("hello");
    expect(input.dispatchedEvents).toEqual(["change"]);
  });

  test("intercepts WebUI upload buttons and uses target-specific picker options", async () => {
    const sessionButton = new FakeElement();
    const sessionInput = new FakeInput();
    const document = new FakeDocument({
      "#temporary-file-button": sessionButton,
      "#temporary-file-upload": sessionInput,
    });
    const pickFile = vi.fn(async () => pickedFile);

    installDesktopWebUiFilePickerBridge({
      targetDocument: document as unknown as Document,
      pickFile,
      createDataTransfer: () => new FakeDataTransfer() as unknown as DataTransfer,
    });
    const click = await sessionButton.emit("click");

    expect(click.defaultPrevented).toBe(true);
    expect(click.propagationStopped).toBe(true);
    expect(pickFile).toHaveBeenCalledWith(
      "session-temporary-file",
      expect.objectContaining({
        title: "Attach temporary session file",
      }),
    );
    expect(sessionInput.files[0].name).toBe("notes.md");
    expect(sessionInput.dispatchedEvents).toEqual(["change"]);
  });
});

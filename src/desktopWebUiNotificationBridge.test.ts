import { describe, expect, test } from "vitest";
import { installDesktopWebUiNotificationBridge } from "./desktopWebUiNotificationBridge";

class FakeDomNode {
  public readonly children: FakeDomNode[] = [];
  public readonly classList = {
    contains: (className: string) => this.classes.has(className),
  };

  private readonly classes: Set<string>;

  constructor(
    className: string,
    private readonly ownText = "",
    children: FakeDomNode[] = [],
  ) {
    this.classes = new Set(className.split(/\s+/).filter(Boolean));
    this.children.push(...children);
  }

  get textContent(): string {
    return [this.ownText, ...this.children.map((child) => child.textContent)].filter(Boolean).join(" ");
  }

  append(child: FakeDomNode): void {
    this.children.push(child);
  }

  querySelector(selector: string): FakeDomNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeDomNode[] {
    const matches: FakeDomNode[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) {
        matches.push(child);
      }
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  private matches(selector: string): boolean {
    return selector.startsWith(".") && this.classes.has(selector.slice(1));
  }
}

class FakeDocument {
  public readonly body = new FakeDomNode("body");

  querySelectorAll(selector: string): FakeDomNode[] {
    return this.body.querySelectorAll(selector);
  }
}

class FakeObserver {
  public observed = false;

  constructor(private readonly callback: MutationCallback) {}

  observe(): void {
    this.observed = true;
  }

  disconnect(): void {
    this.observed = false;
  }

  async flush(): Promise<void> {
    this.callback([], this as unknown as MutationObserver);
    await Promise.resolve();
  }
}

describe("desktop WebUI notification bridge", () => {
  test("remembers existing approvals and notifies only when a new approval appears", async () => {
    const sent: { title: string; body: string }[] = [];
    const document = new FakeDocument();
    document.body.append(approvalItem("medium / shell", "Existing approval"));
    const observers: FakeObserver[] = [];

    installDesktopWebUiNotificationBridge({
      targetDocument: document as unknown as Document,
      createObserver: (callback) => {
        const observer = new FakeObserver(callback);
        observers.push(observer);
        return observer as unknown as MutationObserver;
      },
      isFocused: () => false,
      canNotify: () => true,
      notify: async (notification) => {
        sent.push(notification);
        return true;
      },
    });
    document.body.append(approvalItem("high / shell", "Run desktop command"));
    const observer = observers[0];
    await observer?.flush();

    expect(observer?.observed).toBe(true);
    expect(sent).toEqual([
      {
        title: "Tinybot approval required",
        body: "Run desktop command - high / shell",
      },
    ]);
  });

  test("notifies WebUI task progress terminal states while the desktop window is unfocused", async () => {
    const sent: { title: string; body: string }[] = [];
    const document = new FakeDocument();
    const observers: FakeObserver[] = [];

    installDesktopWebUiNotificationBridge({
      targetDocument: document as unknown as Document,
      createObserver: (callback) => {
        const observer = new FakeObserver(callback);
        observers.push(observer);
        return observer as unknown as MutationObserver;
      },
      isFocused: () => false,
      canNotify: () => true,
      notify: async (notification) => {
        sent.push(notification);
        return true;
      },
    });
    document.body.append(taskProgressCard("task-progress-failed", "Index notes", "Failed"));
    document.body.append(taskProgressCard("task-progress-completed", "Sync workspace", "Completed"));
    const observer = observers[0];
    await observer?.flush();

    expect(sent).toEqual([
      {
        title: "Tinybot task failed",
        body: "Index notes - Failed",
      },
      {
        title: "Tinybot task completed",
        body: "Sync workspace - Completed",
      },
    ]);
  });
});

function approvalItem(meta: string, summary: string): FakeDomNode {
  return new FakeDomNode("approval-item", "", [
    new FakeDomNode("approval-meta", meta),
    new FakeDomNode("approval-summary", summary),
  ]);
}

function taskProgressCard(statusClass: string, title: string, badge: string): FakeDomNode {
  return new FakeDomNode(`task-progress-card ${statusClass}`, "", [
    new FakeDomNode("task-progress-title", title),
    new FakeDomNode("task-progress-badge", badge),
  ]);
}

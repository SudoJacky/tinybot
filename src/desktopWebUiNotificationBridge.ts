import type { DesktopTaskNotification } from "./desktopTaskNotifications";

export interface DesktopWebUiNotificationBridgeOptions {
  targetDocument?: Document;
  createObserver?: (callback: MutationCallback) => MutationObserver;
  isFocused?: () => boolean;
  canNotify?: () => boolean | Promise<boolean>;
  notify: (notification: DesktopTaskNotification) => boolean | Promise<boolean>;
}

export interface DesktopWebUiNotificationBridge {
  disconnect: () => void;
  refresh: () => Promise<void>;
}

interface WebUiNotificationCandidate {
  key: string;
  notification: DesktopTaskNotification;
}

const TASK_NOTIFICATION_STATES = [
  {
    className: "task-progress-failed",
    title: "Tinybot task failed",
  },
  {
    className: "task-progress-completed",
    title: "Tinybot task completed",
  },
] as const;

export function installDesktopWebUiNotificationBridge({
  targetDocument = document,
  createObserver = (callback) => new MutationObserver(callback),
  isFocused = () => targetDocument.hasFocus(),
  canNotify = () => true,
  notify,
}: DesktopWebUiNotificationBridgeOptions): DesktopWebUiNotificationBridge {
  const observedRoot = targetDocument.body ?? targetDocument.documentElement;
  const seen = new Set<string>();

  const scan = async (rememberOnly = false): Promise<void> => {
    const candidates = collectWebUiNotificationCandidates(targetDocument);
    if (!candidates.length) {
      return;
    }
    const shouldNotify = !rememberOnly && !isFocused() && (await canNotify());
    for (const candidate of candidates) {
      if (seen.has(candidate.key)) {
        continue;
      }
      seen.add(candidate.key);
      if (shouldNotify) {
        await notify(candidate.notification);
      }
    }
  };

  void scan(true);

  if (!observedRoot) {
    return {
      disconnect: () => undefined,
      refresh: () => scan(false),
    };
  }

  const observer = createObserver(() => {
    void scan(false);
  });
  observer.observe(observedRoot, {
    attributes: true,
    attributeFilter: ["class"],
    childList: true,
    subtree: true,
  });

  return {
    disconnect: () => {
      observer.disconnect();
    },
    refresh: () => scan(false),
  };
}

function collectWebUiNotificationCandidates(targetDocument: Document): WebUiNotificationCandidate[] {
  return [
    ...collectApprovalCandidates(targetDocument),
    ...collectTaskProgressCandidates(targetDocument),
  ];
}

function collectApprovalCandidates(targetDocument: Document): WebUiNotificationCandidate[] {
  const candidates: WebUiNotificationCandidate[] = [];
  for (const item of Array.from(targetDocument.querySelectorAll(".approval-item"))) {
    const summary = elementText(item.querySelector(".approval-summary")) || elementText(item);
    const meta = elementText(item.querySelector(".approval-meta"));
    if (summary) {
      candidates.push({
        key: `approval:${summary}:${meta}`,
        notification: {
          title: "Tinybot approval required",
          body: notificationBody(summary, meta),
        },
      });
    }
  }
  return candidates;
}

function collectTaskProgressCandidates(targetDocument: Document): WebUiNotificationCandidate[] {
  const candidates: WebUiNotificationCandidate[] = [];
  for (const card of Array.from(targetDocument.querySelectorAll(".task-progress-card"))) {
    const state = TASK_NOTIFICATION_STATES.find((candidate) => card.classList.contains(candidate.className));
    if (state) {
      const title = elementText(card.querySelector(".task-progress-title")) || "Tinybot task";
      const status = elementText(card.querySelector(".task-progress-badge"));
      candidates.push({
        key: `task:${title}:${state.className}:${status}`,
        notification: {
          title: state.title,
          body: notificationBody(title, status),
        },
      });
    }
  }
  return candidates;
}

function elementText(element: Element | null): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function notificationBody(primary: string, secondary: string): string {
  return [primary, secondary].filter(Boolean).join(" - ");
}

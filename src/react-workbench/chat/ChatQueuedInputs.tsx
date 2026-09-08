import { useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { MAX_QUEUED_INPUTS } from "../../app-core/chat/chatInputState";
import type { QueuedInput } from "../../app-core/chat/chatUiProjection";
import type { ChatTurnApplication } from "./chatTurnApplication";

type Props = { application: ChatTurnApplication; sessionId: string };

function useQueue({ application, sessionId }: Props) {
  return useSyncExternalStore(application.subscribe,
    useCallback(() => application.queue(sessionId), [application, sessionId]));
}

export function ChatQueueNotice(props: Props) {
  const { message } = useQueue(props);
  return message ? <p className="react-queued-inputs__message">{message}</p> : null;
}

export function ChatQueuedInputs(props: Props) {
  const { application, sessionId } = props;
  const { inputs } = useQueue(props);
  const turn = useSyncExternalStore(application.subscribe,
    useCallback(() => application.turn(sessionId), [application, sessionId]));
  if (!inputs.length) return null;
  const canInterrupt = turn.canInterrupt && !inputs.some((input) =>
    input.mode === "interrupt" && (input.status === "queued" || input.status === "sent"));
  return <QueuedInputsPanel inputs={inputs} canInterrupt={canInterrupt}
    onDelete={(id) => application.remove(sessionId, id)}
    onInterrupt={(id) => void application.interrupt(sessionId, id)}
    onResume={() => void application.resume(sessionId)} />;
}

function QueuedInputsPanel({
  canInterrupt,
  inputs,
  onDelete,
  onInterrupt,
  onResume,
}: {
  canInterrupt: boolean;
  inputs: QueuedInput[];
  onDelete: (inputId: string) => void;
  onInterrupt: (inputId: string) => void;
  onResume: () => void;
}) {
  const { t } = useTranslation("chat");
  const hasPausedInput = inputs.some((input) => input.status === "paused");
  const pendingCount = inputs.filter((input) => input.status === "queued" || input.status === "paused").length;
  return (
    <section aria-label={t("queue.label")} aria-live="polite" className="react-queued-inputs">
      <div className="react-queued-inputs__header">
        <h2>{t("queue.title")}</h2>
        <div>
          <span>{t("queue.pending", { max: MAX_QUEUED_INPUTS, pending: pendingCount })}</span>
          {hasPausedInput ? <button type="button" onClick={onResume}>{t("queue.resume")}</button> : null}
        </div>
      </div>
      <ol>
        {inputs.map((input) => (
          <li className="react-queued-input" data-status={input.status} key={input.id}>
            <span>{queuedInputStatusLabel(input, t)}</span>
            <p>{input.content}</p>
            {(input.mode === "queued" && (input.status === "queued" || input.status === "paused")) || (input.mode === "interrupt" && input.status !== "queued") ? (
              <div className="react-queued-input__actions">
                {input.mode === "queued" && canInterrupt ? (
                  <button
                    className="react-queued-input__interrupt"
                    title={t("queue.interruptHelp")}
                    type="button"
                    onClick={() => onInterrupt(input.id)}
                  >
                    {t("queue.interrupt")}
                  </button>
                ) : null}
                <button type="button" onClick={() => onDelete(input.id)}>{input.mode === "interrupt" ? t("queue.clearInterrupt") : t("queue.delete")}</button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function queuedInputStatusLabel(input: QueuedInput, t: TFunction<"chat">): string {
  if (input.mode === "interrupt") {
    switch (input.status) {
      case "sent":
        return t("queue.sending");
      case "failed":
        return t("queue.interruptFailed");
      default:
        return t("queue.interrupting");
    }
  }
  switch (input.status) {
    case "paused":
      return t("queue.paused");
    case "sent":
      return t("queue.sent");
    case "failed":
      return t("queue.failed");
    default:
      return t("queue.waiting");
  }
}

import { useEffect, useId, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { TFunction } from "i18next";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  FileText,
  GitBranch,
  ImageIcon,
  ListCollapse,
  Loader2,
  PanelRightOpen,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentInputReference } from "../../app-core/chat/agentInputReference";
import type { HookExecutionResult } from "../../app-core/chat/hookExecutionResult";
import type {
  ArtifactRef,
  ChatStep,
  ChatTurn,
  DelegatedAgentState,
  ToolCallState,
} from "../../app-core/chat/chatTurnContracts";
import {
  canBranchFromMessage,
  canCopyMessage,
  type ContextReferenceSummary,
  type ReactChatMessage,
  type ToolCallSummary,
} from "./messageActions";
import { AssistantMarkdown } from "./AssistantMarkdown";
import type { AssistantFileLink } from "./assistantFileLinks";
import { isApplyPatchToolCall, PatchDiffCard, patchChangeSetFromToolResult } from "./PatchDiffCard";
import { ToolActivityItem } from "./ToolActivityItem";
import { DataViewCard } from "./DataViewCard";

export type ChatTimelineActions = {
  onBranch?: (messageId: string) => void;
  onOpenArtifact?: (artifact: ArtifactRef) => void;
  onOpenFileLink?: (link: AssistantFileLink) => void;
  onOpenSubagent?: (delegate: DelegatedAgentState) => void;
  onOpenTool?: (toolCall: ToolCallSummary) => void;
};

export function ChatTimeline({
  actions,
  error,
  hookResults,
  interactiveFormIds,
  latestFailedTurnId,
  optimisticMessages,
  sessionRunning,
  turns,
}: {
  actions: ChatTimelineActions;
  error?: string;
  hookResults: readonly HookExecutionResult[];
  interactiveFormIds: ReadonlySet<string>;
  latestFailedTurnId: string;
  optimisticMessages: readonly ReactChatMessage[];
  sessionRunning: boolean;
  turns: readonly ChatTurn[];
}) {
  return (
    <>
      {error ? <p aria-live="assertive" className="react-timeline-error">{error}</p> : null}
      {turns.map((turn) => (
        <CanonicalChatTurn
          focusError={turn.id === latestFailedTurnId}
          interactiveFormIds={interactiveFormIds}
          key={turn.id}
          hookResults={hookResults.filter((result) => result.turnId === turn.id)}
          turn={turn}
          onBranch={actions.onBranch}
          onOpenArtifact={actions.onOpenArtifact}
          onOpenFileLink={actions.onOpenFileLink}
          onOpenSubagent={actions.onOpenSubagent}
          onOpenTool={actions.onOpenTool}
        />
      ))}
      {optimisticMessages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          onBranch={() => undefined}
          onCopy={() => void writeClipboardText(formatMessageForCopy(message))}
          onOpenFileLink={actions.onOpenFileLink}
          onOpenTool={() => undefined}
          sessionRunning={sessionRunning}
        />
      ))}
    </>
  );
}

async function writeClipboardText(value: string): Promise<void> {
  await navigator.clipboard?.writeText(value);
}

function CanonicalChatTurn({
  focusError,
  hookResults,
  interactiveFormIds,
  onBranch,
  onOpenArtifact,
  onOpenFileLink,
  onOpenSubagent,
  onOpenTool,
  turn,
}: {
  focusError: boolean;
  hookResults: readonly HookExecutionResult[];
  interactiveFormIds: ReadonlySet<string>;
  onBranch?: (messageId: string) => void;
  onOpenArtifact?: (artifact: ArtifactRef) => void;
  onOpenFileLink?: (link: AssistantFileLink) => void;
  onOpenSubagent?: (delegate: DelegatedAgentState) => void;
  onOpenTool?: (toolCall: ToolCallSummary) => void;
  turn: ChatTurn;
}) {
  const { t } = useTranslation("chat");
  const executionItems = turn.executionItems ?? turn.steps;
  const finalAnswer = turn.finalAnswer ?? turn.finalMessage;
  const reasoningSteps = turn.steps.filter((step) => step.kind === "reasoning");
  const planSteps = turn.steps.filter((step) => step.kind === "plan");
  const errorSteps = turn.status === "interrupted"
    ? []
    : turn.steps.filter((step) => step.kind === "error");
  const legacyProcessSteps = turn.steps.filter((step) => (
    step.kind !== "reasoning"
    && step.kind !== "plan"
    && step.kind !== "error"
    && !(step.kind === "form" && step.form && interactiveFormIds.has(step.form.formId))
  ));
  const dataViewArtifacts = uniqueArtifacts(executionItems.flatMap((step) => step.artifacts ?? []))
    .filter((artifact) => artifact.kind === "data_view");
  const hasUserMessage = Boolean(turn.userMessage.text.trim() || turn.userMessage.references?.length);
  return (
    <section aria-label={t("turn.label")} className="react-canonical-turn" data-status={turn.status}>
      {hasUserMessage ? (
        <CanonicalMessage
          messageId={turn.userMessage.id}
          references={turn.userMessage.references}
          role="user"
          text={turn.userMessage.text}
        />
      ) : null}
      {turn.executionItems && executionItems.length ? (
        <ExecutionTimeline
          executionItems={executionItems}
          focusError={focusError}
          onOpenArtifact={onOpenArtifact}
          onOpenSubagent={onOpenSubagent}
          turn={turn}
        />
      ) : !turn.executionItems ? (
        <>
          {planSteps.map((step) => (
            <CanonicalChatStep key={step.id} onOpenArtifact={onOpenArtifact} onOpenFileLink={onOpenFileLink} onOpenSubagent={onOpenSubagent} step={step} />
          ))}
          {groupCanonicalSteps(legacyProcessSteps).map((group) => (
            Array.isArray(group) ? (
              <div className="react-canonical-tool-group" key={group.map((step) => step.id).join(":")}>
                <AgentSteps onOpenTool={onOpenTool} toolCalls={group.map((step) => toolCallSummaryFromStep(step, step.toolCall!, t))} />
                <CanonicalArtifacts artifacts={group.flatMap((step) => step.artifacts ?? [])} onOpen={onOpenArtifact} />
                <CanonicalScopedErrors errors={group.flatMap((step) => step.scopedErrors ?? [])} />
              </div>
            ) : (
              <CanonicalChatStep key={group.id} onOpenArtifact={onOpenArtifact} onOpenFileLink={onOpenFileLink} onOpenSubagent={onOpenSubagent} step={group} />
            )
          ))}
          {errorSteps.map((step, index) => (
            <InlineExecutionError
              focusOnMount={focusError && index === errorSteps.length - 1}
              key={step.id}
              step={step}
              turn={turn}
            />
          ))}
        </>
      ) : null}
      {hookResults.length ? <HookExecutionResults results={hookResults} /> : null}
      {finalAnswer ? (
        <CanonicalMessage
          allowActions={turn.status === "completed"}
          messageId={finalAnswer.id}
          reasoning={turn.executionItems ? [] : reasoningSteps}
          references={finalAnswer.references}
          role="assistant"
          streaming={turn.status === "running"}
          text={finalAnswer.text}
          onOpenFileLink={onOpenFileLink}
          onBranch={turn.status === "completed" && onBranch ? () => onBranch(finalAnswer.id) : undefined}
        />
      ) : !turn.executionItems && reasoningSteps.length ? (
        <CanonicalMessage
          allowActions={false}
          messageId={reasoningSteps[reasoningSteps.length - 1]?.messageId || reasoningSteps[reasoningSteps.length - 1]?.id || turn.id}
          reasoning={reasoningSteps}
          role="assistant"
          streaming={turn.status === "running"}
          text=""
          onOpenFileLink={onOpenFileLink}
        />
      ) : null}
      {dataViewArtifacts.map((artifact) => (
        <DataViewCard artifact={artifact} key={artifact.id} onOpen={onOpenArtifact} />
      ))}
    </section>
  );
}

function HookExecutionResults({ results }: { results: readonly HookExecutionResult[] }) {
  const { t } = useTranslation("chat");
  return (
    <ul aria-label={t("hook.results")} className="react-hook-results">
      {results.map((result) => {
        const status = result.failure || result.decision === "failed"
          ? "error"
          : result.decision === "deny" ? "warning" : "success";
        return (
          <li className="react-hook-result" data-status={status} key={result.id}>
            <span aria-hidden="true" className="react-hook-result__icon">
              {status === "success" ? <Check size={14} /> : <AlertTriangle size={14} />}
            </span>
            <span className="react-hook-result__copy">
              <strong>{result.hookName}</strong>
              <small>
                {hookStageLabel(result.stage, t)} · {hookDecisionLabel(result.decision, t)} · {t("hook.duration", { duration: result.durationMs })}
              </small>
              {result.failure ? <small className="react-hook-result__failure">{result.failure}</small> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function hookStageLabel(stage: string, t: TFunction<"chat">): string {
  switch (stage) {
    case "UserPromptSubmit": return t("hook.stage.userPromptSubmit");
    case "PreToolUse": return t("hook.stage.preToolUse");
    case "PostToolUse": return t("hook.stage.postToolUse");
    case "PostCompact": return t("hook.stage.postCompact");
    default: return stage;
  }
}

function hookDecisionLabel(decision: string, t: TFunction<"chat">): string {
  switch (decision) {
    case "continue": return t("hook.decision.continue");
    case "deny": return t("hook.decision.deny");
    case "replace_input": return t("hook.decision.replaceInput");
    case "additional_context": return t("hook.decision.additionalContext");
    case "replace_tool_result": return t("hook.decision.replaceToolResult");
    case "system_message": return t("hook.decision.systemMessage");
    case "failed": return t("hook.decision.failed");
    default: return decision;
  }
}

function groupCanonicalSteps(steps: ChatStep[]): Array<ChatStep | ChatStep[]> {
  const groups: Array<ChatStep | ChatStep[]> = [];
  for (const step of steps) {
    if (step.kind !== "tool_call" || !step.toolCall) {
      groups.push(step);
      continue;
    }
    const previous = groups[groups.length - 1];
    if (Array.isArray(previous)) {
      previous.push(step);
    } else {
      groups.push([step]);
    }
  }
  return groups;
}

type ExecutionFoldIntent = "untouched" | "user_open" | "user_closed";

function ExecutionTimeline({
  executionItems,
  focusError,
  onOpenArtifact,
  onOpenSubagent,
  turn,
}: {
  executionItems: ChatStep[];
  focusError: boolean;
  onOpenArtifact?: (artifact: ArtifactRef) => void;
  onOpenSubagent?: (delegate: DelegatedAgentState) => void;
  turn: ChatTurn;
}) {
  const { t } = useTranslation("chat");
  const contentId = useId();
  const timelineRef = useRef<HTMLElement | null>(null);
  const abnormal = executionItems.some((step) => step.status === "failed" || step.status === "cancelled" || step.status === "blocked")
    || turn.status === "failed"
    || turn.status === "interrupted"
    || turn.status === "awaiting_user";
  const hasFinalAnswer = Boolean(turn.finalAnswer ?? turn.finalMessage);
  const [foldIntent, setFoldIntent] = useState<ExecutionFoldIntent>("untouched");
  const [open, setOpen] = useState(() => abnormal || !hasFinalAnswer);
  const visibleExecutionItems = turn.status === "interrupted"
    ? executionItems.filter((step) => step.kind !== "error")
    : executionItems;
  const errorItems = visibleExecutionItems.filter((step) => step.kind === "error");

  useEffect(() => {
    if (foldIntent !== "untouched") {
      return;
    }
    const nextOpen = abnormal || !hasFinalAnswer;
    setOpen((currentOpen) => {
      if (currentOpen === nextOpen) {
        return currentOpen;
      }
      if (currentOpen && !nextOpen) {
        const timeline = timelineRef.current;
        const scroller = timeline?.closest<HTMLElement>(".react-conversation-view");
        const heightBefore = timeline?.getBoundingClientRect().height ?? 0;
        const timelineTop = timeline?.getBoundingClientRect().top ?? 0;
        const scrollerTop = scroller?.getBoundingClientRect().top ?? 0;
        const userIsReadingHistory = Boolean(scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >= 96);
        requestAnimationFrame(() => {
          if (!timeline || !scroller || !userIsReadingHistory || timelineTop >= scrollerTop) {
            return;
          }
          const collapsedBy = Math.max(0, heightBefore - timeline.getBoundingClientRect().height);
          scroller.scrollTop = Math.max(0, scroller.scrollTop - collapsedBy);
        });
      }
      return nextOpen;
    });
  }, [abnormal, foldIntent, hasFinalAnswer]);

  const summary = executionTimelineSummary(turn, executionItems, abnormal, t);
  return (
    <section className="react-execution-timeline" data-abnormal={abnormal ? "true" : undefined} ref={timelineRef}>
      <button
        aria-controls={contentId}
        aria-expanded={open}
        className="react-execution-timeline__trigger"
        type="button"
        onClick={() => {
          setOpen((currentOpen) => {
            setFoldIntent(currentOpen ? "user_closed" : "user_open");
            return !currentOpen;
          });
        }}
      >
        <span className="react-execution-timeline__status"><Activity aria-hidden="true" size={17} /></span>
        <span className="react-execution-timeline__heading">
          <strong>{t("turn.workPerformed")}</strong>
          <small aria-live="polite">{summary}</small>
        </span>
        <ChevronRight aria-hidden="true" className="react-execution-timeline__chevron" size={16} />
      </button>
      <div className="react-execution-timeline__content" hidden={!open} id={contentId}>
        {visibleExecutionItems.map((step) => (
          <div className="react-execution-timeline__item" data-kind={step.kind} data-status={step.status} key={step.id}>
            {step.kind === "error" ? (
              <InlineExecutionError
                focusOnMount={focusError && step.id === errorItems[errorItems.length - 1]?.id}
                step={step}
                turn={turn}
              />
            ) : (
              <CanonicalChatStep
                onOpenArtifact={onOpenArtifact}
                onOpenSubagent={onOpenSubagent}
                step={step}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function executionTimelineSummary(turn: ChatTurn, items: ChatStep[], abnormal: boolean, t: TFunction<"chat">): string {
  const plan = [...items].reverse().find((step) => step.plan)?.plan;
  const durationMs = turn.completedAt
    ? Math.max(0, Date.parse(turn.completedAt) - Date.parse(turn.startedAt))
    : undefined;
  const parts = [executionStatusLabel(turn.status, t), t("execution.actionCount", { count: items.length })]
    .filter((part): part is string => Boolean(part));
  if (plan) {
    parts.push(t("execution.plan", { completed: plan.completed, total: plan.total }));
  }
  if (durationMs !== undefined && Number.isFinite(durationMs)) {
    parts.push(formatExecutionDuration(durationMs));
  }
  if (abnormal) {
    const blocked = items.find((step) => step.status === "failed" || step.status === "cancelled" || step.status === "blocked");
    parts.push(blocked?.title || t("execution.attention"));
  }
  return parts.join(" · ");
}

function executionStatusLabel(status: ChatTurn["status"], t: TFunction<"chat">): string | undefined {
  switch (status) {
    case "completed": return undefined;
    case "failed": return t("execution.status.failed");
    case "interrupted": return t("execution.status.interrupted");
    case "awaiting_user": return t("execution.status.awaiting");
    default: return t("execution.status.running");
  }
}

function formatExecutionDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`;
  }
  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 1_000)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function CanonicalMessage({
  allowActions = true,
  messageId,
  onBranch,
  onOpenFileLink,
  reasoning = [],
  references = [],
  role,
  streaming = false,
  text,
}: {
  allowActions?: boolean;
  messageId: string;
  onBranch?: () => void;
  onOpenFileLink?: (link: AssistantFileLink) => void;
  reasoning?: ChatStep[];
  references?: AgentInputReference[];
  role: "user" | "assistant";
  streaming?: boolean;
  text: string;
}) {
  const { t } = useTranslation("chat");
  const referenceSummaries = references.map(canonicalReferenceSummary);
  const attachmentReferences = role === "user"
    ? referenceSummaries.filter(isAttachmentReference)
    : [];
  const inlineReferences = role === "user"
    ? referenceSummaries.filter((reference) => !isAttachmentReference(reference))
    : referenceSummaries;
  return (
    <article className="react-message" data-actions-placement="bottom" data-role={role} data-testid={`message-${messageId}`}>
      {attachmentReferences.length ? <MessageAttachments references={attachmentReferences} /> : null}
      <div className="react-message__body">
        {reasoning.map((step) => (
          <MessageReasoning durationMs={reasoningDurationMs(step)} key={step.id} streaming={step.status === "running"} text={step.summary ?? ""} />
        ))}
        {role === "assistant" ? <AssistantMarkdown onOpenFileLink={onOpenFileLink} streaming={streaming} text={text} /> : <PlainMessageText text={text} />}
        {inlineReferences.length ? <MessageContext references={inlineReferences} /> : null}
        {streaming ? <span aria-label={t("turn.agentResponding")} className="react-message__streaming" /> : null}
      </div>
      {allowActions && text.trim() ? (
        <div className="react-message__actions" data-align={role === "user" ? "right" : "left"}>
          <button aria-label={t("turn.copyMessage")} type="button" onClick={() => void writeClipboardText(text)}>
            <Copy aria-hidden="true" size={14} />
          </button>
          {onBranch ? (
            <button aria-label={t("turn.branchHere")} type="button" onClick={onBranch}>
              <GitBranch aria-hidden="true" size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function CanonicalChatStep({
  onOpenArtifact,
  onOpenFileLink,
  onOpenSubagent,
  step,
}: {
  onOpenArtifact?: (artifact: ArtifactRef) => void;
  onOpenFileLink?: (link: AssistantFileLink) => void;
  onOpenSubagent?: (delegate: DelegatedAgentState) => void;
  step: ChatStep;
}) {
  const { i18n, t } = useTranslation("chat");
  if (step.kind === "reasoning") {
    return <MessageReasoning streaming={step.status === "running"} text={step.summary ?? ""} />;
  }
  if (step.kind === "message") {
    return (
      <CanonicalMessage
        allowActions={step.status === "completed"}
        messageId={step.messageId || step.id}
        role="assistant"
        streaming={step.status === "running"}
        text={step.summary ?? ""}
        onOpenFileLink={onOpenFileLink}
      />
    );
  }
  if (step.kind === "tool_call" && step.toolCall) {
    if (isApplyPatchToolCall(step.toolCall) && patchChangeSetFromToolResult(step.toolCall.resultJson)?.files.length) {
      return (
        <PatchDiffCard
          status={step.status}
          toolCall={step.toolCall}
        />
      );
    }
    return (
      <ToolActivityItem
        fallbackSummary={step.summary}
        status={step.status}
        toolCall={step.toolCall}
      />
    );
  }
  if (step.kind === "form" && step.form) {
    const values = canonicalFormEntries(step.form.values);
    const errors = Object.entries(step.form.errors ?? {});
    const resolution = step.form.action === "submit"
      ? t("form.submitted")
      : step.form.action === "cancel"
        ? t("form.cancelled")
        : step.status === "completed"
          ? t("form.resolved")
          : t("form.waiting");
    return (
      <section aria-label={step.title} className="react-canonical-step" data-kind={step.kind} data-status={step.status}>
        <span className="react-canonical-step__icon"><AgentStepIcon status={canonicalStepIconStatus(step)} /></span>
        <div>
          <strong>{step.title}</strong>
          <small>{resolution}</small>
          {values.length ? (
            <dl className="react-canonical-form-summary">
              {values.map(([key, value]) => (
                <div key={key}><dt>{key}</dt><dd>{canonicalFormValue(value)}</dd></div>
              ))}
            </dl>
          ) : null}
          {errors.length ? (
            <ul aria-label={t("turn.formErrors")} role="alert">
              {errors.map(([key, error]) => <li key={key}>{key}: {error}</li>)}
            </ul>
          ) : null}
          <CanonicalScopedErrors errors={step.scopedErrors ?? []} />
        </div>
      </section>
    );
  }
  if (step.kind === "delegate" && step.delegate) {
    return onOpenSubagent ? (
      <div className="react-canonical-step-stack">
        <button
          aria-label={t("turn.openDetails", { name: step.title })}
          className="react-canonical-step react-canonical-step--button"
          data-kind={step.kind}
          data-status={step.status}
          type="button"
          onClick={() => onOpenSubagent(step.delegate!)}
        >
          <span className="react-canonical-step__icon"><AgentStepIcon status={canonicalStepIconStatus(step)} /></span>
          <span>
            <strong>{step.title}</strong>
            {step.delegate.latestActivity ? <small>{step.delegate.latestActivity}</small> : null}
          </span>
        </button>
        <CanonicalScopedErrors errors={step.scopedErrors ?? []} />
      </div>
    ) : (
      <section aria-label={step.title} className="react-canonical-step" data-kind={step.kind} data-status={step.status}>
        <span className="react-canonical-step__icon"><AgentStepIcon status={canonicalStepIconStatus(step)} /></span>
        <span>
          <strong>{step.title}</strong>
          {step.delegate.latestActivity ? <small>{step.delegate.latestActivity}</small> : null}
        </span>
      </section>
    );
  }
  if (step.kind === "plan" && step.plan) {
    return <CanonicalPlanCard step={step} />;
  }
  if (step.kind === "error") {
    return (
      <section aria-label={step.title} className="react-canonical-step" data-kind={step.kind} data-status={step.status} role="alert">
        <AlertTriangle aria-hidden="true" size={16} />
        <div><strong>{step.title}</strong>{step.summary ? <p>{step.summary}</p> : null}</div>
      </section>
    );
  }
  if (step.kind === "compaction") {
    const compaction = step.compaction;
    return (
      <details className="react-canonical-step" data-kind={step.kind} data-status={step.status}>
        <summary>
          <span className="react-canonical-step__icon"><ListCollapse aria-hidden="true" size={16} /></span>
          <span>{t("turn.contextCompacted")}</span>
          <ChevronRight aria-hidden="true" className="react-context-compaction-chevron" size={15} />
        </summary>
        {step.summary ? <p>{step.summary}</p> : null}
        {compaction ? (
          <ul aria-label={t("turn.compactionDetails")}>
            {compaction.estimatedTokensBefore !== undefined ? <li>{t("compaction.before", { value: compaction.estimatedTokensBefore.toLocaleString(i18n.resolvedLanguage) })}</li> : null}
            {compaction.estimatedTokensAfter !== undefined ? <li>{t("compaction.after", { value: compaction.estimatedTokensAfter.toLocaleString(i18n.resolvedLanguage) })}</li> : null}
            <li>{t("compaction.dropped", { value: compaction.droppedItemCount.toLocaleString(i18n.resolvedLanguage) })}</li>
          </ul>
        ) : null}
      </details>
    );
  }
  return (
    <section aria-label={step.title} className="react-canonical-step" data-kind={step.kind} data-status={step.status}>
      <span className="react-canonical-step__icon"><AgentStepIcon status={canonicalStepIconStatus(step)} /></span>
      <div>
        <strong>{step.title}</strong>
        {step.summary ? <p>{step.summary}</p> : null}
        {step.delegate?.latestActivity ? <small>{step.delegate.latestActivity}</small> : null}
        <CanonicalArtifacts artifacts={step.artifacts ?? []} onOpen={onOpenArtifact} />
        <CanonicalScopedErrors errors={step.scopedErrors ?? []} />
      </div>
    </section>
  );
}

function InlineExecutionError({ focusOnMount, step, turn }: { focusOnMount: boolean; step: ChatStep; turn: ChatTurn }) {
  const { t } = useTranslation("chat");
  const cardRef = useRef<HTMLElement | null>(null);
  const error = canonicalErrorInfo(step, t);

  useEffect(() => {
    if (focusOnMount) {
      cardRef.current?.focus();
    }
  }, [focusOnMount]);

  return (
    <section
      ref={cardRef}
      aria-label={t("recovery.label")}
      className="react-execution-error"
      role="alert"
      tabIndex={-1}
    >
      <AlertTriangle aria-hidden="true" className="react-execution-error__icon" size={16} />
      <div className="react-execution-error__message">
        <strong>{turn.status === "interrupted" ? t("recovery.cancelled") : t("recovery.interrupted")}</strong>
        <p>{friendlyErrorMessage(error.code, error.message, t)}</p>
      </div>
      <button className="react-execution-error__copy" type="button" onClick={() => void writeClipboardText(formatFailureDetails(step, turn, t))}>
        <Copy aria-hidden="true" size={14} />
        {t("recovery.copyError")}
      </button>
    </section>
  );
}

function CanonicalPlanCard({ step }: { step: ChatStep }) {
  const { t } = useTranslation("chat");
  const contentId = useId();
  const [expanded, setExpanded] = useState(step.status !== "completed");
  const plan = step.plan;
  const completed = plan?.steps.filter((item) => item.status === "completed").length ?? 0;

  useEffect(() => {
    if (step.status === "completed") {
      setExpanded(false);
    } else if (step.status === "running") {
      setExpanded(true);
    }
  }, [step.status]);

  if (!plan) {
    return null;
  }

  return (
    <section aria-label={t("plan.label")} aria-live="polite" className="react-canonical-step" data-kind={step.kind} data-status={step.status}>
      <span className="react-canonical-step__icon"><AgentStepIcon status={canonicalStepIconStatus(step)} /></span>
      <div className="react-canonical-plan">
        <button
          aria-controls={contentId}
          aria-expanded={expanded}
          className="react-canonical-plan__heading"
          type="button"
          onClick={() => setExpanded((open) => !open)}
        >
          <strong>{t("plan.label")}</strong>
          <span>{t("plan.completed", { completed, total: plan.total })}</span>
          {expanded ? <ChevronDown aria-hidden="true" size={15} /> : <ChevronRight aria-hidden="true" size={15} />}
        </button>
        <progress
          aria-label={step.title}
          aria-valuemax={plan.total}
          aria-valuemin={0}
          aria-valuenow={completed}
          max={Math.max(plan.total, 1)}
          value={completed}
        />
        {expanded ? (
          <div className="react-canonical-plan__content" id={contentId}>
            {plan.explanation ? <p className="react-canonical-plan__explanation">{plan.explanation}</p> : null}
            <ol className="react-canonical-plan__steps">
              {plan.steps.map((planStep, index) => (
                <li data-status={planStep.status} key={`${index}:${planStep.step}`}>
                  <span className="react-canonical-plan__step-icon"><PlanStepIcon status={planStep.status} /></span>
                  <PlanStepLabel text={planStep.step} />
                  <small>{formatPlanStepStatus(planStep.status, t)}</small>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </section>
  );
}

type PlanStepStatus = NonNullable<ChatStep["plan"]>["steps"][number]["status"];

function PlanStepIcon({ status }: { status: PlanStepStatus }) {
  const { t } = useTranslation("chat");
  switch (status) {
    case "completed": return <Check aria-label={t("plan.status.completed")} size={14} />;
    case "in_progress": return <Loader2 aria-label={t("plan.status.inProgress")} size={14} />;
    case "failed": return <AlertTriangle aria-label={t("plan.status.failed")} size={14} />;
    case "cancelled": return <X aria-label={t("plan.status.cancelled")} size={14} />;
    default: return <Circle aria-label={t("plan.status.pending")} size={12} />;
  }
}

function PlanStepLabel({ text }: { text: string }) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const canExpand = text.length > 72;
  return (
    <span className="react-canonical-plan__step-label">
      <span data-expanded={expanded ? "true" : undefined}>{text}</span>
      {canExpand ? (
        <button aria-expanded={expanded} type="button" onClick={() => setExpanded((open) => !open)}>
          {expanded ? t("plan.collapse") : t("plan.expand")}
        </button>
      ) : null}
    </span>
  );
}

function formatPlanStepStatus(status: PlanStepStatus, t: TFunction<"chat">): string {
  switch (status) {
    case "completed": return t("plan.status.completed");
    case "in_progress": return t("plan.status.inProgress");
    case "failed": return t("plan.status.failed");
    case "cancelled": return t("plan.status.cancelled");
    default: return t("plan.status.pending");
  }
}

function CanonicalArtifacts({ artifacts, onOpen }: { artifacts: ArtifactRef[]; onOpen?: (artifact: ArtifactRef) => void }) {
  const { t } = useTranslation("chat");
  const visibleArtifacts = artifacts.filter((artifact) => artifact.kind !== "data_view");
  if (!visibleArtifacts.length) {
    return null;
  }
  return (
    <ul aria-label={t("artifacts.label")} className="react-canonical-artifacts">
      {visibleArtifacts.map((artifact) => (
        <li key={artifact.id}>
          {onOpen ? (
            <button aria-label={t("artifacts.preview", { name: artifact.title })} type="button" onClick={() => onOpen(artifact)}>{artifact.title}</button>
          ) : <span>{artifact.title}</span>}
        </li>
      ))}
    </ul>
  );
}

function uniqueArtifacts(artifacts: ArtifactRef[]): ArtifactRef[] {
  return [...new Map(artifacts.map((artifact) => [artifact.id, artifact])).values()];
}

function CanonicalScopedErrors({ errors }: { errors: NonNullable<ChatStep["scopedErrors"]> }) {
  if (!errors.length) {
    return null;
  }
  return (
    <ul className="react-canonical-scoped-errors" role="alert">
      {errors.map((error, index) => <li key={`${error.code}:${index}`}><strong>{error.code}</strong>: {error.message}</li>)}
    </ul>
  );
}

function canonicalFormEntries(values: unknown): Array<[string, unknown]> {
  return values !== null && typeof values === "object" && !Array.isArray(values)
    ? Object.entries(values)
    : [];
}

function canonicalFormValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

function canonicalReferenceSummary(reference: AgentInputReference, index: number): ContextReferenceSummary {
  const attachmentKind = reference.type === "tinyos.image" ? "image" : "file";
  return {
    attachmentKind,
    ...(attachmentKind === "image" && reference.rawPath
      ? { attachmentPreviewPath: reference.rawPath }
      : {}),
    id: reference.noteId || reference.evidenceId || `${reference.kind}:${index}`,
    kind: reference.kind,
    presentation: ["tinyos.file", "tinyos.image"].includes(reference.type ?? "")
      && Boolean(reference.rawPath) && !reference.sourcePath
      ? "attachment"
      : "context",
    title: reference.title,
    detail: reference.detail,
    sourcePath: reference.sourcePath,
    sourceLine: reference.sourceLine,
  };
}

function toolCallSummaryFromStep(step: ChatStep, toolCall: ToolCallState, t: TFunction<"chat">): ToolCallSummary {
  return {
    id: toolCall.id,
    name: displayToolName(toolCall.name, t),
    status: step.status,
    summary: toolCall.resultPreview || step.summary,
    ...(toolCall.argsPreview ? { argsText: toolCall.argsPreview } : {}),
    ...(toolCall.resultPreview ? { responseText: toolCall.resultPreview } : {}),
  };
}

function canonicalStepIconStatus(step: ChatStep): AgentStepStatus {
  if (step.status === "completed") return "success";
  if (step.status === "running") return "active";
  if (step.status === "blocked") return "waiting";
  if (step.status === "failed" || step.status === "cancelled") return "error";
  return "pending";
}

function MessageBubble({
  message,
  onBranch,
  onCopy,
  onOpenFileLink,
  onOpenTool,
  sessionRunning,
}: {
  message: ReactChatMessage;
  onBranch: () => void;
  onCopy: () => void;
  onOpenFileLink?: (link: AssistantFileLink) => void;
  onOpenTool: (toolCall: ToolCallSummary) => void;
  sessionRunning: boolean;
}) {
  const { t } = useTranslation("chat");
  const actionAlignment = message.role === "user" ? "right" : "left";
  const attachmentReferences = message.role === "user"
    ? (message.contextReferences ?? []).filter(isAttachmentReference)
    : [];
  const inlineReferences = message.role === "user"
    ? (message.contextReferences ?? []).filter((reference) => !isAttachmentReference(reference))
    : message.contextReferences ?? [];
  const showCopyAction = canCopyMessage(message, { sessionRunning });
  const showBranchAction = canBranchFromMessage(message, { sessionRunning });
  return (
    <article
      className="react-message"
      data-actions-placement="bottom"
      data-role={message.role}
      data-testid={`message-${message.id}`}
    >
      {attachmentReferences.length ? <MessageAttachments references={attachmentReferences} /> : null}
      <div className="react-message__body">
        {message.reasoningText ? (
          <MessageReasoning streaming={message.status === "streaming"} text={message.reasoningText} />
        ) : null}
        {message.role === "assistant" ? (
          <AssistantMarkdown onOpenFileLink={onOpenFileLink} streaming={message.status === "streaming"} text={message.text} />
        ) : (
          <PlainMessageText text={message.text} />
        )}
        {inlineReferences.length ? <MessageContext references={inlineReferences} /> : null}
        {message.toolCalls?.length ? <AgentSteps toolCalls={message.toolCalls} onOpenTool={onOpenTool} /> : null}
        {message.status === "streaming" ? <span className="react-message__streaming" aria-label={t("turn.agentResponding")} /> : null}
      </div>
      {showCopyAction || showBranchAction ? (
        <div className="react-message__actions" data-align={actionAlignment}>
          {showCopyAction ? (
            <button aria-label={t("turn.copyMessage")} type="button" onClick={onCopy}>
              <Copy aria-hidden="true" size={14} />
            </button>
          ) : null}
          {showBranchAction ? (
            <button aria-label={t("turn.branchHere")} type="button" onClick={onBranch}>
              <GitBranch aria-hidden="true" size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function MessageReasoning({ durationMs, streaming, text }: { durationMs?: number; streaming: boolean; text: string }) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(streaming);
  const wasStreaming = useRef(streaming);
  const contentId = useId();

  useEffect(() => {
    if (wasStreaming.current !== streaming) {
      setExpanded(streaming);
      wasStreaming.current = streaming;
    }
  }, [streaming]);

  return (
    <section className="react-message-reasoning" aria-label={t("reasoning.label")}>
      <button
        aria-controls={contentId}
        aria-expanded={expanded}
        className="react-message-reasoning__trigger"
        type="button"
        onClick={() => setExpanded((open) => !open)}
      >
        <span>{streaming ? t("reasoning.thinking") : formatThinkingLabel(durationMs, t)}</span>
        {expanded ? <ChevronDown aria-hidden="true" size={14} /> : <ChevronRight aria-hidden="true" size={14} />}
      </button>
      {expanded ? (
        <div className="react-message-reasoning__content" id={contentId}>
          <PlainMessageText text={text} />
        </div>
      ) : null}
    </section>
  );
}

function MessageContext({ references }: { references: ContextReferenceSummary[] }) {
  const { t } = useTranslation("chat");
  const attachmentsOnly = references.every((reference) => reference.presentation === "attachment");
  const label = attachmentsOnly ? t("context.attachments") : t("context.context");
  return (
    <section
      aria-label={label}
      className="react-message-context"
      data-presentation={attachmentsOnly ? "attachment" : "context"}
    >
      <h3>{label}</h3>
      <ul>
        {references.map((reference) => (
          <li data-presentation={reference.presentation ?? "context"} key={reference.id}>
            {reference.presentation === "attachment" ? (
              <span className="react-message-context__icon">
                {reference.attachmentKind === "image"
                  ? <ImageIcon aria-hidden="true" size={16} />
                  : <FileText aria-hidden="true" size={16} />}
              </span>
            ) : null}
            <span className="react-message-context__text">
              <strong>{reference.title}</strong>
              {reference.detail ? <small>{reference.detail}</small> : null}
              {reference.sourcePath ? (
                <small>
                  {reference.sourcePath}{typeof reference.sourceLine === "number" ? `:${reference.sourceLine}` : ""}
                </small>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function isAttachmentReference(reference: ContextReferenceSummary): boolean {
  return reference.presentation === "attachment";
}

function MessageAttachments({ references }: { references: ContextReferenceSummary[] }) {
  const { t } = useTranslation("chat");
  return (
    <section aria-label={t("context.attachments")} className="react-message-attachments">
      {references.map((reference) => (
        <MessageAttachment key={reference.id} reference={reference} />
      ))}
    </section>
  );
}

function MessageAttachment({ reference }: { reference: ContextReferenceSummary }) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewSource = reference.attachmentKind === "image" && !previewFailed
    ? managedImagePreviewSource(reference.attachmentPreviewPath)
    : undefined;
  if (previewSource) {
    return (
      <figure className="react-message-attachment" data-kind="image">
        <img
          alt={reference.title}
          decoding="async"
          loading="lazy"
          onError={() => setPreviewFailed(true)}
          src={previewSource}
        />
      </figure>
    );
  }
  return (
    <div className="react-message-attachment" data-kind="file">
      <span className="react-message-attachment__icon">
        {reference.attachmentKind === "image"
          ? <ImageIcon aria-hidden="true" size={18} />
          : <FileText aria-hidden="true" size={18} />}
      </span>
      <span className="react-message-attachment__summary">
        <strong>{reference.title}</strong>
        {reference.detail ? <small>{reference.detail}</small> : null}
      </span>
    </div>
  );
}

function managedImagePreviewSource(path: string | undefined): string | undefined {
  const tauriWindow = typeof window === "undefined"
    ? undefined
    : window as Window & { __TAURI_INTERNALS__?: unknown };
  return path && tauriWindow?.__TAURI_INTERNALS__ ? convertFileSrc(path) : undefined;
}

function formatMessageForCopy(message: ReactChatMessage): string {
  return message.text;
}

type AgentStepStatus = "pending" | "active" | "success" | "waiting" | "error";

function AgentSteps({
  flat = false,
  onOpenTool,
  toolCalls,
}: {
  flat?: boolean;
  onOpenTool?: (toolCall: ToolCallSummary) => void;
  toolCalls: ToolCallSummary[];
}) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const overallStatus = resolveAgentStepsStatus(toolCalls);
  const countLabel = t("steps.count", { count: toolCalls.length });
  const currentStepIndex = resolveCurrentAgentStepIndex(toolCalls);
  return (
    <section className="react-agent-steps" data-flat={flat ? "true" : undefined} data-status={overallStatus} data-stepper="true">
      {!flat ? (
        <button
          aria-controls={listId}
          aria-expanded={expanded}
          aria-label={`${t("steps.label")}, ${countLabel}`}
          className="react-agent-steps__header"
          type="button"
          onClick={() => setExpanded((open) => !open)}
        >
          <span className="react-agent-steps__header-icon" data-status={overallStatus}>
            <AgentStepIcon status={overallStatus} />
          </span>
          <span className="react-agent-steps__title">{t("steps.title")}</span>
          <small>{countLabel}</small>
          {expanded ? <ChevronDown aria-hidden="true" size={15} /> : <ChevronRight aria-hidden="true" size={15} />}
        </button>
      ) : null}

      {flat || expanded ? (
        <ol aria-label={t("steps.label")} className="react-agent-steps__list" id={listId}>
          {toolCalls.map((toolCall, index) => {
            const status = normalizeAgentStepStatus(toolCall.status);
            const isLast = index === toolCalls.length - 1;
            const isCurrent = index === currentStepIndex;
            return (
              <li
                aria-current={isCurrent ? "step" : undefined}
                className="react-agent-step-item"
                data-motion-role="step"
                data-status={status}
                data-step-count={toolCalls.length}
                data-step-index={index}
                key={toolCall.id}
              >
                {!isLast ? <span aria-hidden="true" className="react-agent-step-item__line" /> : null}
                <span className="react-agent-step-item__marker" data-status={status}>
                  <AgentStepIcon status={status} />
                </span>
                {onOpenTool ? <button
                  aria-label={t("steps.openDetails", { name: toolCall.name })}
                  className="react-agent-step"
                  type="button"
                  onClick={() => onOpenTool(toolCall)}
                >
                  <span className="react-agent-step__content">
                    <span>{toolCall.name}</span>
                    {toolCall.summary ? <small>{toolCall.summary}</small> : null}
                  </span>
                  <small className="react-agent-step__status">{formatAgentStepStatus(toolCall.status, t)}</small>
                  <PanelRightOpen aria-hidden="true" size={15} />
                </button> : (
                  <div className="react-agent-step">
                    <span className="react-agent-step__content">
                      <span>{toolCall.name}</span>
                      {toolCall.summary ? <small>{toolCall.summary}</small> : null}
                    </span>
                    <small className="react-agent-step__status">{formatAgentStepStatus(toolCall.status, t)}</small>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

function AgentStepIcon({ status }: { status: AgentStepStatus }) {
  switch (status) {
    case "success":
      return <Check aria-hidden="true" size={14} />;
    case "active":
      return <Loader2 aria-hidden="true" size={14} />;
    case "waiting":
    case "error":
      return <AlertTriangle aria-hidden="true" size={14} />;
    default:
      return <Circle aria-hidden="true" size={12} />;
  }
}

function resolveAgentStepsStatus(toolCalls: ToolCallSummary[]): AgentStepStatus {
  if (toolCalls.some((toolCall) => normalizeAgentStepStatus(toolCall.status) === "error")) {
    return "error";
  }
  if (toolCalls.some((toolCall) => normalizeAgentStepStatus(toolCall.status) === "waiting")) {
    return "waiting";
  }
  if (toolCalls.some((toolCall) => normalizeAgentStepStatus(toolCall.status) === "active")) {
    return "active";
  }
  if (toolCalls.length && toolCalls.every((toolCall) => normalizeAgentStepStatus(toolCall.status) === "success")) {
    return "success";
  }
  return "pending";
}

function resolveCurrentAgentStepIndex(toolCalls: ToolCallSummary[]): number {
  const activeIndex = toolCalls.findIndex((toolCall) => normalizeAgentStepStatus(toolCall.status) === "active");
  if (activeIndex >= 0) {
    return activeIndex;
  }
  const waitingIndex = toolCalls.findIndex((toolCall) => normalizeAgentStepStatus(toolCall.status) === "waiting");
  if (waitingIndex >= 0) {
    return waitingIndex;
  }
  return -1;
}

function normalizeAgentStepStatus(status: string): AgentStepStatus {
  switch (status.toLowerCase()) {
    case "complete":
    case "completed":
    case "success":
    case "succeeded":
      return "success";
    case "running":
    case "active":
      return "active";
    case "blocked":
      return "waiting";
    case "failed":
    case "error":
    case "cancelled":
    case "canceled":
      return "error";
    default:
      return status ? "pending" : "pending";
  }
}

function formatAgentStepStatus(status: string, t: TFunction<"chat">): string {
  switch (normalizeAgentStepStatus(status)) {
    case "active": return t("steps.status.active");
    case "success": return t("steps.status.success");
    case "waiting": return t("steps.status.waiting");
    case "error": return status.toLowerCase().includes("cancel") ? t("steps.status.cancelled") : t("steps.status.error");
    default: return t("steps.status.pending");
  }
}

function reasoningDurationMs(step: ChatStep): number | undefined {
  if (!step.startedAt || !step.completedAt) {
    return undefined;
  }
  const duration = Date.parse(step.completedAt) - Date.parse(step.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function formatThinkingLabel(durationMs: number | undefined, t: TFunction<"chat">): string {
  if (durationMs === undefined) {
    return t("reasoning.label");
  }
  if (durationMs < 1000) {
    return t("reasoning.underSecond");
  }
  return t("reasoning.seconds", { count: Math.max(1, Math.round(durationMs / 1000)) });
}

function PlainMessageText({ text }: { text: string }) {
  if (!text.trim()) {
    return null;
  }
  return (
    <div className="react-message-plain-text">
      <p>{text}</p>
    </div>
  );
}
function failedPlanStep(turn: ChatTurn): string {
  for (const step of turn.steps) {
    const failed = step.plan?.steps.find((planStep) => planStep.status === "failed" || planStep.status === "in_progress");
    if (failed) {
      return failed.step;
    }
  }
  return "";
}

function canonicalErrorInfo(step: ChatStep, t: TFunction<"chat">): { code: string; message: string } {
  const error = step.error && typeof step.error === "object" ? step.error as Record<string, unknown> : {};
  return {
    code: typeof error.code === "string" && error.code ? error.code : "runtime_error",
    message: typeof error.message === "string" && error.message ? error.message : step.summary || t("friendlyError.taskFailed"),
  };
}

function displayToolName(name: string, t?: TFunction<"chat">): string {
  return name === "update_plan" ? t?.("tool.updatePlan") ?? name : name;
}

function friendlyErrorMessage(code: string, message: string, t: TFunction<"chat">): string {
  if (code === "max_iterations" || message.toLowerCase().includes("max iterations")) {
    return t("friendlyError.maxIterations");
  }
  if (code.includes("cancel") || message.toLowerCase().includes("cancel")) {
    return t("friendlyError.cancelled");
  }
  return message;
}

function formatFailureDetails(step: ChatStep, turn: ChatTurn, t: TFunction<"chat">): string {
  const error = canonicalErrorInfo(step, t);
  return [
    `${t("details.task")}: ${turn.userMessage.text}`,
    `${t("details.status")}: ${turn.status}`,
    `${t("details.errorCode")}: ${error.code}`,
    `${t("details.errorMessage")}: ${error.message}`,
    failedPlanStep(turn) ? `${t("details.interruptedAt")}: ${failedPlanStep(turn)}` : "",
  ].filter(Boolean).join("\n");
}

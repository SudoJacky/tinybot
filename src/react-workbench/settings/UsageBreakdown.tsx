import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TokenUsageCounts, UsageDetails, UsageDetailsLoader, UsageGroup } from "../../app-core/settings/tokenUsage";
import "./UsageBreakdown.css";
import "../lib/FormControls.css";

export function UsageBreakdown({ groups, tasks }: { groups: UsageGroup[]; tasks?: Record<string, string> }) {
  const { t, i18n } = useTranslation("settings");
  const format = (value: number) => new Intl.NumberFormat(i18n.language).format(value);
  const rows = new Map<string, UsageGroup>();
  for (const group of groups) {
    const key = JSON.stringify([tasks ? group.taskId : null, group.purpose]);
    const row = rows.get(key);
    if (!row) { rows.set(key, { ...group, usage: group.usage ? { ...group.usage } : null }); continue; }
    row.calls += group.calls;
    row.reportedCalls += group.reportedCalls;
    row.failedCalls += group.failedCalls;
    row.pendingCalls += group.pendingCalls;
    row.retryCalls += group.retryCalls;
    if (group.usage) {
      if (!row.usage) row.usage = { ...group.usage };
      else for (const field of Object.keys(row.usage) as (keyof TokenUsageCounts)[]) row.usage[field] += group.usage[field];
    }
  }
  const total = [...rows.values()].reduce((sum, row) => {
    sum.calls += row.calls;
    sum.missing += row.calls - row.reportedCalls;
    sum.retries += row.retryCalls;
    sum.failed += row.failedCalls;
    sum.pending += row.pendingCalls;
    if (row.usage) {
      if (!sum.usage) sum.usage = { ...row.usage };
      else for (const field of Object.keys(sum.usage) as (keyof TokenUsageCounts)[]) sum.usage[field] += row.usage[field];
    }
    return sum;
  }, { calls: 0, missing: 0, retries: 0, failed: 0, pending: 0, usage: null as TokenUsageCounts | null });
  return <section className="usage-breakdown react-form-controls" aria-label={t("usage.breakdown")}>
    <h3>{t("usage.breakdown")}</h3>
    <p>{t("usage.accountingNote")}</p>
    <div className="usage-breakdown__scroll">
      <table aria-label={t("usage.breakdown")}>
        <thead><tr>
          {tasks && <th scope="col">{t("usage.task")}</th>}
          <th scope="col">{t("usage.purposeLabel")}</th><th scope="col">{t("usage.calls")}</th>
          <th scope="col">{t("usage.missing")}</th><th scope="col">{t("usage.retries")}</th>
          <th scope="col">{t("usage.failed")}</th><th scope="col">{t("usage.pending")}</th>
          <th scope="col">{t("profile.inputTokens")}</th><th scope="col">{t("profile.cachedInputTokens")}</th>
          <th scope="col">{t("usage.nonCached")}</th><th scope="col">{t("profile.outputTokens")}</th>
          <th scope="col">{t("profile.reasoningOutputTokens")}</th><th scope="col">{t("profile.totalTokens")}</th>
        </tr></thead>
        <tbody>{[...rows.entries()].map(([key, row]) => <tr key={key}>
          {tasks && <th scope="row">{row.taskId ? tasks[row.taskId] ?? row.taskId : t("usage.runWork")}</th>}
          <th scope={tasks ? undefined : "row"}>{t(`usage.purposes.${row.purpose}`)}</th>
          {[row.calls, row.calls - row.reportedCalls, row.retryCalls, row.failedCalls, row.pendingCalls].map((value, index) =>
            <td key={index}>{row.purpose === "legacy" ? t("usage.unavailable") : format(value)}</td>)}
          {[row.usage?.inputTokens, row.usage?.cachedInputTokens,
            row.usage ? row.usage.inputTokens - row.usage.cachedInputTokens : undefined,
            row.usage?.outputTokens, row.usage?.reasoningOutputTokens, row.usage?.totalTokens].map((value, index) =>
            <td key={index}>{value === undefined ? t("usage.unavailable") : format(value)}</td>)}
        </tr>)}</tbody>
        {rows.size > 0 && <tfoot><tr>
          <th scope="row" colSpan={tasks ? 2 : 1}>{t("usage.total")}</th>
          {[total.calls, total.missing, total.retries, total.failed, total.pending].map((value, index) =>
            <td key={index}>{groups.some(group => group.purpose === "legacy") ? t("usage.unavailable") : format(value)}</td>)}
          {[total.usage?.inputTokens, total.usage?.cachedInputTokens,
            total.usage ? total.usage.inputTokens - total.usage.cachedInputTokens : undefined,
            total.usage?.outputTokens, total.usage?.reasoningOutputTokens, total.usage?.totalTokens].map((value, index) =>
            <td key={index}>{value === undefined ? t("usage.unavailable") : format(value)}</td>)}
        </tr></tfoot>}
      </table>
    </div>
    {!rows.size && <p>{t("usage.noDetails")}</p>}
  </section>;
}

type DetailsState = { key: string; data: UsageDetails } | null;

export function UsageHistory({ load, teamRunId, tasks }: {
  load: UsageDetailsLoader; teamRunId?: string; tasks?: Record<string, string>;
}) {
  const { t, i18n } = useTranslation("settings");
  const [before, setBefore] = useState<number | undefined>();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DetailsState>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const key = JSON.stringify([teamRunId, before, attempt]);
  useEffect(() => {
    let active = true;
    void load({ teamRunId, before }).then(data => {
      if (active) setState({ key, data });
    }).catch((error: unknown) => {
      console.error("[token-usage-details]", { teamRunId, before, error });
      if (active) setFailure({ key, message: String(error) });
    });
    return () => { active = false; };
  }, [load, teamRunId, before, attempt, key]);
  const data = state?.key === key ? state.data : undefined;
  const error = failure?.key === key ? failure.message : undefined;
  return <section className="usage-breakdown react-form-controls" aria-label={t("usage.history")}>
    <header><h3>{t("usage.history")}</h3><button type="button" onClick={() => { setBefore(undefined); setAttempt(a => a + 1); }}>{t("usage.refresh")}</button></header>
    {error ? <p role="alert">{error}</p> : !data ? <p role="status">{t("profile.loading")}</p> : <>
      {teamRunId && <UsageBreakdown groups={data.groups} tasks={tasks} />}
      <p>{t("usage.historyNote")}</p>
      <div className="usage-breakdown__scroll"><table aria-label={t("usage.history")}>
        <thead><tr>{(["time", "purposeLabel", "model", "status", "attempt", "tokens", "origin"] as const).map(field => <th scope="col" key={field}>{t(`usage.${field}`)}</th>)}</tr></thead>
        <tbody>{data.invocations.map(call => <tr key={call.id}>
          <th scope="row">{new Date(call.startedAt).toLocaleString(i18n.language)}</th>
          <td>{t(`usage.purposes.${call.origin.purpose}`)}</td>
          <td>{call.providerId} / {call.modelId}</td><td>{t(`usage.statuses.${call.status}`)}</td>
          <td>{call.attempt + 1}</td><td>{call.usage ? call.usage.totalTokens.toLocaleString(i18n.language) : t("usage.unavailable")}</td>
          <td><details><summary>{call.origin.taskId && tasks ? tasks[call.origin.taskId] ?? call.origin.taskId : call.origin.teamRunId ?? call.origin.threadId ?? t("usage.shared")}</summary>
            <dl>{([["request", call.requestId], ["invocation", call.id], ["team", call.origin.teamRunId], ["task", call.origin.taskId], ["attemptId", call.origin.attemptId], ["thread", call.origin.threadId], ["turn", call.origin.turnId]] as const).map(([field, value]) => value ? <div key={field}><dt>{t(`usage.${field}`)}</dt><dd>{value}</dd></div> : null)}</dl>
            {call.usage && <dl>{(Object.entries(call.usage) as [keyof TokenUsageCounts, number][]).map(([field, value]) => <div key={field}><dt>{t(`profile.${field}`)}</dt><dd>{value.toLocaleString(i18n.language)}</dd></div>)}</dl>}
            {call.usage && <dl><div><dt>{t("usage.nonCached")}</dt><dd>{(call.usage.inputTokens - call.usage.cachedInputTokens).toLocaleString(i18n.language)}</dd></div></dl>}
          </details></td>
        </tr>)}</tbody>
      </table></div>
      {!data.invocations.length && <p>{t("usage.noDetails")}</p>}
      {data.nextCursor !== null && <button type="button" onClick={() => setBefore(data.nextCursor!)}>{t("usage.older")}</button>}
    </>}
  </section>;
}

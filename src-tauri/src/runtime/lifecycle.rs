use crate::runtime::agent_task::{AgentTaskRuntime, ShutdownReport};
use crate::runtime::mcp::McpRuntime;
use crate::worker_capability::default_desktop_capability_policy;
use crate::worker_manager::{WorkerManager, WorkerManagerState};
use crate::worker_protocol::WorkerProtocolError;
use crate::worker_shell::{ShellProcessCleanupReport, WorkerShellRuntime};
use crate::worker_subagent_manager::{SubagentThreadManager, SubagentThreadStatus};
use crate::worker_thread::{
    InterruptThreadRequest, ListThreadsRequest, ThreadIdParams, WorkerThreadRpc,
};
use crate::worker_thread_log::{
    AgentRunRecoveryEntry, ThreadLogIndexConsistencyReport, ThreadLogIndexRepairReport,
    WorkerThreadLogRpc,
};
use serde::Serialize;
use std::path::Path;
use std::time::{Duration, Instant};

const MAX_LIFECYCLE_DIAGNOSTICS: usize = 50;
const THREAD_RECOVERY_PAGE_SIZE: usize = 500;

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LifecycleRunRef {
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) thread_id: Option<String>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LifecycleSubagentRef {
    pub(crate) session_key: String,
    pub(crate) subagent_id: String,
    pub(crate) child_run_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LifecycleFailure {
    pub(crate) stage: String,
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LifecycleStageReport {
    pub(crate) completed: bool,
    pub(crate) detail: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubagentShutdownReport {
    pub(crate) requested: usize,
    pub(crate) interrupted: Vec<LifecycleSubagentRef>,
    pub(crate) failures: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeShutdownReport {
    pub(crate) completed: bool,
    pub(crate) elapsed_ms: u64,
    pub(crate) agent_tasks: ShutdownReport,
    pub(crate) shell: ShellProcessCleanupReport,
    pub(crate) mcp: LifecycleStageReport,
    pub(crate) subagents: SubagentShutdownReport,
    pub(crate) background_worker: LifecycleStageReport,
    pub(crate) state_persistence: LifecycleStageReport,
    pub(crate) failures: Vec<LifecycleFailure>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeStartupRecoveryReport {
    pub(crate) session_log_index: Option<ThreadLogIndexConsistencyReport>,
    pub(crate) session_log_index_migration: Option<ThreadLogIndexRepairReport>,
    pub(crate) scanned_threads: usize,
    pub(crate) scanned_run_records: usize,
    pub(crate) interrupted_runs: Vec<LifecycleRunRef>,
    pub(crate) awaiting_interaction_runs: Vec<LifecycleRunRef>,
    pub(crate) resumable_runs: Vec<LifecycleRunRef>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeLifecycleStatus {
    pub(crate) startup_reconciled: bool,
    pub(crate) last_startup_recovery: Option<RuntimeStartupRecoveryReport>,
    pub(crate) last_shutdown: Option<RuntimeShutdownReport>,
    pub(crate) diagnostics: Vec<LifecycleFailure>,
}

impl RuntimeLifecycleStatus {
    pub(crate) fn record_startup_recovery(&mut self, report: RuntimeStartupRecoveryReport) {
        self.startup_reconciled = true;
        self.last_startup_recovery = Some(report);
    }

    pub(crate) fn record_startup_failure(&mut self, message: impl Into<String>) {
        self.push_diagnostic(LifecycleFailure {
            stage: "startup_recovery".to_string(),
            code: "startup_recovery_failed".to_string(),
            message: message.into(),
        });
    }

    pub(crate) fn record_resume_failure(&mut self, message: impl Into<String>) {
        self.push_diagnostic(LifecycleFailure {
            stage: "runtime_resume".to_string(),
            code: "runtime_resume_failed".to_string(),
            message: message.into(),
        });
    }

    pub(crate) fn record_shutdown(&mut self, report: RuntimeShutdownReport) {
        for failure in &report.failures {
            self.push_diagnostic(failure.clone());
        }
        self.last_shutdown = Some(report);
    }

    fn push_diagnostic(&mut self, diagnostic: LifecycleFailure) {
        if self.diagnostics.len() >= MAX_LIFECYCLE_DIAGNOSTICS {
            self.diagnostics.remove(0);
        }
        self.diagnostics.push(diagnostic);
    }
}

#[derive(Clone)]
pub(crate) struct RuntimeLifecycle {
    agent_tasks: AgentTaskRuntime,
    shell: WorkerShellRuntime,
    mcp: McpRuntime,
    subagents: SubagentThreadManager,
    background_worker: WorkerManager,
}

impl RuntimeLifecycle {
    pub(crate) fn new(
        agent_tasks: AgentTaskRuntime,
        shell: WorkerShellRuntime,
        mcp: McpRuntime,
        subagents: SubagentThreadManager,
        background_worker: WorkerManager,
    ) -> Self {
        Self {
            agent_tasks,
            shell,
            mcp,
            subagents,
            background_worker,
        }
    }

    pub(crate) async fn shutdown(&self, timeout: Duration) -> RuntimeShutdownReport {
        let started = Instant::now();
        let mut failures = Vec::new();

        let agent_tasks = self.agent_tasks.shutdown(timeout);
        if agent_tasks.timed_out {
            failures.push(LifecycleFailure {
                stage: "agent_tasks".to_string(),
                code: "cleanup_timeout".to_string(),
                message: format!(
                    "agent task cleanup timed out for runs: {}",
                    agent_tasks.cleanup_pending_runs.join(", ")
                ),
            });
        }

        let shell = self.shell.shutdown();
        failures.extend(
            shell
                .failures
                .iter()
                .cloned()
                .map(|message| LifecycleFailure {
                    stage: "shell_processes".to_string(),
                    code: "termination_failed".to_string(),
                    message,
                }),
        );

        let timeout = timeout.max(Duration::from_millis(1));
        let mcp = match tokio::time::timeout(timeout, self.mcp.shutdown()).await {
            Ok(Ok(())) => LifecycleStageReport {
                completed: true,
                detail: "MCP clients and stdio children stopped.".to_string(),
            },
            Ok(Err(error)) => {
                failures.push(LifecycleFailure {
                    stage: "mcp".to_string(),
                    code: "shutdown_failed".to_string(),
                    message: error.message.clone(),
                });
                LifecycleStageReport {
                    completed: false,
                    detail: error.message,
                }
            }
            Err(_) => {
                let message = format!("MCP shutdown exceeded {} ms", timeout.as_millis());
                failures.push(LifecycleFailure {
                    stage: "mcp".to_string(),
                    code: "shutdown_timeout".to_string(),
                    message: message.clone(),
                });
                LifecycleStageReport {
                    completed: false,
                    detail: message,
                }
            }
        };

        let mut subagents = SubagentShutdownReport::default();
        for result in self.subagents.interrupt_all_non_terminal_for_shutdown() {
            subagents.requested = subagents.requested.saturating_add(1);
            if result.accepted {
                if let Some(summary) = result.subagent {
                    if summary.status == SubagentThreadStatus::Interrupted {
                        subagents.interrupted.push(LifecycleSubagentRef {
                            session_key: summary.session_key,
                            subagent_id: summary.subagent_id,
                            child_run_id: summary.child_run_id,
                        });
                    }
                }
            } else {
                let message = result
                    .error
                    .map(|error| error.message)
                    .unwrap_or_else(|| "subagent interruption was rejected".to_string());
                subagents.failures.push(message.clone());
                failures.push(LifecycleFailure {
                    stage: "subagents".to_string(),
                    code: "interrupt_failed".to_string(),
                    message,
                });
            }
        }
        subagents.interrupted.sort();

        let worker_was_running =
            self.background_worker.status().state == WorkerManagerState::Running;
        let background_worker = match self.background_worker.stop() {
            Ok(()) => LifecycleStageReport {
                completed: true,
                detail: if worker_was_running {
                    "Background worker stopped.".to_string()
                } else {
                    "Background worker was not running.".to_string()
                },
            },
            Err(error) => {
                let message = format!("failed to stop background worker: {error:?}");
                failures.push(LifecycleFailure {
                    stage: "background_worker".to_string(),
                    code: "shutdown_failed".to_string(),
                    message: message.clone(),
                });
                LifecycleStageReport {
                    completed: false,
                    detail: message,
                }
            }
        };

        let state_persistence = if agent_tasks.timed_out {
            LifecycleStageReport {
                completed: false,
                detail: "Owned run cleanup is still pending, so persistence completion cannot be confirmed."
                    .to_string(),
            }
        } else {
            LifecycleStageReport {
                completed: true,
                detail: "Runtime stores are write-through and each owned rollout writer drains on release."
                    .to_string(),
            }
        };

        RuntimeShutdownReport {
            completed: failures.is_empty(),
            elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            agent_tasks,
            shell,
            mcp,
            subagents,
            background_worker,
            state_persistence,
            failures,
        }
    }

    pub(crate) fn reconcile_startup(
        workspace_root: &Path,
    ) -> Result<RuntimeStartupRecoveryReport, WorkerProtocolError> {
        let recovery_started = Instant::now();
        let metrics = crate::runtime::observability::global_agent_runtime_metrics();
        metrics.increment("recovery.orphaned_runs.requested");
        let policy = default_desktop_capability_policy();
        let thread = WorkerThreadRpc::new(workspace_root.to_path_buf(), policy.clone());
        let thread_log = WorkerThreadLogRpc::new(workspace_root.to_path_buf(), policy);
        let mut report = RuntimeStartupRecoveryReport::default();

        report.session_log_index_migration = thread_log.prepare_state_index_for_startup()?;
        report.session_log_index = Some(thread_log.check_state_index()?);
        let (threads, items) = thread_log.thread_projection()?;
        thread.replace_projection(threads, items)?;

        for thread_record in list_all_threads(&thread)? {
            report.scanned_threads = report.scanned_threads.saturating_add(1);
            let status = thread.get_thread_status(ThreadIdParams {
                thread_id: thread_record.thread_id.clone(),
            })?;
            let Some(active_run) = status.active_run else {
                continue;
            };
            let run_ref = LifecycleRunRef {
                session_id: status
                    .thread
                    .session_key
                    .clone()
                    .unwrap_or_else(|| status.thread.thread_id.clone()),
                run_id: active_run.run_id.clone(),
                thread_id: Some(status.thread.thread_id.clone()),
            };
            match active_run.status {
                crate::worker_thread::ThreadStatus::WaitingForApproval
                | crate::worker_thread::ThreadStatus::WaitingForInput => {
                    if status.latest_checkpoint.as_ref().is_some_and(|checkpoint| {
                        checkpoint
                            .run_id
                            .as_deref()
                            .is_none_or(|run_id| run_id == active_run.run_id)
                    }) {
                        report.resumable_runs.push(run_ref);
                    } else {
                        report.awaiting_interaction_runs.push(run_ref);
                    }
                }
                _ if active_run.active => {
                    let interrupted = thread.interrupt(InterruptThreadRequest {
                        thread_id: status.thread.thread_id,
                        client_event_id: Some(format!(
                            "startup-recovery:{}:{}",
                            run_ref.thread_id.as_deref().unwrap_or("thread"),
                            run_ref.run_id
                        )),
                        run_id: Some(run_ref.run_id.clone()),
                        reason: Some(
                            "Runtime restarted before the run reached a terminal state."
                                .to_string(),
                        ),
                    })?;
                    thread_log.create_from_thread_record(&interrupted.snapshot.thread)?;
                    thread_log.append_thread_items(
                        &interrupted.snapshot.thread.thread_id,
                        &interrupted.appended_items,
                    )?;
                    report.interrupted_runs.push(run_ref);
                }
                _ => {}
            }
        }

        let run_report = thread_log.reconcile_orphaned_agent_runs()?;
        report.scanned_run_records = run_report.scanned_runs;
        report.interrupted_runs.extend(
            run_report
                .interrupted_runs
                .into_iter()
                .map(LifecycleRunRef::from),
        );
        report.awaiting_interaction_runs.extend(
            run_report
                .awaiting_interaction_runs
                .into_iter()
                .map(LifecycleRunRef::from),
        );
        report.resumable_runs.extend(
            run_report
                .resumable_runs
                .into_iter()
                .map(LifecycleRunRef::from),
        );
        normalize_run_refs(&mut report.interrupted_runs);
        normalize_run_refs(&mut report.awaiting_interaction_runs);
        normalize_run_refs(&mut report.resumable_runs);
        let interrupted_keys = run_keys(&report.interrupted_runs);
        report.resumable_runs.retain(|run| {
            !interrupted_keys.contains(&(run.session_id.clone(), run.run_id.clone()))
        });
        let resumable_keys = run_keys(&report.resumable_runs);
        report.awaiting_interaction_runs.retain(|run| {
            let key = (run.session_id.clone(), run.run_id.clone());
            !interrupted_keys.contains(&key) && !resumable_keys.contains(&key)
        });
        metrics.increment_by(
            "recovery.orphaned_runs.interrupted",
            report.interrupted_runs.len() as u64,
        );
        metrics.increment_by(
            "recovery.orphaned_runs.resumable",
            report.resumable_runs.len() as u64,
        );
        metrics.increment_by(
            "recovery.orphaned_runs.awaiting_interaction",
            report.awaiting_interaction_runs.len() as u64,
        );
        metrics.record_duration(
            "recovery.orphaned_runs.durationMs",
            recovery_started.elapsed(),
        );
        metrics.increment("recovery.orphaned_runs.completed");
        Ok(report)
    }
}

impl From<AgentRunRecoveryEntry> for LifecycleRunRef {
    fn from(entry: AgentRunRecoveryEntry) -> Self {
        Self {
            session_id: entry.session_id,
            run_id: entry.run_id,
            thread_id: entry.thread_id,
        }
    }
}

fn list_all_threads(
    thread: &WorkerThreadRpc,
) -> Result<Vec<crate::worker_thread::ThreadRecord>, WorkerProtocolError> {
    let mut offset = 0;
    let mut threads = Vec::new();
    loop {
        let page = thread.list_threads(ListThreadsRequest {
            include_archived: true,
            include_child_threads: true,
            parent_thread_id: None,
            ancestor_thread_id: None,
            offset: Some(offset),
            limit: Some(THREAD_RECOVERY_PAGE_SIZE),
        })?;
        threads.extend(page.threads);
        let Some(next_offset) = page.next_offset else {
            break;
        };
        offset = next_offset;
    }
    Ok(threads)
}

fn normalize_run_refs(runs: &mut Vec<LifecycleRunRef>) {
    runs.sort_by(|left, right| {
        left.session_id
            .cmp(&right.session_id)
            .then_with(|| left.run_id.cmp(&right.run_id))
    });
    let mut normalized = Vec::<LifecycleRunRef>::with_capacity(runs.len());
    for run in runs.drain(..) {
        if let Some(existing) = normalized.last_mut().filter(|existing| {
            existing.session_id == run.session_id && existing.run_id == run.run_id
        }) {
            if existing.thread_id.is_none() {
                existing.thread_id = run.thread_id;
            }
        } else {
            normalized.push(run);
        }
    }
    *runs = normalized;
}

fn run_keys(runs: &[LifecycleRunRef]) -> std::collections::BTreeSet<(String, String)> {
    runs.iter()
        .map(|run| (run.session_id.clone(), run.run_id.clone()))
        .collect()
}

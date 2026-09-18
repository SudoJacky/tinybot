use super::DailyTokenUsageStore;
use crate::threads::{domain::ReadThreadRequest, workspace_store::WorkspaceThreadStore};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, future::Future};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UsagePurpose {
    #[default]
    Unclassified,
    Conversation,
    TeamTask,
    TeamPlanning,
    Subagent,
    Automation,
    Compaction,
    Title,
    MemoryExtraction,
    MemoryConsolidation,
    GraphRouting,
    GraphExecution,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageOrigin {
    pub purpose: UsagePurpose,
    pub team_run_id: Option<String>,
    pub task_id: Option<String>,
    pub attempt_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct UsageScope {
    pub origin: UsageOrigin,
    pub store: Option<DailyTokenUsageStore>,
}

tokio::task_local! { static SCOPE: UsageScope; }

impl UsageScope {
    pub fn current() -> Self {
        SCOPE.try_with(Clone::clone).unwrap_or_else(|_| Self {
            origin: UsageOrigin::default(),
            // Unit tests opt into a real, isolated store explicitly.
            store: if cfg!(test) {
                None
            } else {
                Some(DailyTokenUsageStore::global())
            },
        })
    }

    pub fn with_purpose(purpose: UsagePurpose) -> Self {
        let mut scope = Self::current();
        scope.origin.purpose = purpose;
        scope
    }

    pub async fn run<F: Future>(self, future: F) -> F::Output {
        SCOPE.scope(self, Box::pin(future)).await
    }

    /// Resolve identities from persisted Threads, never from caller/model metadata.
    /// Walking parent identities also works after detached execution or restart.
    pub fn for_thread(
        threads: &WorkspaceThreadStore,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<Self, String> {
        let operation = threads.begin_operation().map_err(|e| e.message)?;
        let thread_id = operation
            .thread_log()
            .resolve_thread_id(thread_id)
            .map_err(|e| e.message)?;
        let mut origin = UsageOrigin {
            thread_id: Some(thread_id.clone()),
            turn_id: Some(turn_id.into()),
            ..Default::default()
        };
        let mut next = Some(thread_id.to_string());
        let mut visited = HashSet::new();
        while let Some(id) = next {
            if !visited.insert(id.clone()) {
                return Err("Cycle in usage Thread ancestry".into());
            }
            let thread = operation
                .thread()
                .read_thread(ReadThreadRequest {
                    thread_id: id,
                    limit: Some(0),
                    ..Default::default()
                })
                .map_err(|e| e.message)?
                .thread;
            if visited.len() == 1 {
                origin.purpose = match thread.source.as_str() {
                    "team" => UsagePurpose::TeamTask,
                    "automation" => UsagePurpose::Automation,
                    "agent_graph" => UsagePurpose::GraphExecution,
                    _ if thread.parent_thread_id.is_some() => UsagePurpose::Subagent,
                    _ => UsagePurpose::Conversation,
                };
            }
            if thread.source == "team" {
                let required = |key: &str| {
                    thread
                        .metadata
                        .extra
                        .get(key)
                        .and_then(serde_json::Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .ok_or_else(|| format!("Team usage origin missing {key}"))
                };
                origin.team_run_id = Some(required("teamRunId")?);
                origin.task_id = Some(required("teamTaskId")?);
                origin.attempt_id = Some(thread.thread_id);
                break;
            }
            next = thread.parent_thread_id;
        }
        Ok(Self {
            origin,
            store: Some(DailyTokenUsageStore::from_data_root(threads.data_root())),
        })
    }
}

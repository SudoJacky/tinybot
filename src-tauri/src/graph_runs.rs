use crate::agent::bridge::{execute_thread_turn_with_services, SubmitThreadTurnInput};
use crate::agent::runtime::NativeAgentRuntimeServices;
use crate::agent_graphs::{self, validate_graph_id, AgentGraphDefinition, AgentGraphNodeKind};
use crate::project_groups::{canonical_workspace, workspace_id};
use crate::protocol::request_id::next_worker_request_correlation;
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
use crate::storage::atomic::{write_json_pretty_atomic, AtomicWriteOptions};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const AGENT_GRAPH_RUN_SCHEMA_VERSION: &str = "tinybot.agent_graph_run.v1";
static RUN_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentGraphRunStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentGraphNodeRunStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentGraphNodeRun {
    id: String,
    node_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    status: AgentGraphNodeRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentGraphRun {
    schema_version: String,
    id: String,
    graph_id: String,
    graph_revision: String,
    definition_workspace_path: String,
    status: AgentGraphRunStatus,
    node_runs: Vec<AgentGraphNodeRun>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListAgentGraphRunsInput {
    graph_id: String,
    definition_workspace_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartAgentGraphRunInput {
    graph_id: String,
    graph_revision: String,
    definition_workspace_path: String,
    input: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AgentStep {
    node_id: String,
    workspace_path: String,
}

pub(crate) fn list(
    data_root: &Path,
    input: ListAgentGraphRunsInput,
) -> Result<Vec<AgentGraphRun>, String> {
    validate_graph_id(&input.graph_id)?;
    let definition_workspace = workspace_id(&canonical_workspace(Path::new(
        &input.definition_workspace_path,
    ))?);
    let directory = run_directory(data_root, &input.graph_id);
    let _guard = store_lock()?;
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(io_error(
                "read Agent Graph Run directory",
                &directory,
                error,
            ))
        }
    };
    let mut runs = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| io_error("read Agent Graph Run entry", &directory, error))?;
        let path = entry.path();
        if !entry
            .file_type()
            .map_err(|error| io_error("inspect Agent Graph Run entry", &path, error))?
            .is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }
        let run = read_run(&path)?;
        if run.graph_id != input.graph_id {
            return Err(format!(
                "Agent Graph Run {} belongs to graph `{}`, not `{}`",
                path.display(),
                run.graph_id,
                input.graph_id
            ));
        }
        if run.definition_workspace_path == definition_workspace {
            runs.push(run);
        }
    }
    runs.sort_by(|left, right| right.id.cmp(&left.id));
    Ok(runs)
}

pub(crate) async fn start(
    data_root: &Path,
    base_services: NativeAgentRuntimeServices,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    input: StartAgentGraphRunInput,
) -> Result<AgentGraphRun, String> {
    if input.input.trim().is_empty() {
        return Err("Agent Graph Run input must not be empty".to_string());
    }
    let definition_workspace = canonical_workspace(Path::new(&input.definition_workspace_path))?;
    let definition_workspace_path = workspace_id(&definition_workspace);
    let stored = agent_graphs::load(
        &definition_workspace_path,
        &input.graph_id,
        &input.graph_revision,
    )?;
    let steps = linear_agent_plan(&stored.definition)?;
    let run_id = generate_run_id(data_root, &stored.definition.id);
    let mut run = AgentGraphRun {
        schema_version: AGENT_GRAPH_RUN_SCHEMA_VERSION.to_string(),
        id: run_id.clone(),
        graph_id: stored.definition.id.clone(),
        graph_revision: stored.revision.clone(),
        definition_workspace_path,
        status: AgentGraphRunStatus::Running,
        node_runs: steps
            .iter()
            .enumerate()
            .map(|(index, step)| AgentGraphNodeRun {
                id: format!("{run_id}-node-{}", index + 1),
                node_id: step.node_id.clone(),
                thread_id: None,
                status: AgentGraphNodeRunStatus::Pending,
                error: None,
            })
            .collect(),
        output: None,
        error: None,
    };
    write_run(data_root, &run)?;

    let thread_store = base_services.thread_store()?;
    let mut current_input = input.input;
    for (index, step) in steps.iter().enumerate() {
        run.node_runs[index].status = AgentGraphNodeRunStatus::Running;
        write_run(data_root, &run)?;

        let thread_id = match create_agent_graph_thread(
            &thread_store,
            &config_snapshot,
            &stored.definition.name,
            step,
            &run,
            index,
        ) {
            Ok(thread_id) => thread_id,
            Err(error) => return finish_failed_run(data_root, run, index, error),
        };
        run.node_runs[index].thread_id = Some(thread_id.clone());
        write_run(data_root, &run)?;

        let turn_id = format!("turn-{run_id}-{}", index + 1);
        let node_run_id = run.node_runs[index].id.clone();
        let result = execute_thread_turn_with_services(
            base_services.clone(),
            SubmitThreadTurnInput {
                thread_id: Some(thread_id),
                input: serde_json::json!({
                    "role": "user",
                    "content": current_input,
                    "clientEventId": format!("graph-{run_id}-{}", index + 1),
                }),
                spec: serde_json::json!({
                    "runtime": "rust",
                    "stream": true,
                    "turnId": turn_id,
                    "metadata": graph_turn_metadata(&run, step, &node_run_id),
                }),
            },
            workspace_root.clone(),
            config_snapshot.clone(),
            None,
        )
        .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => return finish_failed_run(data_root, run, index, error),
        };
        let stop_reason = result
            .result
            .get("stopReason")
            .or_else(|| result.result.get("stop_reason"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("missing_stop_reason");
        if stop_reason != "final_response" {
            let error = result
                .result
                .get("error")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("Agent node stopped with `{stop_reason}`"));
            return finish_failed_run(data_root, run, index, error);
        }
        current_input = match result
            .result
            .get("finalContent")
            .or_else(|| result.result.get("final_content"))
            .and_then(serde_json::Value::as_str)
        {
            Some(content) => content.to_string(),
            None => {
                return finish_failed_run(
                    data_root,
                    run,
                    index,
                    "Agent node completed without final content".to_string(),
                )
            }
        };
        run.node_runs[index].status = AgentGraphNodeRunStatus::Completed;
        write_run(data_root, &run)?;
    }

    run.status = AgentGraphRunStatus::Completed;
    run.output = Some(current_input);
    write_run(data_root, &run)?;
    eprintln!(
        "agent_graph_run_completed graph_id={} run_id={}",
        run.graph_id, run.id
    );
    Ok(run)
}

fn linear_agent_plan(definition: &AgentGraphDefinition) -> Result<Vec<AgentStep>, String> {
    if definition
        .nodes
        .iter()
        .any(|node| node.kind == AgentGraphNodeKind::Condition)
    {
        return Err("Condition nodes are not supported by the first Graph runtime".to_string());
    }
    let nodes = definition
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<HashMap<_, _>>();
    let mut incoming = HashMap::<&str, Vec<&str>>::new();
    let mut outgoing = HashMap::<&str, Vec<&str>>::new();
    for edge in &definition.edges {
        incoming
            .entry(edge.target.as_str())
            .or_default()
            .push(edge.source.as_str());
        outgoing
            .entry(edge.source.as_str())
            .or_default()
            .push(edge.target.as_str());
    }
    for node in &definition.nodes {
        let incoming_count = incoming.get(node.id.as_str()).map_or(0, Vec::len);
        let outgoing_count = outgoing.get(node.id.as_str()).map_or(0, Vec::len);
        let valid = match node.kind {
            AgentGraphNodeKind::Input => incoming_count == 0 && outgoing_count == 1,
            AgentGraphNodeKind::Output => incoming_count == 1 && outgoing_count == 0,
            AgentGraphNodeKind::Agent => incoming_count == 1 && outgoing_count == 1,
            AgentGraphNodeKind::Condition => false,
        };
        if !valid {
            return Err(format!(
                "Agent Graph Run requires one linear Input-to-Output path; node `{}` has {incoming_count} incoming and {outgoing_count} outgoing edges",
                node.id
            ));
        }
    }
    let input = definition
        .nodes
        .iter()
        .find(|node| node.kind == AgentGraphNodeKind::Input)
        .ok_or_else(|| "Agent Graph Run requires an Input node".to_string())?;
    let mut visited = HashSet::new();
    visited.insert(input.id.as_str());
    let mut cursor = input.id.as_str();
    let mut steps = Vec::new();
    loop {
        let next = outgoing
            .get(cursor)
            .and_then(|targets| targets.first())
            .copied()
            .ok_or_else(|| format!("Agent Graph path stops at node `{cursor}`"))?;
        if !visited.insert(next) {
            return Err(format!(
                "Agent Graph Run path contains a cycle at node `{next}`"
            ));
        }
        let node = nodes
            .get(next)
            .ok_or_else(|| format!("Agent Graph path references missing node `{next}`"))?;
        match node.kind {
            AgentGraphNodeKind::Output => break,
            AgentGraphNodeKind::Agent => {
                let workspace = node
                    .config
                    .as_ref()
                    .ok_or_else(|| format!("Agent node `{next}` has no workspace configuration"))?;
                let canonical =
                    canonical_workspace(Path::new(&workspace.workspace_path)).map_err(|error| {
                        format!("Agent node `{next}` workspace is invalid: {error}")
                    })?;
                steps.push(AgentStep {
                    node_id: node.id.clone(),
                    workspace_path: workspace_id(&canonical),
                });
            }
            AgentGraphNodeKind::Input | AgentGraphNodeKind::Condition => {
                return Err(format!("Agent Graph path has invalid node `{next}`"));
            }
        }
        cursor = next;
    }
    if visited.len() != definition.nodes.len() {
        return Err("Agent Graph Run does not support disconnected nodes".to_string());
    }
    Ok(steps)
}

fn create_agent_graph_thread(
    thread_store: &crate::threads::workspace_store::WorkspaceThreadStore,
    config_snapshot: &serde_json::Value,
    graph_name: &str,
    step: &AgentStep,
    run: &AgentGraphRun,
    index: usize,
) -> Result<String, String> {
    let node_run_id = &run.node_runs[index].id;
    let request_id = next_worker_request_correlation();
    let thread = call_rust_state_service(
        thread_store,
        config_snapshot.clone(),
        WorkerRequest::new(
            request_id.id("agent-graph-thread-create"),
            request_id.trace_id("agent-graph-thread-create"),
            "thread.create",
            serde_json::json!({
                "title": format!("{graph_name} · {}", step.node_id),
                "source": "agent_graph",
                "metadata": {
                    "workingDirectory": step.workspace_path,
                    "extra": graph_origin_metadata(run, step, node_run_id),
                },
            }),
        ),
        "Agent Graph Thread create",
    )?;
    thread
        .get("threadId")
        .or_else(|| thread.get("thread_id"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Agent Graph Thread create returned no threadId".to_string())
}

fn graph_origin_metadata(
    run: &AgentGraphRun,
    step: &AgentStep,
    node_run_id: &str,
) -> serde_json::Value {
    serde_json::json!({
        "graphId": run.graph_id,
        "graphRevision": run.graph_revision,
        "graphRunId": run.id,
        "graphNodeId": step.node_id,
        "nodeRunId": node_run_id,
    })
}

fn graph_turn_metadata(
    run: &AgentGraphRun,
    step: &AgentStep,
    node_run_id: &str,
) -> serde_json::Value {
    let mut metadata = graph_origin_metadata(run, step, node_run_id);
    metadata["workingDirectory"] = serde_json::Value::String(step.workspace_path.clone());
    metadata
}

fn finish_failed_run(
    data_root: &Path,
    mut run: AgentGraphRun,
    node_index: usize,
    error: String,
) -> Result<AgentGraphRun, String> {
    run.status = AgentGraphRunStatus::Failed;
    run.error = Some(error.clone());
    run.node_runs[node_index].status = AgentGraphNodeRunStatus::Failed;
    run.node_runs[node_index].error = Some(error);
    write_run(data_root, &run)?;
    eprintln!(
        "agent_graph_run_failed graph_id={} run_id={} node_id={}",
        run.graph_id, run.id, run.node_runs[node_index].node_id
    );
    Ok(run)
}

fn generate_run_id(data_root: &Path, graph_id: &str) -> String {
    loop {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let sequence = RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let id = format!("run-{millis}-{sequence}");
        if !run_path(data_root, graph_id, &id).exists() {
            return id;
        }
    }
}

fn write_run(data_root: &Path, run: &AgentGraphRun) -> Result<(), String> {
    let _guard = store_lock()?;
    write_json_pretty_atomic(
        &run_path(data_root, &run.graph_id, &run.id),
        run,
        AtomicWriteOptions::default(),
    )
    .map_err(|error| format!("Agent Graph Run persistence failed: {error}"))
}

fn read_run(path: &Path) -> Result<AgentGraphRun, String> {
    let contents = fs::read(path).map_err(|error| io_error("read Agent Graph Run", path, error))?;
    let run: AgentGraphRun = serde_json::from_slice(&contents).map_err(|error| {
        format!(
            "failed to parse Agent Graph Run {}: {error}",
            path.display()
        )
    })?;
    if run.schema_version != AGENT_GRAPH_RUN_SCHEMA_VERSION {
        return Err(format!(
            "unsupported Agent Graph Run schema version `{}` in {}",
            run.schema_version,
            path.display()
        ));
    }
    validate_graph_id(&run.graph_id)?;
    if run.id.is_empty()
        || !run
            .id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'-' || value == b'_')
    {
        return Err(format!("invalid Agent Graph Run id in {}", path.display()));
    }
    if path.file_name().and_then(|value| value.to_str())
        != Some(format!("{}.json", run.id).as_str())
    {
        return Err(format!(
            "Agent Graph Run file name does not match id in {}",
            path.display()
        ));
    }
    Ok(run)
}

fn run_directory(data_root: &Path, graph_id: &str) -> PathBuf {
    data_root.join("graph-runs").join(graph_id)
}

fn run_path(data_root: &Path, graph_id: &str, run_id: &str) -> PathBuf {
    run_directory(data_root, graph_id).join(format!("{run_id}.json"))
}

fn store_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    STORE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Agent Graph Run store lock is poisoned".to_string())
}

fn io_error(operation: &str, path: &Path, error: io::Error) -> String {
    format!("failed to {operation} {}: {error}", path.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        first_workspace: PathBuf,
        second_workspace: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "tinybot-graph-runs-{}-{}",
                std::process::id(),
                RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            let first_workspace = root.join("first");
            let second_workspace = root.join("second");
            fs::create_dir_all(&first_workspace).unwrap();
            fs::create_dir_all(&second_workspace).unwrap();
            Self {
                root,
                first_workspace,
                second_workspace,
            }
        }

        fn definition(&self) -> AgentGraphDefinition {
            serde_json::from_value(serde_json::json!({
                "schemaVersion": "tinybot.agent_graph.v1",
                "id": "graph-1",
                "name": "Pipeline",
                "nodes": [
                    { "id": "input", "kind": "input", "position": { "x": 0, "y": 0 } },
                    { "id": "agent-1", "kind": "agent", "position": { "x": 100, "y": 0 }, "config": { "workspacePath": self.first_workspace } },
                    { "id": "agent-2", "kind": "agent", "position": { "x": 200, "y": 0 }, "config": { "workspacePath": self.second_workspace } },
                    { "id": "output", "kind": "output", "position": { "x": 300, "y": 0 } }
                ],
                "edges": [
                    { "id": "edge-1", "source": "input", "target": "agent-1" },
                    { "id": "edge-2", "source": "agent-1", "target": "agent-2" },
                    { "id": "edge-3", "source": "agent-2", "target": "output" }
                ]
            }))
            .unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn builds_a_linear_plan_with_canonical_agent_workspaces() {
        let fixture = Fixture::new();

        let steps = linear_agent_plan(&fixture.definition()).unwrap();

        assert_eq!(
            steps,
            vec![
                AgentStep {
                    node_id: "agent-1".to_string(),
                    workspace_path: workspace_id(
                        &canonical_workspace(&fixture.first_workspace).unwrap()
                    ),
                },
                AgentStep {
                    node_id: "agent-2".to_string(),
                    workspace_path: workspace_id(
                        &canonical_workspace(&fixture.second_workspace).unwrap()
                    ),
                },
            ]
        );
    }

    #[test]
    fn rejects_branches_before_creating_a_run() {
        let fixture = Fixture::new();
        let mut definition = fixture.definition();
        definition.edges.push(
            serde_json::from_value(serde_json::json!({
                "id": "edge-branch",
                "source": "input",
                "target": "agent-2"
            }))
            .unwrap(),
        );

        let error = linear_agent_plan(&definition).unwrap_err();

        assert!(error.contains("one linear Input-to-Output path"));
    }

    #[test]
    fn persisted_runs_are_filtered_by_definition_workspace() {
        let fixture = Fixture::new();
        let run = AgentGraphRun {
            schema_version: AGENT_GRAPH_RUN_SCHEMA_VERSION.to_string(),
            id: "run-1".to_string(),
            graph_id: "graph-1".to_string(),
            graph_revision: "sha256:test".to_string(),
            definition_workspace_path: workspace_id(
                &canonical_workspace(&fixture.first_workspace).unwrap(),
            ),
            status: AgentGraphRunStatus::Completed,
            node_runs: Vec::new(),
            output: Some("done".to_string()),
            error: None,
        };
        write_run(&fixture.root, &run).unwrap();

        assert_eq!(
            list(
                &fixture.root,
                ListAgentGraphRunsInput {
                    graph_id: "graph-1".to_string(),
                    definition_workspace_path: fixture.first_workspace.display().to_string(),
                }
            )
            .unwrap(),
            vec![run]
        );
        assert!(list(
            &fixture.root,
            ListAgentGraphRunsInput {
                graph_id: "graph-1".to_string(),
                definition_workspace_path: fixture.second_workspace.display().to_string(),
            }
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn graph_nodes_create_standard_parentless_threads_with_origin_metadata() {
        let fixture = Fixture::new();
        let thread_store =
            crate::threads::workspace_store::WorkspaceThreadStore::new_with_data_root(
                fixture.first_workspace.clone(),
                fixture.root.join("data"),
                crate::protocol::capability::default_desktop_capability_policy(),
            );
        let step = AgentStep {
            node_id: "agent-1".to_string(),
            workspace_path: workspace_id(&canonical_workspace(&fixture.first_workspace).unwrap()),
        };
        let run = AgentGraphRun {
            schema_version: AGENT_GRAPH_RUN_SCHEMA_VERSION.to_string(),
            id: "run-thread-test".to_string(),
            graph_id: "graph-1".to_string(),
            graph_revision: "sha256:test".to_string(),
            definition_workspace_path: step.workspace_path.clone(),
            status: AgentGraphRunStatus::Running,
            node_runs: vec![AgentGraphNodeRun {
                id: "run-thread-test-node-1".to_string(),
                node_id: step.node_id.clone(),
                thread_id: None,
                status: AgentGraphNodeRunStatus::Running,
                error: None,
            }],
            output: None,
            error: None,
        };

        let thread_id = create_agent_graph_thread(
            &thread_store,
            &serde_json::json!({}),
            "Pipeline",
            &step,
            &run,
            0,
        )
        .unwrap();
        let listed = call_rust_state_service(
            &thread_store,
            serde_json::json!({}),
            WorkerRequest::new(
                "request-list-graph-thread",
                "trace-list-graph-thread",
                "thread.list",
                serde_json::json!({ "includeChildThreads": true }),
            ),
            "Graph Thread test list",
        )
        .unwrap();
        let thread = listed["threads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|candidate| candidate["threadId"] == thread_id)
            .unwrap();

        assert_eq!(thread["source"], "agent_graph");
        assert!(thread["parentThreadId"].is_null());
        assert_eq!(thread["metadata"]["workingDirectory"], step.workspace_path);
        assert_eq!(thread["metadata"]["extra"]["graphRunId"], run.id);
        assert_eq!(thread["metadata"]["extra"]["graphNodeId"], step.node_id);
    }
}

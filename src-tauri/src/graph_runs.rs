use crate::agent::bridge::{execute_thread_turn_with_services, SubmitThreadTurnInput};
use crate::agent::router;
use crate::agent::runtime::{NativeAgentCancellationContext, NativeAgentRuntimeServices};
#[cfg(test)]
use crate::agent_graphs::AgentLoopReasoningEffort;
use crate::agent_graphs::{
    self, validate_graph_id, AgentGraphDefinition, AgentGraphNodeConfig, AgentGraphNodeKind,
    AgentGraphRouterNodeConfig, AgentLoopModelConfig,
};
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
    Cancelled,
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
    router: Option<AgentGraphRouterRun>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentGraphRouterRun {
    raw_response: String,
    selected_route_id: String,
    selected_edge_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    usage: Option<serde_json::Value>,
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
    input: String,
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
    pub(crate) graph_id: String,
    pub(crate) graph_revision: String,
    pub(crate) definition_workspace_path: String,
    pub(crate) input: String,
}

#[derive(Clone, Debug)]
struct AgentGraphPlan {
    input_node_id: String,
    nodes: HashMap<String, PlannedNode>,
    outgoing: HashMap<String, Vec<PlannedEdge>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AgentStep {
    node_id: String,
    workspace_path: String,
    instructions: String,
    model: Option<AgentLoopModelConfig>,
}

#[derive(Clone, Debug)]
enum PlannedNode {
    Input,
    Agent(AgentStep),
    Router(AgentGraphRouterNodeConfig),
    Output,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PlannedEdge {
    id: String,
    target: String,
    source_route_id: Option<String>,
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
    cancellation: Option<NativeAgentCancellationContext>,
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
    let plan = agent_graph_plan(&stored.definition)?;
    let graph_input = input.input;
    let run_id = generate_run_id(data_root, &stored.definition.id);
    let mut run = AgentGraphRun {
        schema_version: AGENT_GRAPH_RUN_SCHEMA_VERSION.to_string(),
        id: run_id.clone(),
        graph_id: stored.definition.id.clone(),
        graph_revision: stored.revision.clone(),
        definition_workspace_path,
        status: AgentGraphRunStatus::Running,
        input: graph_input.clone(),
        node_runs: Vec::new(),
        output: None,
        error: None,
    };
    write_run(data_root, &run)?;

    let thread_store = base_services.thread_store()?;
    let mut current_input = graph_input;
    let mut cursor = single_outgoing_edge(&plan, &plan.input_node_id)?
        .target
        .clone();
    loop {
        if cancellation
            .as_ref()
            .is_some_and(NativeAgentCancellationContext::is_cancelled)
        {
            return finish_cancelled_run(data_root, run, None);
        }
        let node = plan
            .nodes
            .get(&cursor)
            .cloned()
            .ok_or_else(|| format!("Agent Graph path references missing node `{cursor}`"))?;
        match node {
            PlannedNode::Output => break,
            PlannedNode::Agent(step) => {
                let index = begin_node_run(data_root, &mut run, &step.node_id)?;
                let thread_id = match create_agent_graph_thread(
                    &thread_store,
                    &config_snapshot,
                    &stored.definition.name,
                    &step,
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
                        spec: agent_turn_spec(&run, &step, &node_run_id, &turn_id),
                    },
                    workspace_root.clone(),
                    config_snapshot.clone(),
                    None,
                );
                tokio::pin!(result);
                let result = if let Some(cancellation) = cancellation.as_ref() {
                    tokio::select! {
                        biased;
                        _ = cancellation.cancelled() => {
                            base_services.cancel(&turn_id);
                            let _ = (&mut result).await;
                            return finish_cancelled_run(data_root, run, Some(index));
                        }
                        result = &mut result => result,
                    }
                } else {
                    result.await
                };
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
                cursor = single_outgoing_edge(&plan, &step.node_id)?.target.clone();
            }
            PlannedNode::Router(router_config) => {
                let index = begin_node_run(data_root, &mut run, &cursor)?;
                let decision = router::route(&config_snapshot, &current_input, &router_config);
                tokio::pin!(decision);
                let decision = if let Some(cancellation) = cancellation.as_ref() {
                    tokio::select! {
                        biased;
                        _ = cancellation.cancelled() => {
                            return finish_cancelled_run(data_root, run, Some(index));
                        }
                        decision = &mut decision => decision,
                    }
                } else {
                    decision.await
                };
                let decision = match decision {
                    Ok(decision) => decision,
                    Err(error) => return finish_failed_run(data_root, run, index, error),
                };
                let edge = match plan
                    .outgoing
                    .get(&cursor)
                    .into_iter()
                    .flatten()
                    .find(|edge| edge.source_route_id.as_deref() == Some(&decision.route_id))
                    .cloned()
                {
                    Some(edge) => edge,
                    None => {
                        return finish_failed_run(
                            data_root,
                            run,
                            index,
                            format!(
                            "Router node `{cursor}` selected route `{}` without an outgoing edge",
                            decision.route_id
                        ),
                        )
                    }
                };
                run.node_runs[index].router = Some(AgentGraphRouterRun {
                    raw_response: decision.raw_response,
                    selected_route_id: decision.route_id,
                    selected_edge_id: edge.id.clone(),
                    usage: decision.usage,
                });
                run.node_runs[index].status = AgentGraphNodeRunStatus::Completed;
                write_run(data_root, &run)?;
                cursor = edge.target;
            }
            PlannedNode::Input => {
                return Err(format!("Agent Graph path re-entered Input node `{cursor}`"));
            }
        }
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

fn agent_graph_plan(definition: &AgentGraphDefinition) -> Result<AgentGraphPlan, String> {
    let input = definition
        .nodes
        .iter()
        .find(|node| node.kind == AgentGraphNodeKind::Input)
        .ok_or_else(|| "Agent Graph Run requires an Input node".to_string())?;

    let mut nodes = HashMap::new();
    for node in &definition.nodes {
        let planned = match node.kind {
            AgentGraphNodeKind::Input => PlannedNode::Input,
            AgentGraphNodeKind::Output => PlannedNode::Output,
            AgentGraphNodeKind::Agent => {
                let Some(AgentGraphNodeConfig::Agent(config)) = node.config.as_ref() else {
                    return Err(format!(
                        "Agent node `{}` has invalid workspace configuration",
                        node.id
                    ));
                };
                let canonical =
                    canonical_workspace(Path::new(&config.workspace_path)).map_err(|error| {
                        format!("Agent node `{}` workspace is invalid: {error}", node.id)
                    })?;
                PlannedNode::Agent(AgentStep {
                    node_id: node.id.clone(),
                    workspace_path: workspace_id(&canonical),
                    instructions: config.instructions.clone(),
                    model: config.model.clone(),
                })
            }
            AgentGraphNodeKind::Condition => {
                let Some(AgentGraphNodeConfig::Router(config)) = node.config.as_ref() else {
                    return Err(format!("Router node `{}` is not configured", node.id));
                };
                PlannedNode::Router(config.clone())
            }
        };
        nodes.insert(node.id.clone(), planned);
    }

    let mut incoming = HashMap::<String, Vec<String>>::new();
    let mut outgoing = HashMap::<String, Vec<PlannedEdge>>::new();
    for edge in &definition.edges {
        incoming
            .entry(edge.target.clone())
            .or_default()
            .push(edge.source.clone());
        outgoing
            .entry(edge.source.clone())
            .or_default()
            .push(PlannedEdge {
                id: edge.id.clone(),
                target: edge.target.clone(),
                source_route_id: edge.source_route_id.clone(),
            });
    }

    for node in &definition.nodes {
        let incoming_count = incoming.get(&node.id).map_or(0, Vec::len);
        let outgoing_edges = outgoing.get(&node.id).map(Vec::as_slice).unwrap_or(&[]);
        let outgoing_count = outgoing_edges.len();
        match nodes.get(&node.id).expect("planned node must exist") {
            PlannedNode::Input if incoming_count == 0 && outgoing_count == 1 => {}
            PlannedNode::Output if incoming_count >= 1 && outgoing_count == 0 => {}
            PlannedNode::Agent(_) if incoming_count >= 1 && outgoing_count == 1 => {}
            PlannedNode::Router(config)
                if incoming_count >= 1 && outgoing_count == config.routes.len() =>
            {
                for route in &config.routes {
                    let edge_count = outgoing_edges
                        .iter()
                        .filter(|edge| edge.source_route_id.as_deref() == Some(&route.id))
                        .count();
                    if edge_count != 1 {
                        return Err(format!(
                            "Router node `{}` route `{}` requires exactly one outgoing edge",
                            node.id, route.label
                        ));
                    }
                }
            }
            PlannedNode::Router(config) => {
                return Err(format!(
                    "Router node `{}` requires one incoming edge and exactly one outgoing edge for each of its {} routes; found {incoming_count} incoming and {outgoing_count} outgoing edges",
                    node.id,
                    config.routes.len()
                ));
            }
            _ => {
                return Err(format!(
                    "Agent Graph node `{}` has unsupported topology: {incoming_count} incoming and {outgoing_count} outgoing edges",
                    node.id
                ));
            }
        }
    }

    let reachable_from_input = reachable_nodes(&input.id, &outgoing);
    if reachable_from_input.len() != nodes.len() {
        return Err("Agent Graph Run does not support disconnected nodes".to_string());
    }
    let output = definition
        .nodes
        .iter()
        .find(|node| node.kind == AgentGraphNodeKind::Output)
        .ok_or_else(|| "Agent Graph Run requires an Output node".to_string())?;
    let reverse = incoming
        .iter()
        .map(|(target, sources)| {
            (
                target.clone(),
                sources
                    .iter()
                    .map(|source| PlannedEdge {
                        id: String::new(),
                        target: source.clone(),
                        source_route_id: None,
                    })
                    .collect(),
            )
        })
        .collect::<HashMap<_, _>>();
    if reachable_nodes(&output.id, &reverse).len() != nodes.len() {
        return Err("Every Agent Graph path must reach the Output node".to_string());
    }
    ensure_acyclic(&nodes, &outgoing, &incoming)?;

    Ok(AgentGraphPlan {
        input_node_id: input.id.clone(),
        nodes,
        outgoing,
    })
}

fn reachable_nodes(start: &str, outgoing: &HashMap<String, Vec<PlannedEdge>>) -> HashSet<String> {
    let mut visited = HashSet::new();
    let mut pending = vec![start.to_string()];
    while let Some(node_id) = pending.pop() {
        if !visited.insert(node_id.clone()) {
            continue;
        }
        if let Some(edges) = outgoing.get(&node_id) {
            pending.extend(edges.iter().map(|edge| edge.target.clone()));
        }
    }
    visited
}

fn ensure_acyclic(
    nodes: &HashMap<String, PlannedNode>,
    outgoing: &HashMap<String, Vec<PlannedEdge>>,
    incoming: &HashMap<String, Vec<String>>,
) -> Result<(), String> {
    let mut incoming_counts = nodes
        .keys()
        .map(|node_id| (node_id.clone(), incoming.get(node_id).map_or(0, Vec::len)))
        .collect::<HashMap<_, _>>();
    let mut pending = incoming_counts
        .iter()
        .filter_map(|(node_id, count)| (*count == 0).then_some(node_id.clone()))
        .collect::<Vec<_>>();
    let mut visited_count = 0;
    while let Some(node_id) = pending.pop() {
        visited_count += 1;
        if let Some(edges) = outgoing.get(&node_id) {
            for edge in edges {
                let count = incoming_counts
                    .get_mut(&edge.target)
                    .expect("edge target must be a planned node");
                *count -= 1;
                if *count == 0 {
                    pending.push(edge.target.clone());
                }
            }
        }
    }
    if visited_count != nodes.len() {
        return Err("Agent Graph Run does not support cycles".to_string());
    }
    Ok(())
}

fn single_outgoing_edge<'a>(
    plan: &'a AgentGraphPlan,
    node_id: &str,
) -> Result<&'a PlannedEdge, String> {
    let edges = plan.outgoing.get(node_id).map(Vec::as_slice).unwrap_or(&[]);
    if edges.len() != 1 {
        return Err(format!(
            "Agent Graph node `{node_id}` requires exactly one outgoing edge"
        ));
    }
    Ok(&edges[0])
}

fn begin_node_run(
    data_root: &Path,
    run: &mut AgentGraphRun,
    node_id: &str,
) -> Result<usize, String> {
    let index = run.node_runs.len();
    run.node_runs.push(AgentGraphNodeRun {
        id: format!("{}-node-{}", run.id, index + 1),
        node_id: node_id.to_string(),
        thread_id: None,
        status: AgentGraphNodeRunStatus::Running,
        router: None,
        error: None,
    });
    write_run(data_root, run)?;
    Ok(index)
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

fn agent_turn_spec(
    run: &AgentGraphRun,
    step: &AgentStep,
    node_run_id: &str,
    turn_id: &str,
) -> serde_json::Value {
    let mut spec = serde_json::json!({
        "runtime": "rust",
        "stream": true,
        "turnId": turn_id,
        "metadata": graph_turn_metadata(run, step, node_run_id),
    });
    if !step.instructions.trim().is_empty() {
        spec["agentRole"] = serde_json::Value::String(format!(
            "# Agent Graph node instructions\n\n{}",
            step.instructions.trim()
        ));
    }
    if let Some(model) = &step.model {
        spec["model"] = serde_json::Value::String(model.model_id.trim().to_string());
        if let Some(provider_id) = &model.provider_id {
            spec["provider"] = serde_json::Value::String(provider_id.trim().to_string());
        }
        if let Some(reasoning_effort) = model.reasoning_effort {
            spec["reasoningEffort"] =
                serde_json::Value::String(reasoning_effort.as_str().to_string());
        }
    }
    spec
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

fn finish_cancelled_run(
    data_root: &Path,
    mut run: AgentGraphRun,
    node_index: Option<usize>,
) -> Result<AgentGraphRun, String> {
    run.status = AgentGraphRunStatus::Cancelled;
    if let Some(node_index) = node_index {
        run.node_runs[node_index].status = AgentGraphNodeRunStatus::Cancelled;
    }
    write_run(data_root, &run)?;
    eprintln!(
        "agent_graph_run_cancelled graph_id={} run_id={}",
        run.graph_id, run.id
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
                    { "id": "agent-1", "kind": "agent", "position": { "x": 100, "y": 0 }, "config": { "workspacePath": self.first_workspace, "instructions": "" } },
                    { "id": "agent-2", "kind": "agent", "position": { "x": 200, "y": 0 }, "config": { "workspacePath": self.second_workspace, "instructions": "" } },
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

        let plan = agent_graph_plan(&fixture.definition()).unwrap();

        let PlannedNode::Agent(first) = &plan.nodes["agent-1"] else {
            panic!("agent-1 should be planned as an Agent node");
        };
        assert_eq!(
            first.workspace_path,
            workspace_id(&canonical_workspace(&fixture.first_workspace).unwrap())
        );
        assert_eq!(
            single_outgoing_edge(&plan, "agent-2").unwrap().target,
            "output"
        );
    }

    #[test]
    fn maps_agent_node_instructions_and_model_to_the_turn_spec() {
        let fixture = Fixture::new();
        let step = AgentStep {
            node_id: "agent-1".to_string(),
            workspace_path: workspace_id(&canonical_workspace(&fixture.first_workspace).unwrap()),
            instructions: "  Research the topic and return a sourced report.  ".to_string(),
            model: Some(AgentLoopModelConfig {
                model_id: " gpt-5.6-sol ".to_string(),
                provider_id: Some(" openai ".to_string()),
                reasoning_effort: Some(AgentLoopReasoningEffort::High),
            }),
        };
        let run = AgentGraphRun {
            schema_version: AGENT_GRAPH_RUN_SCHEMA_VERSION.to_string(),
            id: "run-spec-test".to_string(),
            graph_id: "graph-1".to_string(),
            graph_revision: "sha256:test".to_string(),
            definition_workspace_path: step.workspace_path.clone(),
            status: AgentGraphRunStatus::Running,
            input: "start".to_string(),
            node_runs: Vec::new(),
            output: None,
            error: None,
        };

        let spec = agent_turn_spec(&run, &step, "node-run-1", "turn-1");

        assert_eq!(
            spec["agentRole"],
            "# Agent Graph node instructions\n\nResearch the topic and return a sourced report."
        );
        assert_eq!(spec["model"], "gpt-5.6-sol");
        assert_eq!(spec["provider"], "openai");
        assert_eq!(spec["reasoningEffort"], "high");
        assert_eq!(spec["metadata"]["graphNodeId"], "agent-1");
    }

    #[test]
    fn inherited_agent_settings_leave_turn_overrides_absent() {
        let fixture = Fixture::new();
        let step = AgentStep {
            node_id: "agent-1".to_string(),
            workspace_path: workspace_id(&canonical_workspace(&fixture.first_workspace).unwrap()),
            instructions: String::new(),
            model: None,
        };
        let run = AgentGraphRun {
            schema_version: AGENT_GRAPH_RUN_SCHEMA_VERSION.to_string(),
            id: "run-defaults-test".to_string(),
            graph_id: "graph-1".to_string(),
            graph_revision: "sha256:test".to_string(),
            definition_workspace_path: step.workspace_path.clone(),
            status: AgentGraphRunStatus::Running,
            input: "start".to_string(),
            node_runs: Vec::new(),
            output: None,
            error: None,
        };

        let spec = agent_turn_spec(&run, &step, "node-run-1", "turn-1");

        assert!(spec.get("agentRole").is_none());
        assert!(spec.get("model").is_none());
        assert!(spec.get("provider").is_none());
        assert!(spec.get("reasoningEffort").is_none());
    }

    #[test]
    fn rejects_a_branch_from_a_non_router_node() {
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

        let error = agent_graph_plan(&definition).unwrap_err();

        assert!(error.contains("unsupported topology"));
    }

    #[test]
    fn plans_router_routes_by_stable_route_id() {
        let fixture = Fixture::new();
        let definition: AgentGraphDefinition = serde_json::from_value(serde_json::json!({
            "schemaVersion": "tinybot.agent_graph.v1",
            "id": "graph-router",
            "name": "Router",
            "nodes": [
                { "id": "input", "kind": "input", "position": { "x": 0, "y": 0 } },
                { "id": "router", "kind": "condition", "position": { "x": 100, "y": 0 }, "config": {
                    "task": "Choose the best specialist.",
                    "routes": [
                        { "id": "route-a", "label": "Code", "description": "A code change is needed." },
                        { "id": "route-b", "label": "Docs", "description": "Only documentation is needed." }
                    ]
                } },
                { "id": "agent-1", "kind": "agent", "position": { "x": 200, "y": -50 }, "config": { "workspacePath": fixture.first_workspace, "instructions": "" } },
                { "id": "agent-2", "kind": "agent", "position": { "x": 200, "y": 50 }, "config": { "workspacePath": fixture.second_workspace, "instructions": "" } },
                { "id": "output", "kind": "output", "position": { "x": 300, "y": 0 } }
            ],
            "edges": [
                { "id": "edge-input", "source": "input", "target": "router" },
                { "id": "edge-code", "source": "router", "target": "agent-1", "sourceRouteId": "route-a" },
                { "id": "edge-docs", "source": "router", "target": "agent-2", "sourceRouteId": "route-b" },
                { "id": "edge-code-output", "source": "agent-1", "target": "output" },
                { "id": "edge-docs-output", "source": "agent-2", "target": "output" }
            ]
        }))
        .unwrap();

        let plan = agent_graph_plan(&definition).unwrap();
        let router_edges = &plan.outgoing["router"];

        assert_eq!(router_edges.len(), 2);
        assert_eq!(router_edges[0].source_route_id.as_deref(), Some("route-a"));
        assert_eq!(router_edges[0].target, "agent-1");
        assert_eq!(router_edges[1].source_route_id.as_deref(), Some("route-b"));
        assert_eq!(router_edges[1].target, "agent-2");
    }

    #[test]
    fn rejects_cycles_even_when_a_router_can_reach_output() {
        let fixture = Fixture::new();
        let definition: AgentGraphDefinition = serde_json::from_value(serde_json::json!({
            "schemaVersion": "tinybot.agent_graph.v1",
            "id": "graph-cycle",
            "name": "Cycle",
            "nodes": [
                { "id": "input", "kind": "input", "position": { "x": 0, "y": 0 } },
                { "id": "router", "kind": "condition", "position": { "x": 100, "y": 0 }, "config": { "routes": [
                    { "id": "again", "label": "Again", "description": "Repeat." },
                    { "id": "done", "label": "Done", "description": "Finish." }
                ] } },
                { "id": "agent", "kind": "agent", "position": { "x": 200, "y": 0 }, "config": { "workspacePath": fixture.first_workspace, "instructions": "" } },
                { "id": "output", "kind": "output", "position": { "x": 300, "y": 0 } }
            ],
            "edges": [
                { "id": "edge-input", "source": "input", "target": "router" },
                { "id": "edge-again", "source": "router", "target": "agent", "sourceRouteId": "again" },
                { "id": "edge-done", "source": "router", "target": "output", "sourceRouteId": "done" },
                { "id": "edge-cycle", "source": "agent", "target": "router" }
            ]
        }))
        .unwrap();

        let error = agent_graph_plan(&definition).unwrap_err();

        assert!(error.contains("cycles"));
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
            input: "start".to_string(),
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
    fn completed_run_uses_the_runtime_input() {
        let fixture = Fixture::new();
        let graph_directory = fixture.first_workspace.join(".tinybot/graphs");
        fs::create_dir_all(&graph_directory).unwrap();
        fs::write(
            graph_directory.join("runtime-input.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schemaVersion": "tinybot.agent_graph.v1",
                "id": "runtime-input",
                "name": "Runtime input",
                "nodes": [
                    { "id": "input", "kind": "input", "position": { "x": 0, "y": 0 } },
                    { "id": "output", "kind": "output", "position": { "x": 100, "y": 0 } }
                ],
                "edges": [{ "id": "edge", "source": "input", "target": "output" }]
            }))
            .unwrap(),
        )
        .unwrap();
        let stored = agent_graphs::list_for_workspace(&fixture.first_workspace)
            .unwrap()
            .remove(0);
        let data_root = fixture.root.join("data");
        let services = NativeAgentRuntimeServices::with_subagent_manager(Default::default())
            .with_thread_store(
                crate::threads::workspace_store::WorkspaceThreadStore::new_with_data_root(
                    fixture.first_workspace.clone(),
                    data_root.clone(),
                    crate::protocol::capability::default_desktop_capability_policy(),
                ),
            );

        let run = tauri::async_runtime::block_on(start(
            &data_root,
            services,
            fixture.root.clone(),
            serde_json::json!({}),
            StartAgentGraphRunInput {
                graph_id: stored.definition.id,
                graph_revision: stored.revision,
                definition_workspace_path: fixture.first_workspace.display().to_string(),
                input: "Analyze alert 42".to_string(),
            },
            None,
        ))
        .unwrap();

        assert_eq!(run.status, AgentGraphRunStatus::Completed);
        assert_eq!(run.input, "Analyze alert 42");
        assert_eq!(run.output.as_deref(), Some("Analyze alert 42"));
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
            instructions: String::new(),
            model: None,
        };
        let run = AgentGraphRun {
            schema_version: AGENT_GRAPH_RUN_SCHEMA_VERSION.to_string(),
            id: "run-thread-test".to_string(),
            graph_id: "graph-1".to_string(),
            graph_revision: "sha256:test".to_string(),
            definition_workspace_path: step.workspace_path.clone(),
            status: AgentGraphRunStatus::Running,
            input: "start".to_string(),
            node_runs: vec![AgentGraphNodeRun {
                id: "run-thread-test-node-1".to_string(),
                node_id: step.node_id.clone(),
                thread_id: None,
                status: AgentGraphNodeRunStatus::Running,
                router: None,
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

use crate::project_groups::canonical_workspace;
use crate::storage::atomic::{write_text_atomic, AtomicWriteOptions, WorkerStorageError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

const AGENT_GRAPH_SCHEMA_VERSION: &str = "tinybot.agent_graph.v1";
static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentGraphDefinition {
    pub(crate) schema_version: String,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) nodes: Vec<AgentGraphNode>,
    pub(crate) edges: Vec<AgentGraphEdge>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentGraphNode {
    pub(crate) id: String,
    pub(crate) kind: AgentGraphNodeKind,
    position: AgentGraphNodePosition,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) config: Option<AgentGraphNodeConfig>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AgentGraphNodeKind {
    Input,
    Agent,
    Condition,
    Output,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AgentGraphNodePosition {
    x: i64,
    y: i64,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub(crate) enum AgentGraphNodeConfig {
    Input(AgentGraphInputNodeConfig),
    Agent(AgentLoopNodeConfig),
    Router(AgentGraphRouterNodeConfig),
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentGraphInputNodeConfig {
    pub(crate) prompt: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentGraphRouterNodeConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) task: Option<String>,
    pub(crate) routes: Vec<AgentGraphRouterRoute>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<AgentLoopModelConfig>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentGraphRouterRoute {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) description: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentLoopNodeConfig {
    pub(crate) workspace_path: String,
    pub(crate) instructions: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<AgentLoopModelConfig>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentLoopModelConfig {
    pub(crate) model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reasoning_effort: Option<AgentLoopReasoningEffort>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AgentLoopReasoningEffort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl AgentLoopReasoningEffort {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentGraphEdge {
    pub(crate) id: String,
    pub(crate) source: String,
    pub(crate) target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) source_route_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredAgentGraph {
    pub(crate) definition: AgentGraphDefinition,
    pub(crate) revision: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListAgentGraphsInput {
    workspace_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveAgentGraphInput {
    workspace_path: String,
    definition: AgentGraphDefinition,
    #[serde(default)]
    expected_revision: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeleteAgentGraphInput {
    workspace_path: String,
    graph_id: String,
    expected_revision: String,
}

pub(crate) fn list(input: ListAgentGraphsInput) -> Result<Vec<StoredAgentGraph>, String> {
    let workspace = canonical_workspace(Path::new(&input.workspace_path))?;
    let _guard = store_lock()?;
    let directory = graph_directory(&workspace)?;
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(io_error("read Agent Graph directory", &directory, error)),
    };
    let mut graphs = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| io_error("read Agent Graph entry", &directory, error))?;
        let path = entry.path();
        if !entry
            .file_type()
            .map_err(|error| io_error("inspect Agent Graph entry", &path, error))?
            .is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }
        graphs.push(read_stored_graph(&path)?);
    }
    graphs.sort_by(|left, right| {
        left.definition
            .name
            .to_lowercase()
            .cmp(&right.definition.name.to_lowercase())
            .then_with(|| left.definition.id.cmp(&right.definition.id))
    });
    Ok(graphs)
}

pub(crate) fn load(
    workspace_path: &str,
    graph_id: &str,
    expected_revision: &str,
) -> Result<StoredAgentGraph, String> {
    let workspace = canonical_workspace(Path::new(workspace_path))?;
    let _guard = store_lock()?;
    let stored = read_stored_graph(&graph_path(&workspace, graph_id)?)?;
    if stored.revision != expected_revision.trim() {
        return Err(format!(
            "Agent Graph revision conflict: expected `{}`, current `{}`",
            expected_revision.trim(),
            stored.revision
        ));
    }
    Ok(stored)
}

pub(crate) fn save(input: SaveAgentGraphInput) -> Result<StoredAgentGraph, String> {
    let workspace = canonical_workspace(Path::new(&input.workspace_path))?;
    validate_definition(&input.definition)?;
    let path = graph_path(&workspace, &input.definition.id)?;
    let _guard = store_lock()?;
    verify_expected_revision(&path, input.expected_revision.as_deref())?;
    let contents = format!(
        "{}\n",
        serde_json::to_string_pretty(&input.definition)
            .map_err(|error| format!("failed to serialize Agent Graph: {error}"))?
    );
    write_text_atomic(&path, &contents, AtomicWriteOptions::default()).map_err(storage_error)?;
    let stored = StoredAgentGraph {
        definition: input.definition,
        revision: revision(contents.as_bytes()),
    };
    eprintln!("agent_graph_saved graph_id={}", stored.definition.id);
    Ok(stored)
}

pub(crate) fn delete(input: DeleteAgentGraphInput) -> Result<(), String> {
    let workspace = canonical_workspace(Path::new(&input.workspace_path))?;
    let path = graph_path(&workspace, &input.graph_id)?;
    let _guard = store_lock()?;
    verify_required_revision(&path, &input.expected_revision)?;
    fs::remove_file(&path).map_err(|error| io_error("delete Agent Graph", &path, error))?;
    eprintln!("agent_graph_deleted graph_id={}", input.graph_id);
    Ok(())
}

fn read_stored_graph(path: &Path) -> Result<StoredAgentGraph, String> {
    let contents = fs::read(path).map_err(|error| io_error("read Agent Graph", path, error))?;
    let definition: AgentGraphDefinition = serde_json::from_slice(&contents)
        .map_err(|error| format!("failed to parse Agent Graph {}: {error}", path.display()))?;
    validate_definition(&definition)
        .map_err(|error| format!("invalid Agent Graph {}: {error}", path.display()))?;
    let expected_name = format!("{}.json", definition.id);
    if path.file_name().and_then(|value| value.to_str()) != Some(expected_name.as_str()) {
        return Err(format!(
            "Agent Graph file name must match definition id `{}`: {}",
            definition.id,
            path.display()
        ));
    }
    Ok(StoredAgentGraph {
        definition,
        revision: revision(&contents),
    })
}

fn validate_definition(definition: &AgentGraphDefinition) -> Result<(), String> {
    if definition.schema_version != AGENT_GRAPH_SCHEMA_VERSION {
        return Err(format!(
            "unsupported Agent Graph schema version `{}`",
            definition.schema_version
        ));
    }
    validate_graph_id(&definition.id)?;
    if definition.name.trim().is_empty() {
        return Err("Agent Graph name must not be empty".to_string());
    }
    let mut node_ids = HashSet::new();
    let mut input_count = 0;
    let mut output_count = 0;
    for node in &definition.nodes {
        if node.id.trim().is_empty() {
            return Err("Agent Graph node id must not be empty".to_string());
        }
        if !node_ids.insert(node.id.as_str()) {
            return Err(format!("duplicate Agent Graph node id `{}`", node.id));
        }
        match node.kind {
            AgentGraphNodeKind::Input => {
                input_count += 1;
                let Some(AgentGraphNodeConfig::Input(config)) = &node.config else {
                    return Err(format!(
                        "Input node `{}` requires Input configuration",
                        node.id
                    ));
                };
                if config.prompt.trim().is_empty() {
                    return Err(format!("Input node `{}` requires a prompt", node.id));
                }
            }
            AgentGraphNodeKind::Output => {
                output_count += 1;
                if node.config.is_some() {
                    return Err(format!(
                        "Output node `{}` cannot have configuration",
                        node.id
                    ));
                }
            }
            AgentGraphNodeKind::Agent => {
                let Some(AgentGraphNodeConfig::Agent(config)) = &node.config else {
                    return Err(format!(
                        "Agent node `{}` requires Agent configuration",
                        node.id
                    ));
                };
                if config.workspace_path.trim().is_empty() {
                    return Err(format!(
                        "Agent node `{}` requires a workspace path",
                        node.id
                    ));
                }
                if let Some(model) = &config.model {
                    if model.model_id.trim().is_empty() {
                        return Err(format!("Agent node `{}` has an empty model id", node.id));
                    }
                    if model
                        .provider_id
                        .as_ref()
                        .is_some_and(|provider_id| provider_id.trim().is_empty())
                    {
                        return Err(format!("Agent node `{}` has an empty provider id", node.id));
                    }
                }
            }
            AgentGraphNodeKind::Condition => {
                let Some(config) = &node.config else {
                    continue;
                };
                let AgentGraphNodeConfig::Router(config) = config else {
                    return Err(format!(
                        "Condition node `{}` requires Router configuration",
                        node.id
                    ));
                };
                if config.routes.len() < 2 {
                    return Err(format!(
                        "Condition node `{}` requires at least two routes",
                        node.id
                    ));
                }
                let mut route_ids = HashSet::new();
                for route in &config.routes {
                    if route.id.trim().is_empty() || !route_ids.insert(route.id.as_str()) {
                        return Err(format!(
                            "Condition node `{}` has an invalid or duplicate route id",
                            node.id
                        ));
                    }
                    if route.label.trim().is_empty() || route.description.trim().is_empty() {
                        return Err(format!(
                            "Condition node `{}` routes require labels and descriptions",
                            node.id
                        ));
                    }
                }
                validate_model_config(&node.id, config.model.as_ref())?;
            }
        }
    }
    if input_count != 1 {
        return Err("Agent Graph requires exactly one Input node".to_string());
    }
    if output_count != 1 {
        return Err("Agent Graph requires exactly one Output node".to_string());
    }

    let mut edge_ids = HashSet::new();
    let mut endpoints = HashSet::new();
    for edge in &definition.edges {
        if edge.id.trim().is_empty() || !edge_ids.insert(edge.id.as_str()) {
            return Err(format!(
                "invalid or duplicate Agent Graph edge id `{}`",
                edge.id
            ));
        }
        if !node_ids.contains(edge.source.as_str()) || !node_ids.contains(edge.target.as_str()) {
            return Err(format!(
                "Agent Graph edge `{}` has a missing endpoint",
                edge.id
            ));
        }
        if edge.source == edge.target {
            return Err(format!(
                "Agent Graph edge `{}` cannot target itself",
                edge.id
            ));
        }
        if !endpoints.insert((edge.source.as_str(), edge.target.as_str())) {
            return Err(format!(
                "duplicate Agent Graph edge from `{}` to `{}`",
                edge.source, edge.target
            ));
        }
        let source = definition
            .nodes
            .iter()
            .find(|node| node.id == edge.source)
            .expect("edge source was checked");
        let target = definition
            .nodes
            .iter()
            .find(|node| node.id == edge.target)
            .expect("edge target was checked");
        if source.kind == AgentGraphNodeKind::Output {
            return Err("Output node cannot have outgoing edges".to_string());
        }
        if target.kind == AgentGraphNodeKind::Input {
            return Err("Input node cannot have incoming edges".to_string());
        }
        if source.kind == AgentGraphNodeKind::Condition {
            if let Some(AgentGraphNodeConfig::Router(config)) = source.config.as_ref() {
                let route_id = edge.source_route_id.as_deref().ok_or_else(|| {
                    format!("Condition edge `{}` requires a source route", edge.id)
                })?;
                if !config.routes.iter().any(|route| route.id == route_id) {
                    return Err(format!(
                        "Condition edge `{}` references missing route `{route_id}`",
                        edge.id
                    ));
                }
            }
        } else if edge.source_route_id.is_some() {
            return Err(format!(
                "non-Condition edge `{}` cannot reference a source route",
                edge.id
            ));
        }
    }
    for node in &definition.nodes {
        let Some(AgentGraphNodeConfig::Router(config)) = node.config.as_ref() else {
            continue;
        };
        for route in &config.routes {
            let edge_count = definition
                .edges
                .iter()
                .filter(|edge| {
                    edge.source == node.id && edge.source_route_id.as_deref() == Some(&route.id)
                })
                .count();
            if edge_count != 1 {
                return Err(format!(
                    "Condition node `{}` route `{}` requires exactly one outgoing edge",
                    node.id, route.id
                ));
            }
        }
    }
    Ok(())
}

fn validate_model_config(
    node_id: &str,
    model: Option<&AgentLoopModelConfig>,
) -> Result<(), String> {
    let Some(model) = model else {
        return Ok(());
    };
    if model.model_id.trim().is_empty() {
        return Err(format!(
            "Agent Graph node `{node_id}` has an empty model id"
        ));
    }
    if model
        .provider_id
        .as_ref()
        .is_some_and(|provider_id| provider_id.trim().is_empty())
    {
        return Err(format!(
            "Agent Graph node `{node_id}` has an empty provider id"
        ));
    }
    Ok(())
}

pub(crate) fn validate_graph_id(graph_id: &str) -> Result<(), String> {
    if graph_id.is_empty()
        || graph_id.len() > 128
        || !graph_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'-' || value == b'_')
    {
        return Err(
            "Agent Graph id must contain only letters, numbers, hyphens, or underscores"
                .to_string(),
        );
    }
    Ok(())
}

fn verify_expected_revision(path: &Path, expected: Option<&str>) -> Result<(), String> {
    match (read_revision(path)?, expected) {
        (None, None) => Ok(()),
        (Some(current), Some(expected)) if current == expected.trim() => Ok(()),
        (Some(_), None) => {
            Err("Agent Graph already exists; expectedRevision is required".to_string())
        }
        (None, Some(_)) => Err("Agent Graph no longer exists".to_string()),
        (Some(current), Some(expected)) => Err(format!(
            "Agent Graph revision conflict: expected `{}`, current `{current}`",
            expected.trim()
        )),
    }
}

fn verify_required_revision(path: &Path, expected: &str) -> Result<(), String> {
    match read_revision(path)? {
        None => Err("Agent Graph no longer exists".to_string()),
        Some(current) if current == expected.trim() => Ok(()),
        Some(current) => Err(format!(
            "Agent Graph revision conflict: expected `{}`, current `{current}`",
            expected.trim()
        )),
    }
}

fn read_revision(path: &Path) -> Result<Option<String>, String> {
    match fs::read(path) {
        Ok(contents) => Ok(Some(revision(&contents))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error("read Agent Graph revision", path, error)),
    }
}

fn revision(contents: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(contents))
}

fn graph_directory(workspace: &Path) -> Result<PathBuf, String> {
    let tinybot_directory = workspace.join(".tinybot");
    let graph_directory = tinybot_directory.join("graphs");
    let existing_parent = if graph_directory.exists() {
        graph_directory.as_path()
    } else if tinybot_directory.exists() {
        tinybot_directory.as_path()
    } else {
        workspace
    };
    let canonical_parent = fs::canonicalize(existing_parent).map_err(|error| {
        io_error(
            "resolve Agent Graph storage directory",
            existing_parent,
            error,
        )
    })?;
    if !canonical_parent.starts_with(workspace) {
        return Err(format!(
            "Agent Graph storage directory escapes workspace `{}`",
            workspace.display()
        ));
    }
    Ok(graph_directory)
}

fn graph_path(workspace: &Path, graph_id: &str) -> Result<PathBuf, String> {
    validate_graph_id(graph_id)?;
    Ok(graph_directory(workspace)?.join(format!("{graph_id}.json")))
}

fn store_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    STORE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Agent Graph store lock is poisoned".to_string())
}

fn storage_error(error: WorkerStorageError) -> String {
    format!("Agent Graph persistence failed: {error}")
}

fn io_error(operation: &str, path: &Path, error: io::Error) -> String {
    format!("failed to {operation} {}: {error}", path.display())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        workspace: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "tinybot-agent-graphs-{}-{}",
                std::process::id(),
                FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            let workspace = root.join("workspace");
            fs::create_dir_all(&workspace).unwrap();
            Self { root, workspace }
        }

        fn definition(&self) -> AgentGraphDefinition {
            AgentGraphDefinition {
                schema_version: AGENT_GRAPH_SCHEMA_VERSION.to_string(),
                id: "graph-1".to_string(),
                name: "Research".to_string(),
                nodes: vec![
                    AgentGraphNode {
                        id: "input".to_string(),
                        kind: AgentGraphNodeKind::Input,
                        position: AgentGraphNodePosition { x: 0, y: 0 },
                        config: Some(AgentGraphNodeConfig::Input(AgentGraphInputNodeConfig {
                            prompt: "Research the repository.".to_string(),
                        })),
                    },
                    AgentGraphNode {
                        id: "agent".to_string(),
                        kind: AgentGraphNodeKind::Agent,
                        position: AgentGraphNodePosition { x: 100, y: 0 },
                        config: Some(AgentGraphNodeConfig::Agent(AgentLoopNodeConfig {
                            workspace_path: self.workspace.display().to_string(),
                            instructions: "Research and return a concise report.".to_string(),
                            model: Some(AgentLoopModelConfig {
                                model_id: "gpt-5.6-sol".to_string(),
                                provider_id: Some("openai".to_string()),
                                reasoning_effort: Some(AgentLoopReasoningEffort::High),
                            }),
                        })),
                    },
                    AgentGraphNode {
                        id: "output".to_string(),
                        kind: AgentGraphNodeKind::Output,
                        position: AgentGraphNodePosition { x: 200, y: 0 },
                        config: None,
                    },
                ],
                edges: vec![
                    AgentGraphEdge {
                        id: "input-agent".to_string(),
                        source: "input".to_string(),
                        target: "agent".to_string(),
                        source_route_id: None,
                    },
                    AgentGraphEdge {
                        id: "agent-output".to_string(),
                        source: "agent".to_string(),
                        target: "output".to_string(),
                        source_route_id: None,
                    },
                ],
            }
        }

        fn workspace_path(&self) -> String {
            self.workspace.display().to_string()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn definitions_are_saved_listed_and_deleted_per_workspace() {
        let fixture = Fixture::new();
        let stored = save(SaveAgentGraphInput {
            workspace_path: fixture.workspace_path(),
            definition: fixture.definition(),
            expected_revision: None,
        })
        .unwrap();

        assert!(stored.revision.starts_with("sha256:"));
        assert_eq!(
            list(ListAgentGraphsInput {
                workspace_path: fixture.workspace_path(),
            })
            .unwrap(),
            vec![stored.clone()]
        );
        assert_eq!(
            load(&fixture.workspace_path(), "graph-1", &stored.revision,).unwrap(),
            stored.clone()
        );
        assert!(load(&fixture.workspace_path(), "graph-1", "sha256:stale")
            .unwrap_err()
            .contains("revision conflict"));
        assert!(fixture
            .workspace
            .join(".tinybot/graphs/graph-1.json")
            .is_file());

        delete(DeleteAgentGraphInput {
            workspace_path: fixture.workspace_path(),
            graph_id: "graph-1".to_string(),
            expected_revision: stored.revision,
        })
        .unwrap();
        assert!(list(ListAgentGraphsInput {
            workspace_path: fixture.workspace_path(),
        })
        .unwrap()
        .is_empty());
    }

    #[test]
    fn rejects_an_empty_input_prompt() {
        let fixture = Fixture::new();
        let mut definition = fixture.definition();
        definition.nodes[0].config = Some(AgentGraphNodeConfig::Input(AgentGraphInputNodeConfig {
            prompt: "  ".to_string(),
        }));

        let error = validate_definition(&definition).unwrap_err();

        assert!(error.contains("requires a prompt"));
    }

    #[test]
    fn stale_saves_do_not_overwrite_the_definition() {
        let fixture = Fixture::new();
        let stored = save(SaveAgentGraphInput {
            workspace_path: fixture.workspace_path(),
            definition: fixture.definition(),
            expected_revision: None,
        })
        .unwrap();
        let mut updated = stored.definition.clone();
        updated.name = "Updated".to_string();

        let error = save(SaveAgentGraphInput {
            workspace_path: fixture.workspace_path(),
            definition: updated,
            expected_revision: Some("sha256:stale".to_string()),
        })
        .unwrap_err();

        assert!(error.contains("revision conflict"));
        assert_eq!(
            list(ListAgentGraphsInput {
                workspace_path: fixture.workspace_path(),
            })
            .unwrap(),
            vec![stored]
        );
    }

    #[test]
    fn unsafe_graph_ids_are_rejected_before_writing() {
        let fixture = Fixture::new();
        let mut definition = fixture.definition();
        definition.id = "../outside".to_string();

        let error = save(SaveAgentGraphInput {
            workspace_path: fixture.workspace_path(),
            definition,
            expected_revision: None,
        })
        .unwrap_err();

        assert!(error.contains("letters, numbers, hyphens, or underscores"));
        assert!(!fixture.root.join("outside.json").exists());
    }
}

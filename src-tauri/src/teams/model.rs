use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub(super) const SCHEMA_VERSION: u32 = 3;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TeamModel {
    pub model_id: String,
    pub provider_id: Option<String>,
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TeamMember {
    pub id: String,
    pub display_name: String,
    pub instructions: String,
    pub model: Option<TeamModel>,
    #[serde(default)]
    pub tool_profile: TeamToolProfile,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TeamToolProfile {
    Research,
    #[default]
    Execution,
    Review,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TeamSpec {
    pub goal: String,
    pub workspace_path: String,
    pub members: Vec<TeamMember>,
    pub max_concurrency: usize,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TeamTask {
    pub id: String,
    pub title: String,
    pub member_id: String,
    pub instructions: String,
    pub dependencies: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TeamPlan {
    pub tasks: Vec<TeamTask>,
    pub final_task_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RunStatus {
    Planned,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TeamAttempt {
    pub thread_id: String,
    pub turn_id: String,
    pub status: TaskStatus,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub output: Option<String>,
    #[serde(default)]
    pub message: Option<super::board::BoardMessage>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskRecord {
    pub task: TeamTask,
    pub status: TaskStatus,
    pub attempts: Vec<TeamAttempt>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TeamRun {
    #[serde(default)]
    pub parent_thread_id: Option<String>,
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub spec: TeamSpec,
    pub final_task_id: String,
    pub tasks: Vec<TaskRecord>,
    pub status: RunStatus,
    pub created_at: String,
    pub updated_at: String,
    pub error: Option<String>,
}

pub(super) fn identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 120
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(format!("Invalid Team identifier: {value:?}"));
    }
    Ok(())
}

pub(super) fn validate_model(model: &TeamModel) -> Result<(), String> {
    if model.model_id.trim().is_empty()
        || model
            .provider_id
            .as_ref()
            .is_some_and(|id| id.trim().is_empty())
    {
        return Err("Team model and provider identifiers must not be blank".into());
    }
    if model
        .reasoning_effort
        .as_deref()
        .is_some_and(|effort| !matches!(effort, "low" | "medium" | "high" | "xhigh" | "max"))
    {
        return Err("Invalid Team model reasoning effort".into());
    }
    Ok(())
}

pub(super) fn validate_spec(spec: &TeamSpec) -> Result<(), String> {
    if spec.goal.trim().is_empty() || spec.workspace_path.trim().is_empty() {
        return Err("Team goal and workspace are required".into());
    }
    if !(1..=64).contains(&spec.members.len()) || !(1..=8).contains(&spec.max_concurrency) {
        return Err("Team requires 1–64 members and a concurrency limit of 1–8".into());
    }
    let mut members = HashSet::new();
    for member in &spec.members {
        identifier(&member.id)?;
        if !members.insert(&member.id)
            || member.instructions.trim().is_empty()
            || member.display_name.trim().is_empty()
        {
            return Err(format!(
                "Duplicate member or blank display name/instructions: {}",
                member.id
            ));
        }
        if let Some(model) = &member.model {
            validate_model(model)?;
        }
    }
    Ok(())
}

pub(super) fn validate_plan(spec: &TeamSpec, plan: &TeamPlan) -> Result<(), String> {
    validate_dag(spec, plan, false)
}

pub(super) fn validate_chat_plan(spec: &TeamSpec, plan: &TeamPlan) -> Result<(), String> {
    validate_dag(spec, plan, true)
}

fn validate_dag(spec: &TeamSpec, plan: &TeamPlan, parent_integrates: bool) -> Result<(), String> {
    validate_spec(spec)?;
    if !(1..=64).contains(&plan.tasks.len()) {
        return Err("Team plan requires 1–64 tasks".into());
    }
    let mut tasks = HashMap::new();
    for task in &plan.tasks {
        identifier(&task.id)?;
        if tasks.insert(task.id.as_str(), task).is_some() {
            return Err(format!("Duplicate Team task: {}", task.id));
        }
        if task.instructions.trim().is_empty()
            || task.title.trim().is_empty()
            || !spec
                .members
                .iter()
                .any(|member| member.id == task.member_id)
        {
            return Err(format!(
                "Invalid title, instructions or member for task {}",
                task.id
            ));
        }
    }
    for task in &plan.tasks {
        let mut seen = HashSet::new();
        for dependency in &task.dependencies {
            if dependency == &task.id
                || !tasks.contains_key(dependency.as_str())
                || !seen.insert(dependency)
            {
                return Err(format!(
                    "Invalid dependency {dependency} for task {}",
                    task.id
                ));
            }
        }
    }
    let mut ordered = HashSet::new();
    loop {
        let previous = ordered.len();
        for task in &plan.tasks {
            if task
                .dependencies
                .iter()
                .all(|id| ordered.contains(id.as_str()))
            {
                ordered.insert(task.id.as_str());
            }
        }
        if previous == ordered.len() {
            break;
        }
    }
    if ordered.len() != tasks.len() {
        return Err("Team task dependencies contain a cycle".into());
    }
    // Chat coordinators consume all leaf results themselves.
    if parent_integrates && plan.final_task_id.is_empty() {
        return Ok(());
    }
    if !tasks.contains_key(plan.final_task_id.as_str()) {
        return Err("Team final task does not exist".into());
    }
    let mut ancestors = HashSet::new();
    let mut queue = vec![plan.final_task_id.as_str()];
    while let Some(id) = queue.pop() {
        if ancestors.insert(id) {
            queue.extend(tasks[id].dependencies.iter().map(String::as_str));
        }
    }
    if ancestors.len() != tasks.len() {
        return Err(
            "Every Team task must contribute to the final task through dependencies".into(),
        );
    }
    Ok(())
}

impl TeamRun {
    pub(super) fn validate_plan(&self, plan: &TeamPlan) -> Result<(), String> {
        validate_dag(&self.spec, plan, self.parent_thread_id.is_some())
    }

    pub(super) fn plan(&self) -> TeamPlan {
        TeamPlan {
            tasks: self
                .tasks
                .iter()
                .map(|record| record.task.clone())
                .collect(),
            final_task_id: self.final_task_id.clone(),
        }
    }
}

mod config;
mod runner;
mod templates;
mod trust;

use futures_util::future::join_all;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::fmt;
use std::path::{Path, PathBuf};

pub(crate) use self::config::{load_catalog_snapshot, CommandHookCatalogSnapshot};
use self::config::{load_resolved_hooks, ResolvedCommandHook};
use self::runner::run_hook;
pub(crate) use self::trust::set_hook_trusted;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) enum CommandHookEvent {
    UserPromptSubmit,
    PreToolUse,
    PostToolUse,
    PostCompact,
}

impl CommandHookEvent {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::UserPromptSubmit => "UserPromptSubmit",
            Self::PreToolUse => "PreToolUse",
            Self::PostToolUse => "PostToolUse",
            Self::PostCompact => "PostCompact",
        }
    }

    pub(super) fn parse(value: &str) -> Option<Self> {
        match value {
            "UserPromptSubmit" => Some(Self::UserPromptSubmit),
            "PreToolUse" => Some(Self::PreToolUse),
            "PostToolUse" => Some(Self::PostToolUse),
            "PostCompact" => Some(Self::PostCompact),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct CommandHookRequest {
    pub event: CommandHookEvent,
    pub session_id: String,
    pub turn_id: String,
    pub model: String,
    pub permission_mode: String,
    pub prompt: Option<String>,
    pub tool_name: Option<String>,
    pub tool_match_names: Vec<String>,
    pub tool_use_id: Option<String>,
    pub tool_input: Option<Value>,
    pub tool_response: Option<Value>,
    pub trigger: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct CommandHookRunResult {
    pub hook_hash: String,
    pub hook_name: String,
    pub source_path: PathBuf,
    pub duration_ms: u64,
    pub decision: String,
    pub denied_reason: Option<String>,
    pub updated_input: Option<Value>,
    pub additional_context: Option<String>,
    pub system_message: Option<String>,
    pub tool_feedback: Option<String>,
    pub failure: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct CommandHookEvaluation {
    pub runs: Vec<CommandHookRunResult>,
}

#[derive(Clone, Default)]
pub(crate) struct CommandHookEngine {
    workspace_root: PathBuf,
    hooks: Vec<ResolvedCommandHook>,
}

impl fmt::Debug for CommandHookEngine {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CommandHookEngine")
            .field("workspace_root", &self.workspace_root)
            .field("hook_count", &self.hooks.len())
            .field(
                "trusted_hook_count",
                &self.hooks.iter().filter(|hook| hook.trusted).count(),
            )
            .finish()
    }
}

impl CommandHookEngine {
    pub(crate) fn load(data_root: &Path, workspace_root: &Path) -> Self {
        let workspace_root = absolute_path(workspace_root);
        let hooks = load_resolved_hooks(data_root, &workspace_root)
            .map(|catalog| catalog.hooks)
            .unwrap_or_default();
        Self {
            workspace_root,
            hooks,
        }
    }

    pub(crate) async fn evaluate(&self, request: &CommandHookRequest) -> CommandHookEvaluation {
        let matching = self
            .hooks
            .iter()
            .filter(|hook| hook.trusted && hook.event == request.event)
            .filter(|hook| hook_matches(hook, request))
            .cloned()
            .collect::<Vec<_>>();
        let runs = join_all(
            matching
                .into_iter()
                .map(|hook| run_hook(hook, request.clone(), self.workspace_root.clone())),
        )
        .await;
        CommandHookEvaluation { runs }
    }
}

fn hook_matches(hook: &ResolvedCommandHook, request: &CommandHookRequest) -> bool {
    if hook.matcher.is_none() || request.event == CommandHookEvent::UserPromptSubmit {
        return true;
    }
    let matcher = hook.matcher.as_ref().expect("checked matcher presence");
    match request.event {
        CommandHookEvent::PreToolUse | CommandHookEvent::PostToolUse => request
            .tool_match_names
            .iter()
            .any(|name| matcher.is_match(name)),
        CommandHookEvent::PostCompact => request
            .trigger
            .as_deref()
            .is_some_and(|trigger| matcher.is_match(trigger)),
        CommandHookEvent::UserPromptSubmit => true,
    }
}

fn absolute_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        }
    })
}

pub(super) fn compile_matcher(matcher: Option<&str>) -> Result<Option<Regex>, String> {
    let Some(matcher) = matcher.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if matcher == "*" {
        return Ok(None);
    }
    Regex::new(matcher)
        .map(Some)
        .map_err(|error| format!("invalid hook matcher `{matcher}`: {error}"))
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

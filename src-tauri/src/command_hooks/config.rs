use super::compile_matcher;
use super::managed::{load_managed_hooks, ManagedHookMetadata};
use super::templates::{ensure_hook_templates, hook_template_paths};
use super::trust::HookTrustStore;
use super::CommandHookEvent;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const DEFAULT_TIMEOUT_SECONDS: u64 = 600;
const MAX_TIMEOUT_SECONDS: u64 = 600;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CommandHookHandler {
    #[serde(rename = "type")]
    pub hook_type: String,
    pub command: String,
    #[serde(default, alias = "command_windows")]
    pub command_windows: Option<String>,
    #[serde(default)]
    pub timeout: Option<u64>,
    #[serde(default)]
    pub status_message: Option<String>,
    #[serde(default)]
    pub additional_context_limit: Option<usize>,
    #[serde(default, rename = "async")]
    pub asynchronous: bool,
}

impl CommandHookHandler {
    pub(super) fn command_for_platform(&self) -> &str {
        #[cfg(windows)]
        if let Some(command) = self
            .command_windows
            .as_deref()
            .map(str::trim)
            .filter(|command| !command.is_empty())
        {
            return command;
        }
        self.command.trim()
    }

    pub(super) fn timeout_seconds(&self) -> u64 {
        self.timeout
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
            .clamp(1, MAX_TIMEOUT_SECONDS)
    }

    pub(super) fn context_limit_chars(&self) -> usize {
        self.additional_context_limit
            .unwrap_or(2_500)
            .clamp(1, 25_000)
            .saturating_mul(4)
    }
}

#[derive(Clone, Debug)]
pub(super) struct ResolvedCommandHook {
    pub event: CommandHookEvent,
    pub matcher: Option<Regex>,
    pub matcher_text: Option<String>,
    pub handler: CommandHookHandler,
    pub hash: String,
    pub source_path: PathBuf,
    pub source: CommandHookSource,
    pub trusted: bool,
    pub enabled: bool,
    pub managed: Option<ManagedHookMetadata>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CommandHookSource {
    Global,
    Workspace,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandHookSummary {
    pub hash: String,
    pub event: String,
    pub matcher: Option<String>,
    pub command: String,
    pub status_message: Option<String>,
    pub timeout: u64,
    pub source: CommandHookSource,
    pub source_path: PathBuf,
    pub trusted: bool,
    pub enabled: bool,
    pub managed: Option<ManagedHookMetadata>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandHookDiagnostic {
    pub level: &'static str,
    pub code: &'static str,
    pub message: String,
    pub path: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandHookCatalogSnapshot {
    pub global_config_path: PathBuf,
    pub workspace_config_path: PathBuf,
    pub trust_store_path: PathBuf,
    pub template_config_path: PathBuf,
    pub template_scripts_path: PathBuf,
    pub workspace_root: PathBuf,
    pub hooks: Vec<CommandHookSummary>,
    pub diagnostics: Vec<CommandHookDiagnostic>,
}

pub(super) struct LoadedCommandHooks {
    pub hooks: Vec<ResolvedCommandHook>,
    pub diagnostics: Vec<CommandHookDiagnostic>,
    pub global_config_path: PathBuf,
    pub workspace_config_path: PathBuf,
    pub trust_store_path: PathBuf,
}

#[derive(Debug, Default, Deserialize)]
struct HooksFile {
    #[allow(dead_code)]
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    hooks: BTreeMap<String, Vec<HookMatcherGroup>>,
}

#[derive(Debug, Deserialize)]
struct HookMatcherGroup {
    #[serde(default)]
    matcher: Option<String>,
    #[serde(default)]
    hooks: Vec<CommandHookHandler>,
}

pub(crate) fn load_catalog_snapshot(
    data_root: &Path,
    workspace_root: &Path,
) -> Result<CommandHookCatalogSnapshot, String> {
    let mut loaded = load_resolved_hooks(data_root, workspace_root)?;
    let template_paths = hook_template_paths(data_root);
    if let Err(error) = ensure_hook_templates(data_root) {
        loaded.diagnostics.push(diagnostic(
            "hook_templates_create_failed",
            error,
            &template_paths.config_path,
        ));
    }
    let hooks = loaded
        .hooks
        .iter()
        .map(|hook| CommandHookSummary {
            hash: hook.hash.clone(),
            event: hook.event.as_str().to_string(),
            matcher: hook.matcher_text.clone(),
            command: hook.handler.command_for_platform().to_string(),
            status_message: hook.handler.status_message.clone(),
            timeout: hook.handler.timeout_seconds(),
            source: hook.source,
            source_path: hook.source_path.clone(),
            trusted: hook.trusted,
            enabled: hook.enabled,
            managed: hook.managed.clone(),
        })
        .collect();
    Ok(CommandHookCatalogSnapshot {
        global_config_path: loaded.global_config_path,
        workspace_config_path: loaded.workspace_config_path,
        trust_store_path: loaded.trust_store_path,
        template_config_path: template_paths.config_path,
        template_scripts_path: template_paths.scripts_path,
        workspace_root: workspace_root.to_path_buf(),
        hooks,
        diagnostics: loaded.diagnostics,
    })
}

pub(super) fn load_resolved_hooks(
    data_root: &Path,
    workspace_root: &Path,
) -> Result<LoadedCommandHooks, String> {
    let global_config_path = data_root.join("hooks.json");
    let workspace_config_path = workspace_root.join(".tinybot").join("hooks.json");
    let trust_store = HookTrustStore::load(data_root)?;
    let trust_store_path = trust_store.path().to_path_buf();
    let mut hooks = Vec::new();
    let mut diagnostics = Vec::new();
    load_source(
        &global_config_path,
        CommandHookSource::Global,
        &trust_store,
        &mut hooks,
        &mut diagnostics,
    );
    if workspace_config_path != global_config_path {
        load_source(
            &workspace_config_path,
            CommandHookSource::Workspace,
            &trust_store,
            &mut hooks,
            &mut diagnostics,
        );
    }
    load_managed_hooks(workspace_root, &trust_store, &mut hooks, &mut diagnostics);
    Ok(LoadedCommandHooks {
        hooks,
        diagnostics,
        global_config_path,
        workspace_config_path,
        trust_store_path,
    })
}

fn load_source(
    path: &Path,
    source: CommandHookSource,
    trust_store: &HookTrustStore,
    hooks: &mut Vec<ResolvedCommandHook>,
    diagnostics: &mut Vec<CommandHookDiagnostic>,
) {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            diagnostics.push(diagnostic(
                "hook_config_read_failed",
                format!("failed to read hook configuration: {error}"),
                path,
            ));
            return;
        }
    };
    let file = match serde_json::from_str::<HooksFile>(&contents) {
        Ok(file) => file,
        Err(error) => {
            diagnostics.push(diagnostic(
                "hook_config_invalid_json",
                format!("failed to parse hook configuration: {error}"),
                path,
            ));
            return;
        }
    };
    for (event_name, groups) in file.hooks {
        let Some(event) = CommandHookEvent::parse(&event_name) else {
            diagnostics.push(diagnostic(
                "hook_event_unsupported",
                format!("hook event `{event_name}` is not supported by Tinybot"),
                path,
            ));
            continue;
        };
        for group in groups {
            if group.hooks.is_empty() {
                diagnostics.push(diagnostic(
                    "hook_group_empty",
                    format!("hook event `{event_name}` contains an empty matcher group"),
                    path,
                ));
                continue;
            }
            let matcher_text = group
                .matcher
                .as_deref()
                .map(str::trim)
                .filter(|matcher| !matcher.is_empty())
                .map(str::to_string);
            let matcher = match compile_matcher(matcher_text.as_deref()) {
                Ok(matcher) => matcher,
                Err(error) => {
                    diagnostics.push(diagnostic("hook_matcher_invalid", error, path));
                    continue;
                }
            };
            for handler in group.hooks {
                if handler.hook_type != "command" {
                    diagnostics.push(diagnostic(
                        "hook_handler_unsupported",
                        format!(
                            "hook handler type `{}` is unsupported; only `command` is available",
                            handler.hook_type
                        ),
                        path,
                    ));
                    continue;
                }
                if handler.asynchronous {
                    diagnostics.push(diagnostic(
                        "hook_async_unsupported",
                        "background command hooks are not supported yet".to_string(),
                        path,
                    ));
                    continue;
                }
                if handler.command_for_platform().is_empty() {
                    diagnostics.push(diagnostic(
                        "hook_command_empty",
                        "hook command must not be empty".to_string(),
                        path,
                    ));
                    continue;
                }
                if handler.timeout == Some(0) || handler.timeout.is_some_and(|value| value > 600) {
                    diagnostics.push(diagnostic(
                        "hook_timeout_invalid",
                        "hook timeout must be between 1 and 600 seconds".to_string(),
                        path,
                    ));
                    continue;
                }
                if handler.additional_context_limit == Some(0) {
                    diagnostics.push(diagnostic(
                        "hook_context_limit_invalid",
                        "additionalContextLimit must be a positive integer".to_string(),
                        path,
                    ));
                    continue;
                }
                let hash = hook_hash(path, event, matcher_text.as_deref(), &handler);
                hooks.push(ResolvedCommandHook {
                    event,
                    matcher: matcher.clone(),
                    matcher_text: matcher_text.clone(),
                    handler,
                    trusted: trust_store.contains(&hash),
                    hash,
                    source_path: path.to_path_buf(),
                    source,
                    enabled: true,
                    managed: None,
                });
            }
        }
    }
}

pub(super) fn hook_hash(
    source_path: &Path,
    event: CommandHookEvent,
    matcher: Option<&str>,
    handler: &CommandHookHandler,
) -> String {
    let canonical = serde_json::json!({
        "schemaVersion": "tinybot.command_hook.v1",
        "sourcePath": source_path.to_string_lossy(),
        "event": event.as_str(),
        "matcher": matcher,
        "handler": handler,
    });
    let encoded = serde_json::to_vec(&canonical).unwrap_or_default();
    format!("sha256:{:x}", Sha256::digest(encoded))
}

pub(super) fn diagnostic(
    code: &'static str,
    message: String,
    path: &Path,
) -> CommandHookDiagnostic {
    CommandHookDiagnostic {
        level: "warning",
        code,
        message,
        path: path.to_path_buf(),
    }
}

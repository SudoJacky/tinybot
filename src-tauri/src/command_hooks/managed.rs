use super::config::{
    diagnostic, hook_hash, CommandHookDiagnostic, CommandHookHandler, CommandHookSource,
    ResolvedCommandHook,
};
use super::templates::{powershell_script_template, shell_script_template};
use super::trust::HookTrustStore;
use super::{compile_matcher, CommandHookEvent};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const MANAGED_HOOK_SCHEMA: &str = "tinybot.managed_hook.v1";
const MANIFEST_FILE_NAME: &str = "hook.json";

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ManagedHookLanguage {
    Powershell,
    Shell,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedHookDraft {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub event: String,
    #[serde(default)]
    pub matcher: Option<String>,
    pub language: ManagedHookLanguage,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default = "default_timeout")]
    pub timeout: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedHookMetadata {
    pub id: String,
    pub name: String,
    pub language: ManagedHookLanguage,
    pub manifest_path: PathBuf,
    pub script_path: PathBuf,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedHookManifest {
    schema_version: String,
    name: String,
    event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    matcher: Option<String>,
    language: ManagedHookLanguage,
    enabled: bool,
    timeout: u64,
}

pub(crate) fn save_managed_hook(
    workspace_root: &Path,
    draft: ManagedHookDraft,
) -> Result<String, String> {
    let name = required_name(&draft.name)?;
    let event = CommandHookEvent::parse(draft.event.trim())
        .ok_or_else(|| format!("unsupported managed hook event `{}`", draft.event.trim()))?;
    let matcher = normalized_matcher(event, draft.matcher.as_deref())?;
    if !(1..=600).contains(&draft.timeout) {
        return Err("managed hook timeout must be between 1 and 600 seconds".to_string());
    }

    let hooks_root = managed_hooks_root(workspace_root);
    fs::create_dir_all(&hooks_root).map_err(|error| {
        format!(
            "failed to create managed hook directory `{}`: {error}",
            hooks_root.display()
        )
    })?;
    let id = match draft
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(id) => {
            validate_id(id)?;
            if !hooks_root.join(id).join(MANIFEST_FILE_NAME).is_file() {
                return Err(format!("managed hook `{id}` does not exist"));
            }
            id.to_string()
        }
        None => unique_id(&hooks_root, &slug(&name)),
    };
    let hook_root = hooks_root.join(&id);
    fs::create_dir_all(&hook_root).map_err(|error| {
        format!(
            "failed to create managed hook `{}`: {error}",
            hook_root.display()
        )
    })?;
    let script_path = hook_root.join(script_file_name(draft.language));
    write_script_if_missing(&script_path, draft.language)?;

    let manifest = ManagedHookManifest {
        schema_version: MANAGED_HOOK_SCHEMA.to_string(),
        name,
        event: event.as_str().to_string(),
        matcher,
        language: draft.language,
        enabled: draft.enabled,
        timeout: draft.timeout,
    };
    let mut encoded = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("failed to serialize managed hook `{id}`: {error}"))?;
    encoded.push(b'\n');
    let manifest_path = hook_root.join(MANIFEST_FILE_NAME);
    fs::write(&manifest_path, encoded).map_err(|error| {
        format!(
            "failed to write managed hook manifest `{}`: {error}",
            manifest_path.display()
        )
    })?;
    Ok(id)
}

pub(super) fn load_managed_hooks(
    workspace_root: &Path,
    trust_store: &HookTrustStore,
    hooks: &mut Vec<ResolvedCommandHook>,
    diagnostics: &mut Vec<CommandHookDiagnostic>,
) {
    let root = managed_hooks_root(workspace_root);
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            diagnostics.push(diagnostic(
                "managed_hooks_read_failed",
                format!("failed to read managed hooks: {error}"),
                &root,
            ));
            return;
        }
    };
    let mut manifests = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path().join(MANIFEST_FILE_NAME))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    manifests.sort();
    for manifest_path in manifests {
        match load_manifest(workspace_root, trust_store, &manifest_path) {
            Ok(hook) => hooks.push(hook),
            Err((code, message)) => diagnostics.push(diagnostic(code, message, &manifest_path)),
        }
    }
}

fn load_manifest(
    workspace_root: &Path,
    trust_store: &HookTrustStore,
    manifest_path: &Path,
) -> Result<ResolvedCommandHook, (&'static str, String)> {
    let encoded = fs::read_to_string(manifest_path).map_err(|error| {
        (
            "managed_hook_read_failed",
            format!("failed to read managed hook manifest: {error}"),
        )
    })?;
    let manifest = serde_json::from_str::<ManagedHookManifest>(&encoded).map_err(|error| {
        (
            "managed_hook_invalid_json",
            format!("failed to parse managed hook manifest: {error}"),
        )
    })?;
    if manifest.schema_version != MANAGED_HOOK_SCHEMA {
        return Err((
            "managed_hook_schema_unsupported",
            format!(
                "unsupported managed hook schema `{}`",
                manifest.schema_version
            ),
        ));
    }
    let id = manifest_path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            (
                "managed_hook_id_invalid",
                "managed hook directory name is not valid UTF-8".to_string(),
            )
        })?;
    validate_id(id).map_err(|message| ("managed_hook_id_invalid", message))?;
    let name =
        required_name(&manifest.name).map_err(|message| ("managed_hook_name_invalid", message))?;
    let event = CommandHookEvent::parse(manifest.event.trim()).ok_or_else(|| {
        (
            "hook_event_unsupported",
            format!("managed hook event `{}` is not supported", manifest.event),
        )
    })?;
    let matcher_text = normalized_matcher(event, manifest.matcher.as_deref())
        .map_err(|message| ("hook_matcher_invalid", message))?;
    let matcher = compile_matcher(matcher_text.as_deref())
        .map_err(|message| ("hook_matcher_invalid", message))?;
    if !(1..=600).contains(&manifest.timeout) {
        return Err((
            "hook_timeout_invalid",
            "managed hook timeout must be between 1 and 600 seconds".to_string(),
        ));
    }
    let relative_script = format!(
        ".tinybot/hooks/{id}/{}",
        script_file_name(manifest.language)
    );
    let script_path = workspace_root.join(&relative_script);
    let handler = handler_for(manifest.language, &relative_script, manifest.timeout, &name);
    let hash = hook_hash(manifest_path, event, matcher_text.as_deref(), &handler);
    Ok(ResolvedCommandHook {
        event,
        matcher,
        matcher_text,
        handler,
        trusted: trust_store.contains(&hash),
        hash,
        source_path: manifest_path.to_path_buf(),
        source: CommandHookSource::Workspace,
        enabled: manifest.enabled,
        managed: Some(ManagedHookMetadata {
            id: id.to_string(),
            name,
            language: manifest.language,
            manifest_path: manifest_path.to_path_buf(),
            script_path,
        }),
    })
}

fn handler_for(
    language: ManagedHookLanguage,
    relative_script: &str,
    timeout: u64,
    name: &str,
) -> CommandHookHandler {
    let (command, command_windows) = match language {
        ManagedHookLanguage::Powershell => (
            format!("pwsh -NoProfile -File {relative_script}"),
            Some(format!(
                "powershell -NoProfile -ExecutionPolicy Bypass -File {relative_script}"
            )),
        ),
        ManagedHookLanguage::Shell => (
            format!("sh {relative_script}"),
            Some(format!("sh {relative_script}")),
        ),
    };
    CommandHookHandler {
        hook_type: "command".to_string(),
        command,
        command_windows,
        timeout: Some(timeout),
        status_message: Some(name.to_string()),
        additional_context_limit: None,
        asynchronous: false,
    }
}

fn normalized_matcher(
    event: CommandHookEvent,
    matcher: Option<&str>,
) -> Result<Option<String>, String> {
    if event == CommandHookEvent::UserPromptSubmit {
        return Ok(None);
    }
    let matcher = matcher
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("*")
        .to_string();
    compile_matcher(Some(&matcher))?;
    Ok(Some(matcher))
}

fn required_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty() {
        return Err("managed hook name must not be empty".to_string());
    }
    if name.chars().count() > 80 {
        return Err("managed hook name must be at most 80 characters".to_string());
    }
    Ok(name.to_string())
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
        || id.starts_with('-')
        || id.ends_with('-')
    {
        return Err(format!("invalid managed hook id `{id}`"));
    }
    Ok(())
}

fn slug(name: &str) -> String {
    let mut result = String::new();
    let mut separator = false;
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            if separator && !result.is_empty() {
                result.push('-');
            }
            result.push(character.to_ascii_lowercase());
            separator = false;
        } else {
            separator = true;
        }
        if result.len() >= 48 {
            break;
        }
    }
    let result = result.trim_matches('-');
    if result.is_empty() {
        "hook".to_string()
    } else {
        result.to_string()
    }
}

fn unique_id(root: &Path, base: &str) -> String {
    if !root.join(base).exists() {
        return base.to_string();
    }
    for suffix in 2..=9_999 {
        let candidate = format!("{base}-{suffix}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{base}-{}", std::process::id())
}

fn managed_hooks_root(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".tinybot").join("hooks")
}

fn script_file_name(language: ManagedHookLanguage) -> &'static str {
    match language {
        ManagedHookLanguage::Powershell => "hook.ps1",
        ManagedHookLanguage::Shell => "hook.sh",
    }
}

fn write_script_if_missing(path: &Path, language: ManagedHookLanguage) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    let template = match language {
        ManagedHookLanguage::Powershell => powershell_script_template(),
        ManagedHookLanguage::Shell => shell_script_template(),
    };
    fs::write(path, template).map_err(|error| {
        format!(
            "failed to create managed hook script `{}`: {error}",
            path.display()
        )
    })
}

const fn default_enabled() -> bool {
    true
}

const fn default_timeout() -> u64 {
    30
}

use std::{fs, path::Path};

pub(super) struct BundledPlugin {
    pub(super) name: &'static str,
    pub(super) version: &'static str,
    pub(super) source: &'static str,
    files: &'static [(&'static str, &'static [u8])],
}

pub(super) const CREATE_AGENT_PLUGIN: BundledPlugin = BundledPlugin {
    name: "create-agent-plugin",
    version: "1.0.0",
    source: "bundled:create-agent-plugin",
    files: &[
        (
            "plugin.json",
            include_bytes!("../../bundled-plugins/create-agent-plugin/plugin.json"),
        ),
        (
            "LICENSE",
            include_bytes!("../../bundled-plugins/create-agent-plugin/LICENSE"),
        ),
        (
            "README.md",
            include_bytes!("../../bundled-plugins/create-agent-plugin/README.md"),
        ),
        (
            "skills/migrate-agent-plugin/SKILL.md",
            include_bytes!(
                "../../bundled-plugins/create-agent-plugin/skills/migrate-agent-plugin/SKILL.md"
            ),
        ),
        (
            "skills/migrate-agent-plugin/references/client-extensions.md",
            include_bytes!("../../bundled-plugins/create-agent-plugin/skills/migrate-agent-plugin/references/client-extensions.md"),
        ),
        (
            "skills/migrate-agent-plugin/references/migration-guide.md",
            include_bytes!("../../bundled-plugins/create-agent-plugin/skills/migrate-agent-plugin/references/migration-guide.md"),
        ),
        (
            "skills/migrate-agent-plugin/references/validation-checklist.md",
            include_bytes!("../../bundled-plugins/create-agent-plugin/skills/migrate-agent-plugin/references/validation-checklist.md"),
        ),
    ],
};

pub(super) const TINYBOT_MCP_PLUGIN: BundledPlugin = BundledPlugin {
    name: "tinybot-mcp",
    version: "1.0.0",
    source: "bundled:tinybot-mcp",
    files: &[
        (
            "plugin.json",
            include_bytes!("../../bundled-plugins/tinybot-mcp/plugin.json"),
        ),
        (
            "LICENSE",
            include_bytes!("../../bundled-plugins/tinybot-mcp/LICENSE"),
        ),
        (
            "README.md",
            include_bytes!("../../bundled-plugins/tinybot-mcp/README.md"),
        ),
        (
            "skills/configure-mcp/SKILL.md",
            include_bytes!("../../bundled-plugins/tinybot-mcp/skills/configure-mcp/SKILL.md"),
        ),
        (
            "skills/configure-mcp/references/configuration.md",
            include_bytes!(
                "../../bundled-plugins/tinybot-mcp/skills/configure-mcp/references/configuration.md"
            ),
        ),
    ],
};

pub(super) fn is_bundled_source(source: &str) -> bool {
    [CREATE_AGENT_PLUGIN.source, TINYBOT_MCP_PLUGIN.source].contains(&source)
}

pub(super) fn materialize(plugin: &BundledPlugin, target: &Path) -> Result<(), String> {
    if target.exists() {
        return Err(format!(
            "bundled plugin staging directory already exists: {}",
            target.display()
        ));
    }
    fs::create_dir_all(target).map_err(|error| {
        format!(
            "failed to create bundled plugin staging directory {}: {error}",
            target.display()
        )
    })?;
    let result = plugin.files.iter().try_for_each(|(relative, contents)| {
        let path = target.join(relative);
        let parent = path
            .parent()
            .ok_or_else(|| format!("bundled plugin path has no parent: {}", path.display()))?;
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create bundled plugin directory {}: {error}",
                parent.display()
            )
        })?;
        fs::write(&path, contents).map_err(|error| {
            format!(
                "failed to write bundled plugin file {}: {error}",
                path.display()
            )
        })
    });
    if let Err(error) = result {
        return match fs::remove_dir_all(target) {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(format!(
                "{error}; failed to clean bundled plugin staging directory {}: {cleanup_error}",
                target.display()
            )),
        };
    }
    Ok(())
}

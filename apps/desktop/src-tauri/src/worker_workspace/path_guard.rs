impl WorkerWorkspaceRpc {
    pub fn new(root: PathBuf, policy: CapabilityPolicy) -> Self {
        Self {
            builtin_skills_root: root.clone(),
            root,
            policy,
        }
    }

    pub fn with_builtin_skills_root(mut self, builtin_skills_root: PathBuf) -> Self {
        self.builtin_skills_root = builtin_skills_root;
        self
    }

    pub fn resolve_path(
        &self,
        requested_path: &str,
    ) -> Result<WorkspaceResolvedPath, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceRead)?;
        let relative_path = normalize_workspace_path(requested_path)?;
        Ok(WorkspaceResolvedPath {
            absolute_path: join_workspace_relative(&self.root, &relative_path),
            relative_path,
        })
    }

    fn require(&self, capability: WorkerCapability) -> Result<(), WorkerProtocolError> {
        if self.policy.allows(&capability) {
            return Ok(());
        }
        Err(WorkerProtocolError::new(
            WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": capability }),
            false,
            WorkerProtocolErrorSource::RustCore,
        ))
    }
}

fn normalize_workspace_path(requested_path: &str) -> Result<String, WorkerProtocolError> {
    let normalized = requested_path.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains(':')
        || normalized.contains('\0')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(invalid_workspace_path(requested_path));
    }
    Ok(normalized)
}

fn normalize_workspace_dir_path(requested_path: &str) -> Result<String, WorkerProtocolError> {
    let normalized = requested_path.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    if normalized == "." {
        return Ok(".".to_string());
    }
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains(':')
        || normalized.contains('\0')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(invalid_workspace_path(requested_path));
    }
    Ok(normalized.to_string())
}

fn join_workspace_relative(root: &Path, relative_path: &str) -> PathBuf {
    relative_path
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

fn workspace_dir_absolute_path(root: &Path, relative_path: &str) -> PathBuf {
    if relative_path == "." {
        return root.to_path_buf();
    }
    join_workspace_relative(root, relative_path)
}

fn ensure_inside_workspace(root: &Path, path: &Path) -> Result<(), WorkerProtocolError> {
    let root = canonicalize_workspace_root(root)?;
    ensure_inside_canonical_workspace(&root, path)
}

fn ensure_write_target_inside_workspace(
    root: &Path,
    path: &Path,
) -> Result<(), WorkerProtocolError> {
    let root = canonicalize_workspace_root(root)?;
    if path.exists() {
        return ensure_inside_canonical_workspace(&root, path);
    }
    let parent = path.parent().ok_or_else(|| invalid_workspace_path(""))?;
    if parent.exists() {
        return ensure_inside_canonical_workspace(&root, parent);
    }
    ensure_new_parent_chain_inside_workspace(&root, parent)
}

fn ensure_new_parent_chain_inside_workspace(
    root: &Path,
    parent: &Path,
) -> Result<(), WorkerProtocolError> {
    let existing_parent = parent
        .ancestors()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| {
            filesystem_error(
                "failed to locate existing workspace parent directory",
                serde_json::json!({ "path": parent.display().to_string() }),
            )
        })?;
    ensure_inside_canonical_workspace(root, existing_parent)
}

fn ensure_inside_canonical_workspace(root: &Path, path: &Path) -> Result<(), WorkerProtocolError> {
    let path = path.canonicalize().map_err(|error| {
        filesystem_error(
            "failed to resolve workspace path",
            serde_json::json!({
                "path": path.display().to_string(),
                "error": error.to_string(),
            }),
        )
    })?;
    if path.starts_with(root) {
        return Ok(());
    }
    Err(WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "workspace path escapes workspace root",
        serde_json::json!({
            "root": root.display().to_string(),
            "path": path.display().to_string(),
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    ))
}

fn workspace_relative_path(root: &Path, path: &Path) -> Result<String, WorkerProtocolError> {
    path.strip_prefix(root)
        .map_err(|error| {
            filesystem_error(
                "failed to compute workspace relative path",
                serde_json::json!({
                    "path": path.display().to_string(),
                    "error": error.to_string(),
                }),
            )
        })
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
}

fn canonicalize_workspace_root(root: &Path) -> Result<PathBuf, WorkerProtocolError> {
    root.canonicalize().map_err(|error| {
        filesystem_error(
            "failed to resolve workspace root",
            serde_json::json!({
                "root": root.display().to_string(),
                "error": error.to_string(),
            }),
        )
    })
}

fn invalid_workspace_path(requested_path: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "invalid workspace relative path",
        serde_json::json!({ "path": requested_path }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn filesystem_error(message: impl Into<String>, details: serde_json::Value) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::WorkerError,
        message,
        details,
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

use super::*;

impl WorkerRpcRouter {
    pub(super) fn dispatch_workspace_method(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        match request.method.as_str() {
            "workspace.resolve_path" => {
                let params: PathParams = parse_params(request)?;
                serde_json::to_value(self.workspace.resolve_path(&params.path)?)
                    .map_err(serialization_error)
            }
            "workspace.read_file" => {
                let params: ReadFileParams = parse_params(request)?;
                serde_json::to_value(self.workspace.read_file_with_options(
                    &params.path,
                    WorkspaceReadOptions {
                        offset: params.offset,
                        limit: params.limit,
                        format: params.format.unwrap_or(WorkspaceReadFormat::Raw),
                    },
                )?)
                .map_err(serialization_error)
            }
            "workspace.read_bootstrap_files" => {
                let params: BootstrapFilesParams = parse_params(request)?;
                serde_json::to_value(self.workspace.read_bootstrap_files(&params.files)?)
                    .map_err(serialization_error)
            }
            "workspace.write_file" => {
                let params: WriteFileParams = parse_params(request)?;
                if !request.is_trusted_internal() {
                    self.approval
                        .require_sensitive_operation(workspace_write_approval(
                            &params.path,
                            params.session_id.clone(),
                            params.run_id.clone(),
                        ))?;
                }
                serde_json::to_value(self.workspace.write_file_with_expected(
                    &params.path,
                    &params.contents,
                    params.expected_updated_at.as_deref(),
                )?)
                .map_err(serialization_error)
            }
            "workspace.apply_patch" => {
                let params: ApplyPatchParams = parse_params(request)?;
                if !request.is_trusted_internal() {
                    let targets = self.workspace.inspect_patch_targets(&params.patch)?;
                    self.approval
                        .require_sensitive_operation(workspace_apply_patch_approval(
                            &params.patch,
                            &targets,
                            params.session_id.clone(),
                            params.run_id.clone(),
                        ))?;
                }
                serde_json::to_value(self.workspace.apply_patch(&params.patch)?)
                    .map_err(serialization_error)
            }
            "workspace.create_dir" => {
                let params: PathParams = parse_params(request)?;
                serde_json::to_value(self.workspace.create_dir(&params.path)?)
                    .map_err(serialization_error)
            }
            "workspace.list_dir" => {
                let params: ListDirParams = parse_params(request)?;
                serde_json::to_value(self.workspace.list_dir(
                    &params.path,
                    params.recursive.unwrap_or(false),
                    params.max_entries,
                )?)
                .map_err(serialization_error)
            }
            "workspace.list_dir_page" => {
                let params: ListDirPageParams = parse_params(request)?;
                serde_json::to_value(self.workspace.list_dir_page(
                    &params.path,
                    params.cursor.as_deref(),
                    params.name_query.as_deref(),
                )?)
                .map_err(serialization_error)
            }
            "workspace.read_file_chunk" => {
                let params: ReadFileChunkParams = parse_params(request)?;
                serde_json::to_value(
                    self.workspace
                        .read_file_chunk(&params.path, params.cursor.as_deref())?,
                )
                .map_err(serialization_error)
            }
            "workspace.delete_file" => {
                let params: DeleteFileParams = parse_params(request)?;
                if !request.is_trusted_internal() {
                    self.approval
                        .require_sensitive_operation(workspace_delete_approval(
                            &params.path,
                            params.session_id.clone(),
                            params.run_id.clone(),
                        ))?;
                }
                serde_json::to_value(
                    self.workspace
                        .delete_file(&params.path, params.recursive.unwrap_or(false))?,
                )
                .map_err(serialization_error)
            }
            "workspace.list_files" => {
                serde_json::to_value(self.workspace.list_files()?).map_err(serialization_error)
            }
            "skills.list" => {
                serde_json::to_value(self.workspace.list_skills()?).map_err(serialization_error)
            }
            "skills.webui_list" => self
                .workspace
                .webui_list_skills(enabled_skills_from_snapshot(
                    &self.config.snapshot_public()?.value,
                )),
            "skills.webui_detail" => {
                let params: SkillNameParams = parse_params(request)?;
                self.workspace.webui_skill_detail(&params.name)
            }
            "skills.webui_create" => {
                let params: SkillCreateParams = parse_params(request)?;
                self.workspace.webui_create_skill(params.body)
            }
            "skills.webui_update" => {
                let params: SkillUpdateParams = parse_params(request)?;
                self.workspace.webui_update_skill(&params.name, params.body)
            }
            "skills.webui_delete" => {
                let params: SkillNameParams = parse_params(request)?;
                self.workspace.webui_delete_skill(&params.name)
            }
            "skills.webui_validate" => {
                let params: SkillNameParams = parse_params(request)?;
                self.workspace.webui_validate_skill(&params.name)
            }
            _ => Err(unknown_method_error(request)),
        }
    }
}

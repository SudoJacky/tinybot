use super::*;

mod engine;
mod filesystem;
mod matcher;
mod parser;
#[cfg(test)]
mod tests;
mod types;

use self::{
    engine::apply_patch_operations,
    filesystem::{LocalPatchFileSystem, PatchFileSystem},
    matcher::apply_update_chunks,
    parser::parse_patch,
    types::*,
};

impl WorkerWorkspaceRpc {
    pub fn apply_patch(
        &self,
        patch: &str,
    ) -> Result<WorkspacePatchApplyResult, WorkerProtocolError> {
        self.apply_patch_with_file_system(patch, &LocalPatchFileSystem)
    }

    fn apply_patch_with_file_system(
        &self,
        patch: &str,
        file_system: &dyn PatchFileSystem,
    ) -> Result<WorkspacePatchApplyResult, WorkerProtocolError> {
        self.require(WorkerCapability::FsWorkspaceRead)?;
        self.require(WorkerCapability::FsWorkspaceWrite)?;
        let operations = parse_patch(patch)?;
        apply_patch_operations(&self.root, operations, file_system)
            .map_err(PatchFailure::into_protocol_error)
    }
}

fn patch_error(message: impl Into<String>, details: serde_json::Value) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        details,
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

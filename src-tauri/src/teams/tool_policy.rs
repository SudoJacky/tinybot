use super::model::TeamToolProfile;
use crate::agent::runtime::NativeAgentToolPolicy;
use crate::tools::registry::{
    PUBLISH_DATA_VIEW_METHOD, TEAM_COMPLETE_TASK_METHOD, UPDATE_PLAN_METHOD,
};

impl TeamToolProfile {
    pub(super) fn policy(self) -> NativeAgentToolPolicy {
        let allowed = match self {
            Self::Execution => None,
            Self::Research | Self::Review => {
                let mut tools = vec![
                    UPDATE_PLAN_METHOD,
                    TEAM_COMPLETE_TASK_METHOD,
                    "team.list_messages",
                    "team.read_message",
                    "team.read_artifact",
                    "search_file_content",
                    "workspace.search_file_content",
                ];
                if self == Self::Research {
                    tools.extend([
                        "web.open",
                        "web.read",
                        "web.act",
                        "apply_patch",
                        "workspace.apply_patch",
                    ]);
                }
                Some(tools.into_iter().map(str::to_owned).collect())
            }
        };
        NativeAgentToolPolicy {
            allowed,
            // Even a synthesis employee submits an internal handoff. The parent owns presentation.
            denied: [
                PUBLISH_DATA_VIEW_METHOD,
                "team.recruit",
                "team.wait",
                "team.inspect",
                "team.read_result",
                "team.control",
                "team.resume",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        }
    }
}

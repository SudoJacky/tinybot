use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExperimentalSettings {
    #[serde(default)]
    pub action_fusion: bool,
}

impl ExperimentalSettings {
    pub fn from_config(config: &Value) -> Result<Self, String> {
        match config.get("experiments") {
            None => Ok(Self::default()),
            Some(value) => serde_json::from_value(value.clone())
                .map_err(|error| format!("invalid experiments configuration: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn action_fusion_defaults_off_and_rejects_malformed_settings() {
        assert!(
            !ExperimentalSettings::from_config(&json!({}))
                .unwrap()
                .action_fusion
        );
        assert!(
            ExperimentalSettings::from_config(&json!({"experiments":{"actionFusion":true}}))
                .unwrap()
                .action_fusion
        );
        for config in [
            json!({"experiments":null}),
            json!({"experiments":{"actionFusion":"true"}}),
            json!({"experiments":{"actionFuison":true}}),
        ] {
            assert!(ExperimentalSettings::from_config(&config).is_err());
        }
    }
}

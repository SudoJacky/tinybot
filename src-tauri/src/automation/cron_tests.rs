use super::*;
use serde_json::json;
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn list_jobs_reads_existing_cron_store_fixture() {
    let root = temp_workspace_root("existing-cron-store");
    let _cleanup = TempWorkspaceCleanup(root.clone());
    let store_path = root.join("cron").join("jobs.json");
    std::fs::create_dir_all(store_path.parent().unwrap()).unwrap();
    std::fs::write(
        &store_path,
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "jobs": [
                {
                    "id": "cron-existing",
                    "name": "Existing check-in",
                    "enabled": true,
                    "schedule": { "kind": "every", "everyMs": 60000 },
                    "payload": {
                        "kind": "agent_turn",
                        "message": "Run existing check-in",
                        "deliver": true,
                        "channel": "desktop",
                        "to": null
                    },
                    "state": {
                        "nextRunAtMs": 1710000000000i64,
                        "lastRunAtMs": 1709999900000i64,
                        "lastStatus": "ok",
                        "lastError": null,
                        "runHistory": [
                            {
                                "runAtMs": 1709999900000i64,
                                "status": "ok",
                                "durationMs": 1500,
                                "error": null
                            }
                        ]
                    },
                    "createdAtMs": 1709999800000i64,
                    "updatedAtMs": 1709999900000i64,
                    "deleteAfterRun": false
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    let rpc = WorkerCronRpc::new(root, CapabilityPolicy::new([WorkerCapability::CronRead]));

    let result = rpc.list_jobs().expect("existing cron store should load");

    assert_eq!(result.jobs.len(), 1);
    let job = &result.jobs[0];
    assert_eq!(job.id, "cron-existing");
    assert_eq!(job.state.last_status.as_deref(), Some("ok"));
    assert_eq!(job.state.run_history.len(), 1);
}

#[test]
fn add_job_rejects_unsupported_cron_expression_schedules() {
    let root = temp_workspace_root("reject-cron-expr");
    let _cleanup = TempWorkspaceCleanup(root.clone());
    let rpc = WorkerCronRpc::new(
        root.clone(),
        CapabilityPolicy::new([WorkerCapability::CronWrite]),
    );

    let error = rpc
        .add_job(CronJobAddParams {
            job: CronJobInput {
                id: Some("cron-expr".to_string()),
                name: "Cron expression".to_string(),
                enabled: Some(true),
                schedule: CronSchedule::Cron {
                    expr: "0 9 * * *".to_string(),
                    tz: Some("UTC".to_string()),
                },
                payload: CronPayload::AgentTurn {
                    message: "Check status".to_string(),
                    deliver: Some(true),
                    channel: Some("websocket".to_string()),
                    to: Some("chat-1".to_string()),
                },
                state: None,
                created_at_ms: None,
                delete_after_run: Some(false),
            },
        })
        .expect_err("unsupported cron expression schedules should be rejected");

    assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
    assert_eq!(error.message, "job.schedule.kind=cron is not supported yet");
    assert!(!root.join("cron").join("jobs.json").exists());
}

fn temp_workspace_root(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let root = std::env::temp_dir().join(format!(
        "tinybot-worker-cron-{name}-{}-{nonce}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    root
}

struct TempWorkspaceCleanup(PathBuf);

impl Drop for TempWorkspaceCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

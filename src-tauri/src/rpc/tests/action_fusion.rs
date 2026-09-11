use super::*;

const PATCH: &str = "*** Begin Patch\n*** Add File: fused.txt\n+patched\n*** End Patch";

fn request(arguments: Value) -> WorkerRequest {
    WorkerRequest::new(
        "req-fusion",
        "trace-fusion",
        "tool_executor.execute",
        json!({
            "toolId": "apply_patch", "arguments": arguments,
            "turnId": "turn-fusion", "toolCallId": "call-fusion"
        }),
    )
}

fn router(fixture: &WorkspaceFixture, config: Value, shell: bool) -> WorkerRpcRouter {
    let mut capabilities = vec![
        WorkerCapability::FsWorkspaceRead,
        WorkerCapability::FsWorkspaceWrite,
    ];
    if shell {
        capabilities.push(WorkerCapability::ShellExecute);
    }
    WorkerRpcRouter::new(
        fixture.root.clone(),
        config,
        20,
        CapabilityPolicy::new(capabilities),
    )
}

#[test]
fn action_fusion_runs_command_against_applied_patch() {
    let fixture = WorkspaceFixture::new();
    let mut router = router(&fixture, json!({"experiments":{"actionFusion":true}}), true);
    let command = if cfg!(windows) {
        "type fused.txt"
    } else {
        "cat fused.txt"
    };
    let response = router.dispatch(&request(json!({
        "patch": PATCH, "thenRun": {"command": command},
        "turnId": "spoofed", "parentTurnId": "spoofed", "toolCallId": "spoofed"
    })));
    assert!(response.error.is_none(), "{:?}", response.error);
    let result = response.result.unwrap();
    assert_eq!(result["result"]["patch"]["status"], "succeeded");
    let command = &result["result"]["thenRun"];
    assert_eq!(command["exitCode"], 0, "{result}");
    assert!(command["output"].as_str().unwrap().contains("patched"));
    assert_eq!(command["ownerId"], "turn-fusion");
    assert_eq!(command["toolCallId"], "call-fusion");
    assert!(result["permission"]["effects"]["process"]["execute"]
        .as_bool()
        .unwrap());
}

#[test]
fn action_fusion_preflight_rejects_before_editing() {
    for (config, shell, then_run) in [
        (json!({}), true, json!({"command":"echo unexpected"})),
        (
            json!({"experiments":{"actionFusion":true},"tools":{"exec":{"enable":false}}}),
            true,
            json!({"command":"echo unexpected"}),
        ),
        (
            json!({"experiments":{"actionFusion":true}}),
            false,
            json!({"command":"echo unexpected"}),
        ),
        (
            json!({"experiments":{"actionFusion":true}}),
            true,
            json!({"command":"   "}),
        ),
        (
            json!({"experiments":{"actionFusion":true}}),
            true,
            json!({"command":"echo unexpected","workingDir":"missing-directory"}),
        ),
        (
            json!({"experiments":{"actionFusion":true}}),
            true,
            json!({"command":"echo unexpected","yieldTimeMs":30001}),
        ),
        (
            json!({"experiments":{"actionFusion":true}}),
            true,
            json!({"command":"echo unexpected","tty":true}),
        ),
        (
            json!({"experiments":{"actionFusion":true}}),
            true,
            Value::Null,
        ),
    ] {
        let fixture = WorkspaceFixture::new();
        let mut router = router(&fixture, config, shell);
        let response = router.dispatch(&request(json!({"patch":PATCH,"thenRun":then_run})));
        assert!(response.error.is_some(), "{response:?}");
        assert!(!fixture.root.join("fused.txt").exists());
    }
}

#[test]
fn action_fusion_patch_failure_skips_command_and_command_failure_keeps_patch() {
    let fixture = WorkspaceFixture::new();
    let mut router = router(&fixture, json!({"experiments":{"actionFusion":true}}), true);
    let response = router.dispatch(&request(json!({
        "patch":"*** Begin Patch\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch",
        "thenRun":{"command":"echo unexpected > marker.txt"}
    })));
    assert!(response.error.unwrap().message.contains("thenRun skipped"));
    assert!(!fixture.root.join("marker.txt").exists());
    let response = router.dispatch(&request(json!({
        "patch":PATCH,"thenRun":{"command":"exit 7"}
    })));
    assert!(response.error.is_none(), "{:?}", response.error);
    assert_eq!(response.result.unwrap()["result"]["thenRun"]["exitCode"], 7);
    assert_eq!(fixture.read("fused.txt"), "patched\n");
}

#[test]
fn action_fusion_running_command_continues_under_turn_owner() {
    let fixture = WorkspaceFixture::new();
    let mut router = router(&fixture, json!({"experiments":{"actionFusion":true}}), true);
    let response = router.dispatch(&request(json!({
        "patch":PATCH,"thenRun":{"command":blocking_shell_command_with_marker(),"yieldTimeMs":0}
    })));
    assert!(response.error.is_none(), "{:?}", response.error);
    let result = response.result.unwrap();
    let command = &result["result"]["thenRun"];
    assert_eq!(command["running"], true);
    let process_id = command["processId"].as_str().unwrap();
    let continued = router.dispatch(&WorkerRequest::new("continue", "trace-fusion", "tool_executor.execute", json!({
        "toolId":"write_stdin", "arguments":{"processId":process_id,"input":"","yieldTimeMs":0,"cursor":command["cursor"]},
        "turnId":"turn-fusion","toolCallId":"call-continue"
    })));
    let terminated = router.dispatch(&WorkerRequest::new(
        "stop",
        "trace-fusion",
        "shell.terminate",
        json!({
            "processId":process_id,"ownerId":"turn-fusion"
        }),
    ));
    assert!(continued.error.is_none(), "{:?}", continued.error);
    assert!(terminated.error.is_none(), "{:?}", terminated.error);
    assert_eq!(continued.result.unwrap()["result"]["processId"], process_id);
    assert_eq!(terminated.result.unwrap()["running"], false);
    assert_eq!(fixture.read("fused.txt"), "patched\n");
}

#[test]
fn action_fusion_cancelled_request_never_applies_patch() {
    let fixture = WorkspaceFixture::new();
    let mut router = router(&fixture, json!({"experiments":{"actionFusion":true}}), true);
    let cancellation = Arc::new(TestCancellation::default());
    cancellation.cancel();
    let response = router.dispatch(
        &request(json!({"patch":PATCH,"thenRun":{"command":"echo unexpected"}}))
            .with_cancellation(Some(cancellation)),
    );
    assert!(response.error.is_some());
    assert!(!fixture.root.join("fused.txt").exists());
}

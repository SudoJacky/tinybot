use super::*;
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

struct Fixture {
    root: PathBuf,
    store: DailyTokenUsageStore,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(
            crate::protocol::request_id::next_worker_request_correlation().id("usage-ledger"),
        );
        fs::create_dir_all(&root).unwrap();
        Self {
            store: DailyTokenUsageStore::from_data_root(&root),
            root,
        }
    }
    fn scope(&self, purpose: UsagePurpose, team: Option<&str>) -> UsageScope {
        UsageScope {
            store: Some(self.store.clone()),
            origin: UsageOrigin {
                purpose,
                team_run_id: team.map(str::to_string),
                ..Default::default()
            },
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn usage() -> TokenUsage {
    TokenUsage {
        input_tokens: 100,
        cached_input_tokens: 80,
        output_tokens: 20,
        reasoning_output_tokens: 5,
        total_tokens: 120,
    }
}
fn invocation(id: &str) -> UsageInvocation {
    UsageInvocation {
        sequence: None,
        id: id.into(),
        request_id: id.into(),
        attempt: 0,
        date: "2026-09-17".into(),
        started_at: "2026-09-17T00:00:00Z".into(),
        finished_at: None,
        provider_id: "test".into(),
        model_id: "test-model".into(),
        origin: UsageOrigin::default(),
        status: "pending".into(),
        usage: None,
    }
}

#[test]
fn concurrent_duplicate_completion_is_atomic_and_conflicting_delivery_fails() {
    let f = Fixture::new();
    f.store.begin_invocation(&invocation("same-call")).unwrap();
    std::thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| {
                f.store
                    .finish_invocation("same-call", "completed", None, Some(&usage()))
                    .unwrap()
            });
        }
    });
    let snapshot = f.store.snapshot().unwrap();
    assert_eq!(snapshot.totals, usage());
    assert_eq!(snapshot.groups[0].calls, 1);
    assert_eq!(snapshot.groups[0].usage, Some(usage()));
    assert!(f
        .store
        .finish_invocation("same-call", "failed", None, None)
        .unwrap_err()
        .contains("Conflicting"));
    let reopened = DailyTokenUsageStore::from_data_root(&f.root);
    assert_eq!(reopened.snapshot().unwrap().totals, usage());
    assert_eq!(reopened.details(None, None).unwrap().invocations.len(), 1);
}

#[test]
fn missing_zero_pending_and_failure_remain_distinct_and_history_is_paged() {
    let f = Fixture::new();
    for i in 0..103 {
        let id = format!("call-{i}");
        f.store.begin_invocation(&invocation(&id)).unwrap();
    }
    f.store
        .finish_invocation("call-0", "completed", None, Some(&TokenUsage::default()))
        .unwrap();
    f.store
        .finish_invocation("call-1", "completed", None, None)
        .unwrap();
    f.store
        .finish_invocation("call-2", "failed", None, None)
        .unwrap();
    let first = f.store.details(None, None).unwrap();
    assert_eq!(first.invocations.len(), 100);
    let second = f.store.details(None, first.next_cursor).unwrap();
    assert_eq!(second.invocations.len(), 3);
    assert!(second.next_cursor.is_none());
    assert_eq!(second.invocations[2].usage, Some(TokenUsage::default()));
    assert_eq!(second.invocations[1].usage, None);
    let group = &first.groups[0];
    assert_eq!(
        (
            group.calls,
            group.reported_calls,
            group.pending_calls,
            group.failed_calls
        ),
        (103, 1, 100, 1)
    );
}

#[test]
fn legacy_totals_are_migrated_once_without_inventing_origins_or_request_counts() {
    let f = Fixture::new();
    // Simulate a v2 database by removing the new schema's migration marker.
    f.store
        .record_model_call("old", "test", "test-model", &usage())
        .unwrap();
    f.store
        .open()
        .unwrap()
        .execute("DELETE FROM usage_ledger_migrations", [])
        .unwrap();
    let snapshot = f.store.snapshot().unwrap();
    assert_eq!(snapshot.groups[0].purpose, "legacy");
    assert_eq!(snapshot.groups[0].calls, 0);
    assert_eq!(snapshot.groups[0].usage, Some(usage()));
    f.store.begin_invocation(&invocation("new")).unwrap();
    f.store
        .finish_invocation("new", "completed", None, Some(&usage()))
        .unwrap();
    let reopened = f.store.snapshot().unwrap();
    assert_eq!(reopened.totals.total_tokens, 240);
    assert_eq!(
        reopened
            .groups
            .iter()
            .map(|g| g.usage.as_ref().unwrap().total_tokens)
            .sum::<i64>(),
        240
    );
    assert!(f
        .store
        .details(Some("invented-run"), None)
        .unwrap()
        .groups
        .is_empty());
}

#[tokio::test]
async fn storage_failures_are_explicit_and_cannot_partially_update_totals() {
    let f = Fixture::new();
    f.store
        .begin_invocation(&invocation("write-failure"))
        .unwrap();
    f.store.open().unwrap().execute_batch("CREATE TRIGGER fail_completion BEFORE UPDATE ON usage_invocations BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;").unwrap();
    let error = f
        .store
        .finish_invocation("write-failure", "completed", None, Some(&usage()))
        .unwrap_err();
    assert!(error.contains("injected storage failure"));
    assert_eq!(f.store.snapshot().unwrap().totals.total_tokens, 0);
    assert_eq!(
        f.store.details(None, None).unwrap().invocations[0].status,
        "pending"
    );

    let broken = f.root.join("blocked");
    fs::write(&broken, b"not a directory").unwrap();
    let scope = UsageScope {
        origin: UsageOrigin::default(),
        store: Some(DailyTokenUsageStore::from_data_root(&broken)),
    };
    let config = json!({"agents":{"defaults":{"provider":"fixture","model":"fixture-model"}},"providers":{"fixture":{"responses":[{"content":"must not run"}]}}});
    for responses in [false, true] {
        let mut observer = |_| {};
        let result=scope.clone().run(async {
            if responses {
                crate::agent::provider::complete_responses_for_agent_with_observer_async(&config,&json!({"model":"fixture-model","input":"hello"}),&mut observer,None).await
            } else {
                crate::agent::provider::complete_chat_for_agent_with_observer_async(&config,&json!({"model":"fixture-model","messages":[{"role":"user","content":"hello"}]}),&mut observer,None).await
            }
        }).await;
        assert!(result
            .unwrap_err()
            .message()
            .contains("Cannot record provider invocation"));
    }
}

#[tokio::test]
async fn dropped_calls_and_real_http_retries_have_separate_durable_identities() {
    let f = Fixture::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let server_calls = calls.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app=axum::Router::new().fallback(axum::routing::post(move || {
        let calls=server_calls.clone();
        async move {
            if calls.fetch_add(1,Ordering::SeqCst)==0 {return (http::StatusCode::SERVICE_UNAVAILABLE,axum::Json(json!({"error":"retry"})));}
            (http::StatusCode::OK,axum::Json(json!({"id":"response","model":"gpt-test","choices":[{"index":0,"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":80},"completion_tokens_details":{"reasoning_tokens":5}}})))
        }
    }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let config = json!({"agents":{"defaults":{"provider":"openai","model":"gpt-test"}},"providers":{"openai":{"api_base":base,"api_key":"test"}}});
    let body =
        json!({"model":"gpt-test","stream":false,"messages":[{"role":"user","content":"hello"}]});
    let mut observer = |_| {};
    f.scope(UsagePurpose::TeamPlanning, Some("run"))
        .run(
            crate::agent::provider::complete_chat_for_agent_with_observer_async(
                &config,
                &body,
                &mut observer,
                None,
            ),
        )
        .await
        .unwrap();
    server.abort();
    let detail = f.store.details(Some("run"), None).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(detail.invocations.len(), 2);
    assert_eq!(
        detail.invocations[0].request_id,
        detail.invocations[1].request_id
    );
    assert_ne!(detail.invocations[0].id, detail.invocations[1].id);
    assert_eq!(detail.invocations[0].attempt, 1);
    assert_eq!(detail.invocations[1].status, "retry");
    assert_eq!(detail.invocations[1].usage, None);
    assert_eq!(f.store.snapshot().unwrap().totals, usage());
    f.scope(UsagePurpose::Conversation, None)
        .run(async {
            let _call = ProviderUsageCall::begin("test".into(), "test-model".into()).unwrap();
        })
        .await;
    assert_eq!(
        f.store.details(None, None).unwrap().invocations[0].status,
        "interrupted"
    );
}

#[tokio::test]
async fn native_team_planning_execution_and_detached_child_memory_reconcile_with_global_totals() {
    use crate::agent::bridge::{
        execute_thread_turn_with_services, SubmitThreadTurnInput, TestApplicationServices,
    };
    use crate::agent::runtime::NativeAgentRuntimeServices;
    let f = Fixture::new();
    let workspace = f.root.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let threads = crate::threads::workspace_store::WorkspaceThreadStore::new_with_data_root(
        workspace.clone(),
        f.root.clone(),
        crate::protocol::capability::default_desktop_capability_policy(),
    );
    let plan = json!({"tasks":[{"id":"task","title":"Research","memberId":"research","instructions":"Research","dependencies":[]}],"finalTaskId":"task"});
    let server_plan = plan.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app=axum::Router::new().fallback(axum::routing::post(move |axum::Json(body):axum::Json<Value>| {
        let plan=server_plan.clone();
        async move {
            // The wire request must not contain our private attribution fields.
            assert!(body.get("teamRunId").is_none());
            assert!(body.get("usageOrigin").is_none());
            let counts=json!({"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":80},"completion_tokens_details":{"reasoning_tokens":5}});
            if body["stream"]==true {
                let complete=body["tools"].as_array().and_then(|tools|tools.iter().find_map(|tool| {
                    tool["function"]["name"].as_str().filter(|name|name.contains("complete_task"))
                }));
                let delta=match complete {
                    Some(name)=>json!({"tool_calls":[{"index":0,"id":"finish-team","type":"function","function":{"name":name,"arguments":"{\"summary\":\"done\",\"artifacts\":[],\"unresolved\":\"\"}"}}]}),
                    None=>json!({"content":"done"}),
                };
                return ([("content-type","text/event-stream")],format!("data: {}\n\ndata: [DONE]\n\n",json!({"id":"response","model":"gpt-test","choices":[{"index":0,"delta":delta,"finish_reason":if complete.is_some(){"tool_calls"}else{"stop"}}],"usage":counts})));
            }
            let text=body["messages"][0]["content"].as_str().unwrap();
            let content=if text.contains("Plan work for a team") {plan.to_string()} else {
                assert!(text.contains("extract durable long-term memory"),"unexpected request: {text}");
                "{\"memories\":[]}".into()
            };
            ([("content-type","application/json")],json!({"id":"response","model":"gpt-test","choices":[{"index":0,"message":{"role":"assistant","content":content},"finish_reason":"stop"}],"usage":counts}).to_string())
        }
    }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let config = json!({"revision":2,"agents":{"defaults":{"provider":"openai","model":"gpt-test"}},"providers":{"openai":{"api_base":base,"api_key":"test"}}});
    let spec=serde_json::from_value(json!({"goal":"Research","workspacePath":workspace,"maxConcurrency":1,"members":[{"id":"research","displayName":"Research","instructions":"Research"}]})).unwrap();
    let run_id = crate::teams::new_run_id();
    let plan = f
        .scope(UsagePurpose::TeamPlanning, Some(&run_id))
        .run(crate::teams::plan(&config, &spec, None))
        .await
        .unwrap();
    let run = crate::teams::prepare_with_id(&f.root, spec, plan, run_id.clone()).unwrap();
    let mut services = NativeAgentRuntimeServices::default().with_thread_store(threads.clone());
    let result = crate::teams::execute(
        &f.root,
        crate::teams::TeamRunInput {
            run_id: run.id,
            expected_revision: run.revision,
        },
        Arc::new(crate::teams::NativeTeamExecutor {
            worker_options: serde_json::json!({}),
            services: services.clone(),
            workspace_root: workspace.clone(),
            config: config.clone(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(&result).unwrap()["status"],
        "completed",
        "{:?}",
        result.error
    );
    let threads = threads.for_team(&result.id).unwrap();
    services.thread_store = threads.clone();
    let parent = &result.tasks[0].attempts[0].thread_id;
    crate::rpc::call_rust_state_service(&threads,config.clone(),crate::protocol::WorkerRequest::new("create-child","create-child","thread.create",json!({"threadId":"child","parentThreadId":parent,"source":"subagent","title":"Child","metadata":{"extra":{"teamRunId":"spoofed"}}})),"Create usage child").unwrap();
    let memory = crate::memory::MemoryRuntime::new(Arc::new(crate::memory::NativeMemoryModel));
    services.memory_runtime = memory.clone();
    // A fresh Tokio task has no ambient scope. Persisted ancestry must restore it.
    let child_workspace = workspace.clone();
    let child_config = config.clone();
    tokio::spawn(async move {
        execute_thread_turn_with_services(services,SubmitThreadTurnInput {thread_id:Some("child".into()),input:json!({"role":"user","content":"Remember that I prefer Chinese."}),spec:json!({"turnId":"child-turn","stream":true,"model":"gpt-test","metadata":{"teamRunId":"spoofed"}})},child_workspace,child_config,None).await.unwrap();
    }).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let groups = f.store.snapshot().unwrap().groups;
            if groups
                .iter()
                .any(|g| g.purpose == "memory_extraction" && g.reported_calls == 1)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    memory
        .shutdown(std::time::Duration::from_secs(1))
        .await
        .unwrap();
    server.abort();
    let snapshot = f.store.snapshot().unwrap();
    assert_eq!(snapshot.totals.total_tokens, 480);
    assert_eq!(snapshot.totals.cached_input_tokens, 320);
    let details = DailyTokenUsageStore::from_data_root(&f.root)
        .details(Some(&run_id), None)
        .unwrap();
    assert_eq!(details.invocations.len(), 4);
    assert_eq!(
        details
            .groups
            .iter()
            .map(|g| g.usage.as_ref().unwrap().total_tokens)
            .sum::<i64>(),
        snapshot.totals.total_tokens
    );
    for purpose in [
        "team_planning",
        "team_task",
        "subagent",
        "memory_extraction",
    ] {
        assert!(details.groups.iter().any(|g| g.purpose == purpose));
    }
    let background = details
        .invocations
        .iter()
        .find(|c| c.origin.purpose == UsagePurpose::MemoryExtraction)
        .unwrap();
    assert_eq!(background.origin.task_id.as_deref(), Some("task"));
    assert_eq!(background.origin.thread_id.as_deref(), Some("child"));
    assert_eq!(
        background.origin.attempt_id.as_deref(),
        Some(parent.as_str())
    );
    assert!(f
        .store
        .details(Some("spoofed"), None)
        .unwrap()
        .invocations
        .is_empty());
    threads.shutdown().unwrap();
}

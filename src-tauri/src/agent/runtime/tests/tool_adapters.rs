use super::*;
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use crate::tools::registry::{
    ToolContributor, WorkspaceThreadTarget, WorkspaceThreadToolContributor,
    SEND_THREAD_MESSAGE_METHOD, SPAWN_WORKSPACE_THREAD_METHOD,
};
use futures_util::future::BoxFuture;

struct CoordinatorProvider {
    calls: AtomicUsize,
}

impl NativeAgentProvider for CoordinatorProvider {
    fn complete_streaming_async<'a>(
        self: Arc<Self>,
        context: &'a AgentTurnContext,
        _observer: &'a mut (dyn FnMut(NativeAgentProviderStreamEvent) + Send),
    ) -> BoxFuture<'a, Result<NativeAgentProviderResponse, NativeAgentProviderFailure>> {
        Box::pin(async move {
            assert_eq!(
                context.tool_execution_target(SPAWN_WORKSPACE_THREAD_METHOD),
                Some(ToolExecutionTarget::SpawnWorkspaceThread)
            );
            let call = match self.calls.fetch_add(1, Ordering::SeqCst) {
                0 => Some((
                    SPAWN_WORKSPACE_THREAD_METHOD,
                    json!({"workspaceId": "fixture-workspace", "message": "inspect"}),
                )),
                1 => Some((
                    SEND_THREAD_MESSAGE_METHOD,
                    json!({"threadId": "fixture-child", "message": "continue"}),
                )),
                _ => None,
            };
            Ok(NativeAgentProviderResponse {
                final_content: if call.is_none() {
                    "coordinator complete".into()
                } else {
                    String::new()
                },
                reasoning_delta: None,
                usage: None,
                tool_calls: call
                    .into_iter()
                    .map(|(name, arguments)| NativeAgentToolCall {
                        id: name.into(),
                        name: name.into(),
                        arguments_json: arguments.to_string(),
                        result: Value::Null,
                    })
                    .collect(),
                response_items: Vec::new(),
            })
        })
    }
}

struct WorkspaceDispatcher {
    calls: Mutex<Vec<String>>,
    discovery_error: Option<AgentError>,
    execution_error: Option<AgentError>,
}

impl NativeAgentToolDispatcher for WorkspaceDispatcher {
    fn tool_contributors(
        &self,
        _context: &AgentTurnContext,
    ) -> Result<Vec<Arc<dyn ToolContributor>>, AgentError> {
        if let Some(error) = &self.discovery_error {
            return Err(error.clone());
        }
        Ok(vec![Arc::new(WorkspaceThreadToolContributor::new(vec![
            WorkspaceThreadTarget {
                workspace_id: "fixture-workspace".into(),
                label: "Fixture".into(),
            },
        ])?)])
    }

    fn dispatch(
        &self,
        _context: &AgentTurnContext,
        _call: &PreparedToolCall,
    ) -> Result<NativeAgentToolResult, String> {
        panic!("workspace orchestration must use asynchronous dispatch")
    }

    fn dispatch_async(
        self: Arc<Self>,
        _context: AgentTurnContext,
        call: PreparedToolCall,
    ) -> BoxFuture<'static, Result<NativeAgentToolResult, AgentError>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(call.name.clone());
            if let Some(error) = &self.execution_error {
                return Err(error.clone());
            }
            Ok(NativeAgentToolResult::generic_success(
                &call,
                json!({
                    "threadId": "fixture-child", "status": "completed", "finalMessage": "done",
                }),
            ))
        })
    }
}

fn persistence_failure() -> AgentError {
    AgentError::persistence(
        "workspace thread",
        WorkerProtocolError::new(
            WorkerProtocolErrorCode::InvalidProtocol,
            "fixture persistence rejected",
            json!({"threadId": "fixture-child", "operation": "append"}),
            false,
            WorkerProtocolErrorSource::RustCore,
        ),
    )
}

fn run_with_dispatcher(
    dispatcher: Arc<WorkspaceDispatcher>,
    provider: Arc<CoordinatorProvider>,
) -> Result<Value, AgentError> {
    let workspace = SystemPromptWorkspace::new();
    let services = NativeAgentRuntimeServices::new(
        provider,
        dispatcher,
        Arc::new(InMemoryNativeAgentCheckpointStore::default()),
        Arc::new(InMemoryNativeAgentCancellation::default()),
    );
    // No thread store or bridge adapter: discovery and execution cross the same interface.
    run_native_agent_turn_with_workspace(
        &services,
        json!({
            "threadId": "fixture-parent", "sessionId": "fixture-parent", "turnId": "fixture-turn",
            "model": "fixture-model", "maxIterations": 3,
            "messages": [{"role": "user", "content": "coordinate work"}],
        }),
        json!({}),
        &workspace.root,
    )
}

#[test]
fn workspace_tools_are_discovered_and_dispatched_without_storage() {
    let dispatcher = Arc::new(WorkspaceDispatcher {
        calls: Mutex::new(Vec::new()),
        discovery_error: None,
        execution_error: None,
    });
    let result = run_with_dispatcher(
        dispatcher.clone(),
        Arc::new(CoordinatorProvider {
            calls: AtomicUsize::new(0),
        }),
    )
    .unwrap();
    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(result["finalContent"], "coordinator complete");
    assert_eq!(
        *dispatcher.calls.lock().unwrap(),
        [SPAWN_WORKSPACE_THREAD_METHOD, SEND_THREAD_MESSAGE_METHOD]
    );
    assert_eq!(result["completedToolResults"].as_array().unwrap().len(), 2);
}

#[test]
fn discovery_failure_preserves_service_error_and_prevents_provider_call() {
    let error = persistence_failure();
    let dispatcher = Arc::new(WorkspaceDispatcher {
        calls: Mutex::new(Vec::new()),
        discovery_error: Some(error.clone()),
        execution_error: None,
    });
    let provider = Arc::new(CoordinatorProvider {
        calls: AtomicUsize::new(0),
    });
    assert_eq!(
        run_with_dispatcher(dispatcher.clone(), provider.clone()).unwrap_err(),
        error
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    assert!(dispatcher.calls.lock().unwrap().is_empty());
}

#[test]
fn asynchronous_dispatch_preserves_structured_service_failures() {
    let error = persistence_failure();
    let dispatcher = Arc::new(WorkspaceDispatcher {
        calls: Mutex::new(Vec::new()),
        discovery_error: None,
        execution_error: Some(error.clone()),
    });
    let result = run_with_dispatcher(
        dispatcher,
        Arc::new(CoordinatorProvider {
            calls: AtomicUsize::new(0),
        }),
    )
    .unwrap();
    let results = result["completedToolResults"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    for result in results {
        assert_eq!(result["status"], "error");
        assert_eq!(
            result["envelope"]["error"],
            serde_json::to_value(&error).unwrap()
        );
    }
}

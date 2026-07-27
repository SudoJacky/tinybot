use super::*;
use crate::protocol::WorkerRequestCancellation;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

#[test]
fn stream_message_phase_recognizes_provider_phase_fields() {
    assert_eq!(
        stream_message_phase(&json!({ "phase": "commentary" })),
        Some("commentary")
    );
    assert_eq!(
        stream_message_phase(&json!({
            "choices": [{ "delta": { "messagePhase": "final_answer" } }]
        })),
        Some("final_answer")
    );
}

fn aggregate_stream_chunks(chunks: &[Value]) -> Result<Value, String> {
    let mut completion = StreamingChatCompletion::default();
    for chunk in chunks {
        completion.push_chunk(chunk, None)?;
    }
    Ok(completion.finish())
}

#[test]
fn provider_catalog_masks_secret_presence() {
    let body = provider_catalog_body(&json!({
        "providers": {
            "openai": { "api_key": "sk-secret", "api_base": "https://example.test/v1" }
        }
    }));

    let openai = body["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == "openai")
        .unwrap();
    assert_eq!(openai["api_key_configured"], true);
    assert!(openai.get("api_key").is_none());
}

#[test]
fn provider_catalog_exposes_current_built_in_providers_only() {
    let body = provider_catalog_body(&json!({}));
    let provider_ids = body["providers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["id"].as_str().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(provider_ids, vec!["openai", "deepseek", "dashscope"]);
    assert!(!provider_ids.contains(&"openrouter"));
    assert!(!provider_ids.contains(&"ollama"));
    assert!(!provider_ids.contains(&"custom"));
    let deepseek = body["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == "deepseek")
        .unwrap();
    assert_eq!(deepseek["capabilities"], json!(["reasoning"]));
}

#[test]
fn resolves_provider_profile_from_config_and_defaults() {
    let profile = resolve_provider_profile(
        &json!({
            "agents": { "defaults": { "provider": "openai", "model": "gpt-4.1" } },
            "providers": { "openai": {
                "api_key": "sk-secret",
                "models": ["gpt-4.1-custom"],
                "request_timeout_ms": 900,
                "stream_idle_timeout_ms": 125
            } }
        }),
        None,
        None,
    )
    .unwrap();

    assert_eq!(profile.provider_id, "openai");
    assert_eq!(
        profile.api_base.as_deref(),
        Some("https://api.openai.com/v1")
    );
    assert!(profile.api_key_configured);
    assert_eq!(profile.models, vec!["gpt-4.1-custom"]);
    assert_eq!(profile.request_timeout_ms, 900);
    assert_eq!(profile.stream_idle_timeout_ms, 125);
}

#[test]
fn resolves_active_provider_profile_credentials() {
    let config = json!({
        "agents": {
            "defaults": {
                "model": "gpt-4.1",
                "activeProfile": "work"
            }
        },
        "providers": {
            "profiles": {
                "work": {
                    "provider": "openai",
                    "api_key": "sk-profile",
                    "api_base": "https://profile.example.test/v1",
                    "models": ["profile-model"]
                }
            }
        }
    });
    let profile = resolve_provider_profile(&config, None, None).unwrap();
    let models = list_provider_models(
        &config,
        NativeProviderModelsRequest {
            provider_id: Some("openai".to_string()),
            profile_name: Some("work".to_string()),
            ..Default::default()
        },
    )
    .unwrap();

    assert_eq!(profile.provider_id, "openai");
    assert_eq!(
        profile.api_base.as_deref(),
        Some("https://profile.example.test/v1")
    );
    assert_eq!(profile.api_key.as_deref(), Some("sk-profile"));
    assert!(profile.api_key_configured);
    assert_eq!(profile.models, vec!["profile-model"]);
    assert!(models.models.contains(&"profile-model".to_string()));
}

#[test]
fn resolves_configured_custom_openai_compatible_provider_without_catalog_entry() {
    let config = json!({
        "agents": {
            "defaults": {
                "provider": "my_gateway",
                "model": "custom-chat"
            }
        },
        "providers": {
            "my_gateway": {
                "displayName": "My Gateway",
                "api_key": "sk-custom",
                "api_base": "https://gateway.example.test/v1",
                "models": ["custom-chat"]
            }
        }
    });
    let profile = resolve_provider_profile(&config, Some("my_gateway"), None).unwrap();
    let models = list_provider_models(
        &config,
        NativeProviderModelsRequest {
            provider_id: Some("my_gateway".to_string()),
            ..Default::default()
        },
    )
    .unwrap();

    assert_eq!(profile.provider_id, "my_gateway");
    assert_eq!(profile.display_name, "My Gateway");
    assert_eq!(
        profile.api_base.as_deref(),
        Some("https://gateway.example.test/v1")
    );
    assert_eq!(profile.api_key.as_deref(), Some("sk-custom"));
    assert!(profile.supports_model_discovery);
    assert_eq!(models.models, vec!["custom-chat"]);
    assert_eq!(models.sources["profile"], 1);
}

#[test]
fn provider_models_merge_curated_profile_manual_and_fixture_live() {
    let result = list_provider_models(
        &json!({
            "providers": {
                "openai": {
                    "api_key": "sk-secret",
                    "models": ["profile-model"]
                }
            }
        }),
        NativeProviderModelsRequest {
            provider_id: Some("openai".to_string()),
            manual_models: Some(json!("manual-a, manual-b")),
            refresh_live: Some(true),
            live_model_ids: Some(vec!["live-model".to_string()]),
            ..Default::default()
        },
    )
    .unwrap();

    assert!(result.ok);
    assert!(result.models.contains(&"profile-model".to_string()));
    assert!(result.models.contains(&"manual-a".to_string()));
    assert!(result.models.contains(&"live-model".to_string()));
    assert_eq!(result.sources["live"], 1);
}

#[test]
fn provider_models_fetches_openai_compatible_model_list() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
    let api_base = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buffer = [0_u8; 2048];
            let _ = stream.read(&mut buffer);
            let body = r#"{"object":"list","data":[{"id":"live-a","object":"model","created":1,"owned_by":"test"},{"id":"live-b","object":"model","created":1,"owned_by":"test"}]}"#;
            let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
        }
    });

    let result = list_provider_models(
        &json!({
            "providers": {
                "openai": {
                    "api_key": "sk-test",
                    "api_base": api_base
                }
            }
        }),
        NativeProviderModelsRequest {
            provider_id: Some("openai".to_string()),
            refresh_live: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    let _ = server.join();

    assert!(result.ok);
    assert!(result.models.contains(&"live-a".to_string()));
    assert!(result.models.contains(&"live-b".to_string()));
    assert_eq!(result.sources["live"], 2);
}

#[test]
fn dashscope_models_use_openai_compatible_discovery() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
    let api_base = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buffer = [0_u8; 2048];
            let _ = stream.read(&mut buffer);
            let body = r#"{"object":"list","data":[{"id":"qwen-live","object":"model","created":1,"owned_by":"test"}]}"#;
            let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
        }
    });

    let result = list_provider_models(
        &json!({
            "providers": {
                "dashscope": {
                    "api_key": "sk-test",
                    "api_base": api_base
                }
            }
        }),
        NativeProviderModelsRequest {
            provider_id: Some("dashscope".to_string()),
            refresh_live: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    let _ = server.join();

    assert!(result.ok);
    assert!(result.models.contains(&"qwen-plus".to_string()));
    assert!(result.models.contains(&"qwen-live".to_string()));
    assert_eq!(result.sources["live"], 1);
}

#[test]
fn provider_models_reports_discovery_configuration_failure() {
    let result = list_provider_models(
        &json!({ "providers": { "openai": {} } }),
        NativeProviderModelsRequest {
            provider_id: Some("openai".to_string()),
            refresh_live: Some(true),
            ..Default::default()
        },
    )
    .unwrap();

    assert!(result.ok);
    assert_eq!(
        result.warning.as_deref(),
        Some("live discovery skipped: api key is required")
    );
}

#[test]
fn agent_chat_completion_uses_fixture_provider_without_network() {
    let response = complete_chat_for_agent(
        &json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": { "fixture": { "responses": [{ "content": "fixture answer" }] } }
        }),
        &json!({
            "model": "fixture-model",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
    )
    .expect("fixture provider should complete without network");

    assert_eq!(response["object"], "chat.completion");
    assert_eq!(
        response["choices"][0]["message"]["content"],
        "fixture answer"
    );
}

#[test]
fn agent_chat_completion_streams_fixture_response_to_observer() {
    let mut observed = Vec::new();
    let mut observer = |event| observed.push(event);
    let response = complete_chat_for_agent_with_observer(
        &json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": { "fixture": { "responses": [{ "content": "stream answer" }] } }
        }),
        &json!({
            "messages": [{ "role": "user", "content": "hello" }],
            "stream": true
        }),
        &mut observer,
    )
    .expect("streaming fixture provider should complete");

    assert_eq!(
        response["choices"][0]["message"]["content"],
        "stream answer"
    );
    assert_eq!(
        observed,
        vec![NativeProviderStreamEvent::ContentDelta(
            "stream answer".to_string()
        )]
    );
}

#[test]
fn agent_chat_completion_preserves_streaming_request_to_provider() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
    let api_base = format!("http://{}", listener.local_addr().unwrap());
    let (request_tx, request_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buffer = [0_u8; 8192];
            let read = stream.read(&mut buffer).unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let is_streaming = request.contains(r#""stream":true"#);
            let _ = request_tx.send(request);
            let body = if is_streaming {
                concat!(
                        "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n",
                        "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"streamed\"},\"finish_reason\":null}]}\n\n",
                        "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                        "data: [DONE]\n\n"
                    )
            } else {
                r#"{"id":"chatcmpl-test","object":"chat.completion","created":1,"model":"gpt-test","choices":[{"index":0,"message":{"role":"assistant","content":"not streamed"},"finish_reason":"stop"}]}"#
            };
            let content_type = if is_streaming {
                "text/event-stream"
            } else {
                "application/json"
            };
            let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
        }
    });

    let result = complete_chat_for_agent(
        &json!({
            "agents": { "defaults": { "provider": "openai", "model": "gpt-test" } },
            "providers": {
                "openai": {
                    "api_key": "sk-test",
                    "api_base": api_base,
                    "timeout_ms": 500
                }
            }
        }),
        &json!({
            "model": "gpt-test",
            "messages": [{ "role": "user", "content": "hello" }],
            "stream": true
        }),
    )
    .expect("streaming agent completion should aggregate provider chunks");
    let captured_request = request_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("provider request should be captured");
    let _ = server.join();

    assert!(captured_request.contains(r#""stream":true"#));
    assert_eq!(result["choices"][0]["message"]["content"], "streamed");
}

#[test]
fn aggregates_streaming_tool_call_chunks_for_agent_completion() {
    let completion = aggregate_stream_chunks(&[
        json!({"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"workspace.read_file","arguments":"{\"path\""}}]},"finish_reason":null}]}),
        json!({"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\"README.md\"}"}}]},"finish_reason":null}]}),
        json!({"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
    ])
    .expect("streaming tool call chunks should aggregate");

    assert_eq!(
        completion["choices"][0]["message"]["tool_calls"][0]["id"],
        "call-1"
    );
    assert_eq!(
        completion["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "workspace.read_file"
    );
    assert_eq!(
        completion["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
        "{\"path\":\"README.md\"}"
    );
}

#[test]
fn interleaved_streaming_tool_indexes_preserve_model_order() {
    let completion = aggregate_stream_chunks(&[
        json!({"model":"gpt-test","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call-2","type":"function","function":{"name":"workspace.read_file","arguments":"{\"path\":\"second"}},{"index":0,"id":"call-1","type":"function","function":{"name":"workspace.read_file","arguments":"{\"path\":\"first"}}]}}]}),
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".md\"}"}},{"index":1,"function":{"arguments":".md\"}"}}]}}]}),
    ])
    .expect("interleaved tool call chunks should aggregate");

    let tool_calls = completion["choices"][0]["message"]["tool_calls"]
        .as_array()
        .expect("tool calls should be an array");
    assert_eq!(tool_calls[0]["id"], "call-1");
    assert_eq!(
        tool_calls[0]["function"]["arguments"],
        "{\"path\":\"first.md\"}"
    );
    assert_eq!(tool_calls[1]["id"], "call-2");
    assert_eq!(
        tool_calls[1]["function"]["arguments"],
        "{\"path\":\"second.md\"}"
    );
}

#[test]
fn streaming_tool_calls_without_indexes_fall_back_to_chunk_positions() {
    let completion = aggregate_stream_chunks(&[
        json!({"model":"gpt-test","choices":[{"delta":{"tool_calls":[{"id":"call-1","type":"function","function":{"name":"first_tool","arguments":"{\"value\":\"a"}},{"id":"call-2","type":"function","function":{"name":"second_tool","arguments":"{\"value\":\"b"}}]}}]}),
        json!({"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"1\"}"}},{"function":{"arguments":"2\"}"}}]}}]}),
    ])
    .expect("tool call chunks without indexes should use stable positions");

    let tool_calls = completion["choices"][0]["message"]["tool_calls"]
        .as_array()
        .expect("tool calls should be an array");
    assert_eq!(tool_calls[0]["id"], "call-1");
    assert_eq!(tool_calls[0]["function"]["arguments"], "{\"value\":\"a1\"}");
    assert_eq!(tool_calls[1]["id"], "call-2");
    assert_eq!(tool_calls[1]["function"]["arguments"], "{\"value\":\"b2\"}");
}

#[test]
fn streaming_provider_error_chunk_fails_explicitly() {
    let error = aggregate_stream_chunks(&[
        json!({"error":{"message":"quota exceeded","code":"rate_limit"}}),
    ])
    .expect_err("provider error chunks must not produce a completion");

    assert!(error.contains("streaming chat completion returned error"));
    assert!(error.contains("quota exceeded"));
}

#[test]
fn streaming_observer_does_not_change_completion_reduction() {
    let chunks = [
        json!({"model":"gpt-test","phase":"commentary","choices":[{"delta":{"content":"answer ","reasoning_content":"think "}}]}),
        json!({"choices":[{"delta":{"content":"done","reasoningContent":"again"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}),
    ];
    let mut observed = Vec::new();
    let mut observer = |event| observed.push(event);
    let mut observed_completion = StreamingChatCompletion::default();
    for chunk in &chunks {
        observed_completion
            .push_chunk(chunk, Some(&mut observer))
            .expect("stream should aggregate with an observer");
    }
    let mut with_observer = observed_completion.finish();
    let mut without_observer =
        aggregate_stream_chunks(&chunks).expect("stream should aggregate without observer");

    for completion in [&mut with_observer, &mut without_observer] {
        completion["id"] = Value::String("normalized-id".to_string());
        completion["created"] = Value::Number(0.into());
    }
    assert_eq!(with_observer, without_observer);
    assert_eq!(
        observed,
        vec![
            NativeProviderStreamEvent::MessagePhase("commentary".to_string()),
            NativeProviderStreamEvent::ContentDelta("answer ".to_string()),
            NativeProviderStreamEvent::ReasoningDelta("think ".to_string()),
            NativeProviderStreamEvent::ContentDelta("done".to_string()),
            NativeProviderStreamEvent::ReasoningDelta("again".to_string()),
        ]
    );
}

#[test]
fn aggregates_streaming_reasoning_and_usage_for_agent_completion() {
    let completion = aggregate_stream_chunks(&[
        json!({"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{"reasoning_content":"think "},"finish_reason":null}]}),
        json!({"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{"reasoningContent":"again","content":"done"},"finish_reason":"stop"}]}),
        json!({"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}),
    ])
    .expect("streaming reasoning and usage chunks should aggregate");

    assert_eq!(
        completion["choices"][0]["message"]["reasoning_content"],
        "think again"
    );
    assert_eq!(completion["choices"][0]["message"]["content"], "done");
    assert_eq!(completion["usage"]["prompt_tokens"], 7);
    assert_eq!(completion["usage"]["completion_tokens"], 5);
    assert_eq!(completion["usage"]["total_tokens"], 12);
}

#[test]
fn agent_chat_completion_rejects_invalid_messages() {
    let error = complete_chat_for_agent(
        &json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": { "fixture": { "responses": [{ "content": "unused" }] } }
        }),
        &json!({ "messages": [] }),
    )
    .expect_err("empty messages should be rejected");

    assert!(error.contains("messages must be a non-empty array"));
}

#[test]
fn agent_chat_completion_reports_provider_configuration_failure() {
    let error = complete_chat_for_agent(
        &json!({
            "agents": { "defaults": { "provider": "openai", "model": "gpt-4.1" } },
            "providers": { "openai": { "api_key": "" } }
        }),
        &json!({
            "messages": [{ "role": "user", "content": "hello" }]
        }),
    )
    .expect_err("missing provider credentials should be reported");

    assert!(error.contains("requires an API key"));
}

#[test]
fn async_agent_chat_reports_request_timeout_separately() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
    let api_base = format!("http://{}", listener.local_addr().unwrap());
    let stalled_server = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buffer = [0_u8; 512];
            let _ = stream.read(&mut buffer);
            thread::sleep(Duration::from_millis(250));
        }
    });
    let mut observer = |_event: NativeProviderStreamEvent| {};

    let error = tauri::async_runtime::block_on(complete_chat_for_agent_with_observer_async(
        &json!({
            "agents": { "defaults": { "provider": "openai", "model": "gpt-test" } },
            "providers": { "openai": {
                "api_key": "sk-test",
                "api_base": api_base,
                "request_timeout_ms": 25
            } }
        }),
        &json!({
            "model": "gpt-test",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        &mut observer,
        None,
    ))
    .expect_err("stalled request should time out");

    let _ = stalled_server.join();
    assert_eq!(error.kind(), NativeProviderFailureKind::RequestTimeout);
}

#[test]
fn async_agent_stream_reports_idle_timeout_after_partial_output() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
    let api_base = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buffer = [0_u8; 8192];
            let _ = stream.read(&mut buffer);
            let event = "data: {\"id\":\"chatcmpl-idle\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"first\"},\"finish_reason\":null}]}\n\n";
            let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n{:X}\r\n{}\r\n",
                    event.len(),
                    event
                );
            let _ = stream.flush();
            thread::sleep(Duration::from_millis(250));
        }
    });
    let mut observed = Vec::new();
    let mut observer = |event: NativeProviderStreamEvent| observed.push(event);

    let error = tauri::async_runtime::block_on(complete_chat_for_agent_with_observer_async(
        &json!({
            "agents": { "defaults": { "provider": "openai", "model": "gpt-test" } },
            "providers": { "openai": {
                "api_key": "sk-test",
                "api_base": api_base,
                "request_timeout_ms": 500,
                "stream_idle_timeout_ms": 25
            } }
        }),
        &json!({
            "model": "gpt-test",
            "messages": [{ "role": "user", "content": "hello" }],
            "stream": true
        }),
        &mut observer,
        None,
    ))
    .expect_err("stalled stream should hit its idle timeout");

    let _ = server.join();
    assert_eq!(error.kind(), NativeProviderFailureKind::StreamIdleTimeout);
    assert_eq!(
        observed,
        vec![NativeProviderStreamEvent::ContentDelta("first".to_string())]
    );
}

#[test]
fn async_agent_stream_stops_observing_after_partial_output_cancellation() {
    struct TestCancellation(Arc<AtomicBool>);

    impl WorkerRequestCancellation for TestCancellation {
        fn is_cancelled(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }

    let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
    let api_base = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buffer = [0_u8; 8192];
            let _ = stream.read(&mut buffer);
            let body = concat!(
                    "data: {\"id\":\"chatcmpl-cancel\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"first\"},\"finish_reason\":null}]}\n\n",
                    "data: {\"id\":\"chatcmpl-cancel\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"late\"},\"finish_reason\":null}]}\n\n",
                    "data: [DONE]\n\n"
                );
            let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            let _ = stream.flush();
        }
    });
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancellation = Arc::new(TestCancellation(cancelled.clone()));
    let observer_cancellation = cancelled.clone();
    let mut observed = Vec::new();
    let mut observer = |event: NativeProviderStreamEvent| {
        observed.push(event);
        observer_cancellation.store(true, Ordering::SeqCst);
    };

    let error = tauri::async_runtime::block_on(complete_chat_for_agent_with_observer_async(
        &json!({
            "agents": { "defaults": { "provider": "openai", "model": "gpt-test" } },
            "providers": { "openai": {
                "api_key": "sk-test",
                "api_base": api_base,
                "request_timeout_ms": 500,
                "stream_idle_timeout_ms": 500
            } }
        }),
        &json!({
            "model": "gpt-test",
            "messages": [{ "role": "user", "content": "hello" }],
            "stream": true
        }),
        &mut observer,
        Some(cancellation),
    ))
    .expect_err("stream cancellation should stop before a second delta");

    let _ = server.join();
    assert_eq!(error.kind(), NativeProviderFailureKind::Cancelled);
    assert_eq!(
        observed,
        vec![NativeProviderStreamEvent::ContentDelta("first".to_string())]
    );
}

#[test]
fn async_agent_chat_honors_cancellation_before_provider_request() {
    struct TestCancellation(Arc<AtomicBool>);

    impl WorkerRequestCancellation for TestCancellation {
        fn is_cancelled(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }

    let cancellation = Arc::new(TestCancellation(Arc::new(AtomicBool::new(true))));
    let mut observer = |_event: NativeProviderStreamEvent| {};
    let error = tauri::async_runtime::block_on(complete_chat_for_agent_with_observer_async(
        &json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": { "fixture": { "responses": [{ "content": "unused" }] } }
        }),
        &json!({
            "model": "fixture-model",
            "messages": [{ "role": "user", "content": "hello" }]
        }),
        &mut observer,
        Some(cancellation),
    ))
    .expect_err("cancelled request should not reach the fixture provider");

    assert_eq!(error.kind(), NativeProviderFailureKind::Cancelled);
}

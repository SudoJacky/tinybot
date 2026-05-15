from tinybot.cowork.mailbox import CoworkEnvelope, CoworkMailbox
from tinybot.cowork.service import CoworkService
from tinybot.cowork.snapshot import build_cowork_agent_steps, build_cowork_graph, build_cowork_trace
from tinybot.cowork.types import CoworkMailboxRecord


def test_graph_schema_includes_rich_nodes_edges_and_metadata(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Observe work", "Observe", [], [])
    agent_id = next(iter(session.agents))
    service.complete_task(session, "1", '{"answer":"Done","artifacts":["out.md"],"findings":["Fact"],"confidence":0.9}')
    session.completion_decision = service.assess_session(session, save=False)

    graph = build_cowork_graph(session)
    kinds = {node["kind"] for node in graph["nodes"]}
    edge_kinds = {edge["kind"] for edge in graph["edges"]}

    assert graph["schema_version"] == "cowork.graph.v2"
    assert graph["generated_at"]
    assert "node_kinds" in graph["stats"]
    assert {"session", "agent", "task", "thread", "message", "artifact", "memory", "decision", "budget"} <= kinds
    assert {"member", "assigned_to", "produced", "uses_memory"} & edge_kinds
    assert any(node["id"] == f"agent:{agent_id}" for node in graph["nodes"])
    assert "truncated" in graph


def test_graph_exposes_mailbox_reply_cause_and_blocker_edges(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Causality", "Causality", [], [])
    sender, recipient = list(session.agents)[:2]
    service.add_mailbox_record(
        session,
        CoworkMailboxRecord(
            id="env_parent",
            sender_id=sender,
            recipient_ids=[recipient],
            content="Need review",
            status="read",
            requires_reply=True,
            blocking_task_id="1",
        ),
    )
    service.add_mailbox_record(
        session,
        CoworkMailboxRecord(
            id="env_reply",
            sender_id=recipient,
            recipient_ids=[sender],
            content="Reviewed",
            status="delivered",
            reply_to_envelope_id="env_parent",
            caused_by_envelope_id="env_parent",
        ),
    )

    graph = build_cowork_graph(session)
    edge_kinds = {edge["kind"] for edge in graph["edges"]}

    assert {"replied_to", "caused_by", "blocks"} <= edge_kinds


def test_trace_records_scheduler_decision_and_stop_reason(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Trace", "Trace", [], [])
    service.record_scheduler_decision(
        session,
        run_id="run_1",
        round_id="round_1",
        selected_agent_ids=["coordinator"],
        candidate_scores=[{"agent_id": "coordinator", "score": 10, "activation_reasons": ["ready_task"]}],
        reason="Selected coordinator",
    )
    service.record_stop_reason(session, "idle", "No ready agents", run_id="run_1", round_id="round_2")

    trace = build_cowork_trace(session)

    assert any(item["type"] == "scheduler.decision" for item in trace)
    assert any(item["payload"].get("stop_reason") == "idle" for item in trace)


def test_default_zero_spawn_budget_does_not_stop_scheduler(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Run without dynamic spawn", "Spawn budget", [], [])
    parent_agent_id = next(iter(session.agents))

    assert session.budget_limits["max_spawned_agents"] == 0
    assert service.budget_exhaustion_reason(session, run_agent_calls=0, run_agent_call_limit=30) == ""

    result = service.spawn_agent(
        session,
        parent_agent_id=parent_agent_id,
        role="Specialist",
        goal="Try to spawn",
        save=False,
    )

    assert result == "Error: spawned-agent budget exhausted"
    assert session.stop_reason == "spawn_budget_exhausted"


def test_legacy_session_generates_valid_graph_and_non_verbose_privacy(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Legacy", "Legacy", [], [])
    session.budget_limits = {}
    session.budget_usage = {}
    graph = build_cowork_graph(session)

    assert graph["schema_version"] == "cowork.graph.v2"
    assert graph["stats"]["total_agents"] >= 1


def test_stale_blocker_escalates_to_lead(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Escalate", "Escalate", [], [])
    sender, recipient = list(session.agents)[:2]
    record = CoworkMailboxRecord(
        id="env_stale",
        sender_id=sender,
        recipient_ids=[recipient],
        content="Blocked",
        status="read",
        requires_reply=True,
        escalate_after_rounds=1,
        blocking_task_id="1",
    )
    service.add_mailbox_record(session, record)
    session.rounds = 1

    escalated = service.escalate_stale_blockers(session)

    assert [item.id for item in escalated] == ["env_stale"]
    assert session.mailbox["env_stale"].escalated_at
    assert any(event.type == "mailbox.stale_blocker" for event in session.events)


def test_legacy_trace_projects_to_bounded_agent_steps(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Project steps", "Steps", [], [])
    agent_id = next(iter(session.agents))
    service.add_trace_event(
        session,
        kind="tool",
        name="Tool call",
        actor_id=agent_id,
        input_ref="secret " * 200,
        summary="Collected a concise result",
        data={"task_id": "1", "architecture": session.workflow_mode},
        save=False,
    )

    steps = build_cowork_agent_steps(session)
    tool_step = next(step for step in steps if step["source_span_id"])

    assert tool_step["projected"] is True
    assert tool_step["session_id"] == session.id
    assert tool_step["branch_id"] == session.current_branch_id
    assert tool_step["architecture"] == "adaptive_starter"
    assert tool_step["agent_id"] == agent_id
    assert tool_step["task_id"] == "1"
    assert tool_step["summary"]["action_kind"] == "tool"
    assert tool_step["summary"]["outcome_summary"] == "Collected a concise result"
    assert len(tool_step["summary"]["input_summary"]) <= 220


def test_trace_includes_native_agent_steps(temp_workspace):
    from tinybot.cowork.types import CoworkAgentStep

    service = CoworkService(temp_workspace)
    session = service.create_session("Native step", "Native", [], [])
    agent_id = next(iter(session.agents))
    session.agent_steps.append(
        CoworkAgentStep(
            id="step_1",
            session_id=session.id,
            branch_id=session.current_branch_id,
            architecture=session.workflow_mode,
            agent_id=agent_id,
            action_kind="agent_run",
            scheduler_reason="Ready task",
            status="completed",
            task_id="1",
            output_summary="Finished the task",
        )
    )

    trace = build_cowork_trace(session)

    assert any(item["source"] == "agent_step" and item["id"] == "step_1" for item in trace)


def test_parallel_mailbox_replies_track_all_required_agents(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Replies", "Replies", [], [])
    sender, first, second = list(session.agents)
    mailbox = CoworkMailbox(service)
    mailbox.deliver(
        session,
        CoworkEnvelope(
            sender_id=sender,
            recipient_ids=[first, second],
            content="Both reply",
            kind="question",
            requires_reply=True,
        ),
    )
    request = next(record for record in session.mailbox.values() if record.requires_reply)

    mailbox.deliver(
        session, CoworkEnvelope(sender_id=first, recipient_ids=[sender], content="one", reply_to_envelope_id=request.id)
    )
    assert session.mailbox[request.id].status != "replied"
    mailbox.deliver(
        session,
        CoworkEnvelope(sender_id=second, recipient_ids=[sender], content="two", reply_to_envelope_id=request.id),
    )

    assert set(session.mailbox[request.id].replied_by) == {first, second}
    assert session.mailbox[request.id].status == "replied"

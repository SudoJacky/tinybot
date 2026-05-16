import pytest

from tinybot.agent.tools.cowork import CoworkTool
from tinybot.api.cowork import cowork_session_snapshot
from tinybot.cowork.snapshot import build_cowork_swarm_organization
from tinybot.cowork.service import CoworkService
from tinybot.cowork.swarm import (
    assess_swarm_orchestration,
    build_swarm_parallel_metrics,
    build_swarm_scheduler_queues,
    normalize_swarm_plan,
    validate_swarm_plan,
)
from tinybot.providers.base import LLMResponse, ToolCallRequest
from tests.cowork.fixtures import (
    create_budget_exhaustion_fixture,
    create_code_review_swarm_fixture,
    create_expert_panel_fixture,
    create_large_swarm_fixture,
    create_research_matrix_fixture,
)


class PlanningProvider:
    async def chat(self, *args, **kwargs):
        return LLMResponse(
            content=None,
            tool_calls=[
                ToolCallRequest(
                    id="call_plan",
                    name="submit_cowork_team",
                    arguments={
                        "title": "Planned swarm",
                        "agents": [
                            {
                                "id": "lead",
                                "name": "Lead",
                                "role": "Lead",
                                "goal": "Lead",
                                "responsibilities": [],
                                "tools": ["cowork_internal"],
                            },
                            {
                                "id": "worker",
                                "name": "Worker",
                                "role": "Worker",
                                "goal": "Work",
                                "responsibilities": [],
                                "tools": ["read_file", "cowork_internal"],
                            },
                        ],
                        "tasks": [
                            {"id": "map_a", "title": "Map A", "description": "Map A", "assigned_agent_id": "worker"},
                            {
                                "id": "reduce",
                                "title": "Reduce",
                                "description": "Reduce",
                                "assigned_agent_id": "lead",
                                "dependencies": ["map_a"],
                            },
                        ],
                    },
                )
            ],
        )


def test_swarm_session_creates_active_plan_with_work_units(temp_workspace):
    service = CoworkService(temp_workspace)

    session = service.create_session(
        "Build an observable swarm",
        "Swarm",
        [
            {"id": "lead", "name": "Lead", "role": "Coordinator", "goal": "Lead", "tools": ["cowork_internal"]},
            {
                "id": "worker",
                "name": "Worker",
                "role": "Worker",
                "goal": "Work",
                "tools": ["read_file", "cowork_internal"],
            },
        ],
        [
            {"id": "plan", "title": "Plan", "description": "Create plan", "assigned_agent_id": "lead"},
            {
                "id": "inspect",
                "title": "Inspect",
                "description": "Inspect evidence",
                "assigned_agent_id": "worker",
                "dependencies": ["plan"],
            },
        ],
        workflow_mode="swarm",
    )

    assert session.workflow_mode == "swarm"
    assert session.swarm_plan["status"] == "active"
    assert session.swarm_plan["lead_agent_id"] == "lead"
    assert [unit["id"] for unit in session.swarm_plan["work_units"]] == ["plan", "inspect"]
    assert session.swarm_plan["work_units"][0]["status"] == "ready"
    assert session.swarm_plan["work_units"][1]["status"] == "pending"
    assert any(span.kind == "swarm" and span.name == "Swarm plan created" for span in session.trace_spans)


def test_swarm_orchestration_assessment_keeps_simple_goal_small(temp_workspace):
    service = CoworkService(temp_workspace)

    session = service.create_session(
        "Summarize this one short note",
        "Simple swarm",
        [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Answer", "tools": ["cowork_internal"]}],
        [{"id": "answer", "title": "Answer", "description": "Answer directly", "assigned_agent_id": "lead"}],
        workflow_mode="swarm",
    )

    assessment = session.swarm_plan["orchestration"]
    assert assessment["recommended_mode"] in {"single", "team"}
    assert assessment["spawn_strategy"] == "no_spawn"
    assert assessment["fanout_score"] < 0.5
    assert "limited separability" in " ".join(assessment["fanout_rationale"])


def test_swarm_orchestration_assessment_detects_separable_work(temp_workspace):
    service = CoworkService(temp_workspace)

    session = service.create_session(
        "Run an expert panel review comparing market, security, customer, GTM, finance, and engineering risks",
        "Expert panel",
        [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]},
            {"id": "market", "name": "Market", "role": "Market expert", "goal": "Market", "tools": ["cowork_internal"]},
            {
                "id": "security",
                "name": "Security",
                "role": "Security expert",
                "goal": "Security",
                "tools": ["cowork_internal"],
            },
            {"id": "gtm", "name": "GTM", "role": "GTM expert", "goal": "GTM", "tools": ["cowork_internal"]},
        ],
        [
            {
                "id": "market",
                "title": "Market review",
                "description": "Market",
                "assigned_agent_id": "market",
                "fanout_group_id": "market",
            },
            {
                "id": "security",
                "title": "Security review",
                "description": "Security",
                "assigned_agent_id": "security",
                "fanout_group_id": "security",
            },
            {
                "id": "gtm",
                "title": "GTM review",
                "description": "GTM",
                "assigned_agent_id": "gtm",
                "fanout_group_id": "gtm",
            },
            {
                "id": "finance",
                "title": "Finance review",
                "description": "Finance",
                "assigned_agent_id": "market",
                "fanout_group_id": "finance",
            },
            {
                "id": "customer",
                "title": "Customer review",
                "description": "Customer",
                "assigned_agent_id": "gtm",
                "fanout_group_id": "customer",
            },
            {
                "id": "engineering",
                "title": "Engineering review",
                "description": "Engineering",
                "assigned_agent_id": "security",
                "fanout_group_id": "engineering",
            },
        ],
        workflow_mode="swarm",
        budgets={"parallel_width": 4, "max_spawned_agents": 3},
    )

    assessment = session.swarm_plan["orchestration"]
    assert assessment["recommended_mode"] in {"small_swarm", "large_swarm"}
    assert assessment["fanout_score"] >= 0.5
    assert assessment["parallel_width_recommendation"] > 1
    assert assessment["spawn_strategy"] == "spawn_per_workstream"
    assert len(assessment["workstream_hints"]) >= 4


def test_swarm_orchestration_assessment_marks_risky_goal_for_review_and_user_input(temp_workspace):
    assessment = assess_swarm_orchestration(
        goal="Implement code changes, write files, and run command validation",
        agents={},
        tasks={},
        work_units=[
            {
                "id": "code",
                "title": "Code",
                "description": "Edit files",
                "tool_allowlist": ["cowork_internal", "edit_file", "exec"],
                "dependencies": [],
            }
        ],
        budgets={"parallel_width": 2},
        policy={"allowed_tools": ["cowork_internal"], "allow_file_writes": False, "allow_exec": False},
    )

    assert assessment["risk_level"] in {"medium", "high"}
    assert assessment["requires_review"] is True
    assert assessment["requires_user_input"] is True


def test_swarm_orchestration_assessment_is_exposed_in_snapshot(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Compare options", "Compare", [], [], workflow_mode="swarm")

    snapshot = cowork_session_snapshot(session)

    assert snapshot["orchestration_assessment"] == session.swarm_plan["orchestration"]
    assert snapshot["swarm_plan"]["orchestration"]["id"].startswith("orch_")


def test_swarm_parallel_metrics_compute_dependency_depth_and_coverage(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Measure useful fanout",
        "Metrics",
        [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]}],
        [
            {"id": "unit_a", "title": "A", "description": "A", "assigned_agent_id": "lead"},
            {"id": "unit_b", "title": "B", "description": "B", "assigned_agent_id": "lead", "dependencies": ["unit_a"]},
        ],
        workflow_mode="swarm",
        budgets={"parallel_width": 3},
    )
    service.complete_task(session, "unit_a", '{"answer":"a","confidence":0.8}')
    service.complete_task(session, "unit_b", '{"answer":"b","confidence":0.8}')
    reducer_task = next(task for task in session.tasks.values() if task.title == "Reduce swarm results")
    service.complete_task(
        session,
        reducer_task.id,
        '{"answer":"final","confidence":0.9,"source_work_unit_ids":["unit_a","unit_b"]}',
    )

    metrics = build_swarm_parallel_metrics(session)
    snapshot = cowork_session_snapshot(session)

    assert metrics["critical_path_depth"] >= 3
    assert metrics["reducer_coverage"] == 1.0
    assert metrics["parallel_efficiency"] > 0
    assert snapshot["swarm_metrics"]["reducer_coverage"] == 1.0


def test_swarm_organization_projection_groups_workstreams_and_gates(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Research multiple product risks",
        "Organization",
        [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]},
            {"id": "market", "name": "Market", "role": "Market", "goal": "Market", "tools": ["cowork_internal"]},
            {
                "id": "security",
                "name": "Security",
                "role": "Security",
                "goal": "Security",
                "tools": ["cowork_internal"],
            },
        ],
        [
            {
                "id": "market_a",
                "title": "Market A",
                "description": "Market A",
                "assigned_agent_id": "market",
                "fanout_group_id": "market",
            },
            {
                "id": "market_b",
                "title": "Market B",
                "description": "Market B",
                "assigned_agent_id": "market",
                "fanout_group_id": "market",
            },
            {
                "id": "security_a",
                "title": "Security A",
                "description": "Security A",
                "assigned_agent_id": "security",
                "fanout_group_id": "security",
            },
        ],
        workflow_mode="swarm",
        budgets={"parallel_width": 2},
    )
    service.complete_task(session, "market_a", '{"answer":"done","confidence":0.8}')

    organization = build_cowork_swarm_organization(session)
    snapshot = cowork_session_snapshot(session)

    assert organization["schema_version"] == "cowork.swarm_organization.v1"
    assert organization["plan_id"] == session.swarm_plan["id"]
    assert organization["grouped_counts"]["workstreams"] == 2
    assert organization["gates"]["reducer"]["required"] is True
    assert organization["metrics"]["schema_version"] == "cowork.swarm_metrics.v1"
    assert snapshot["swarm_organization"]["workstreams"]
    market = next(item for item in organization["workstreams"] if item["id"] == "market")
    assert market["unit_counts"]["completed"] == 1
    assert market["agent_ids"] == ["market"]


def test_swarm_metrics_expose_duplicate_and_blocked_slots_in_queues(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Blocked metrics",
        "Blocked metrics",
        [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]}],
        [
            {"id": "unit_a", "title": "A", "description": "A", "assigned_agent_id": "lead"},
            {
                "id": "unit_b",
                "title": "B",
                "description": "B",
                "assigned_agent_id": "lead",
                "dependencies": ["missing"],
            },
        ],
        workflow_mode="swarm",
        budgets={"parallel_width": 2},
    )
    service.add_event(
        session,
        "swarm.duplicate_activation_skipped",
        "duplicate",
        actor_id="scheduler",
        data={"work_unit_id": "unit_a"},
    )

    queues = build_swarm_scheduler_queues(session)
    metrics = queues["metrics"]

    assert metrics["duplicate_rejection_count"] == 1
    assert metrics["blocked_slot_count"] >= 1
    assert queues["queues"]["blocked"][0]["id"] == "unit_b"


def test_scheduler_decision_and_run_metrics_include_swarm_metrics(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Decision metrics", "Decision", [], [], workflow_mode="swarm")

    decision = service.record_scheduler_decision(
        session,
        run_id="run_metrics",
        round_id="round_1",
        selected_agent_ids=[next(iter(session.agents))],
        candidate_scores=[],
        reason="test",
    )
    service.start_run_metrics(session, "run_metrics")
    metric = service.finish_run_metrics(session, "run_metrics", rounds=1, agent_calls=1)

    assert decision["swarm_metrics"]["schema_version"] == "cowork.swarm_metrics.v1"
    assert metric is not None
    assert metric.swarm_metrics["schema_version"] == "cowork.swarm_metrics.v1"


def test_agent_prompt_includes_swarm_orchestration_assessment(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Compare product strategy options",
        "Prompt",
        [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]}],
        [{"id": "option_a", "title": "Option A", "description": "Analyze option A", "assigned_agent_id": "lead"}],
        workflow_mode="swarm",
    )
    agent = session.agents["lead"]

    system_prompt = CoworkTool._build_agent_system_prompt(session, agent)
    work_prompt = CoworkTool._build_agent_work_prompt(session, agent, [], session.tasks["option_a"])

    assert "Swarm orchestration assessment:" in system_prompt
    assert "fanout_score=" in system_prompt
    assert "spawn_strategy=" in work_prompt


def test_work_unit_context_is_bounded_and_uses_authorized_refs(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Delegate bounded research",
        "Context",
        [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]}],
        [
            {"id": "collect", "title": "Collect", "description": "Collect source", "assigned_agent_id": "lead"},
            {
                "id": "analyze",
                "title": "Analyze",
                "description": "Analyze source",
                "assigned_agent_id": "lead",
                "dependencies": ["collect"],
            },
        ],
        workflow_mode="swarm",
        budgets={"max_spawned_agents": 2},
    )
    service.complete_task(session, "collect", '{"answer":"source summary","confidence":0.8}')
    delegated = service.request_agent_delegation(
        session,
        parent_agent_id="lead",
        task_goal="Analyze source in isolation",
        role="Bounded analyst",
        name="Bounded Analyst",
        input_references=[{"ref": "artifact_1", "type": "artifact", "summary": "Allowed artifact"}, {}],
        tools=["cowork_internal"],
        work_unit_id="analyze",
    )

    assert not isinstance(delegated, str)
    sub_agent = delegated["sub_agent"]
    context = service.work_unit_context_for_agent(session, sub_agent.id, task_id="analyze", work_unit_id="analyze")

    assert context["schema_version"] == "cowork.work_unit_context.v1"
    assert context["private_history_included"] is False
    assert context["work_unit"]["id"] == "analyze"
    assert context["delegated_brief"]["task_goal"] == "Analyze source in isolation"
    assert context["authorized_refs"]["artifact_refs"] == ["artifact_1"]
    assert context["authorized_refs"]["redacted_reference_count"] == 1
    assert context["source_summaries"][0]["summary"] == "source summary"
    assert "parent agent's private history" in sub_agent.context_policy


def test_spawn_trace_surfaces_context_reference_counts(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Trace context refs",
        "Trace refs",
        [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]}],
        [],
        workflow_mode="swarm",
        budgets={"max_spawned_agents": 1},
    )

    delegated = service.request_agent_delegation(
        session,
        parent_agent_id="lead",
        task_goal="Trace refs",
        input_references=[{"ref": "artifact_1", "type": "artifact"}, {}],
        tools=["cowork_internal"],
    )

    assert not isinstance(delegated, str)
    spawn_event = next(event for event in session.events if event.type == "agent.spawned")
    spawn_span = next(span for span in session.trace_spans if span.name == "Agent spawned")
    assert spawn_event.data["authorized_artifact_ref_count"] == 1
    assert spawn_event.data["redacted_reference_count"] == 1
    assert spawn_span.data["authorized_artifact_ref_count"] == 1
    assert spawn_span.data["redacted_reference_count"] == 1


@pytest.mark.asyncio
async def test_swarm_start_preserves_planned_work_units(temp_workspace):
    service = CoworkService(temp_workspace)
    tool = CoworkTool(service, PlanningProvider(), temp_workspace, "test-model", 1200)

    result = await tool.execute(action="start", goal="Research and reduce", workflow_mode="swarm")
    session = service.list_sessions(include_completed=True)[0]

    assert "Cowork session started" in result
    assert session.workflow_mode == "swarm"
    assert set(session.tasks) == {"map_a", "reduce"}
    assert [unit["id"] for unit in session.swarm_plan["work_units"]] == ["map_a", "reduce"]
    assert session.swarm_plan["work_units"][1]["dependencies"] == ["map_a"]


def test_swarm_plan_validation_reports_missing_dependency(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Validate", "Validate", [], [], workflow_mode="swarm")

    plan = normalize_swarm_plan(
        {
            "work_units": [
                {
                    "id": "unit_a",
                    "title": "A",
                    "description": "A",
                    "dependencies": ["missing"],
                }
            ]
        },
        goal=session.goal,
        lead_agent_id=service.lead_agent_id(session),
        agents=session.agents,
        tasks=session.tasks,
        budgets=session.budget_limits,
    )

    diagnostics = validate_swarm_plan(plan, agents=session.agents, tasks=session.tasks)

    assert any(item["code"] == "missing_work_unit_dependency" for item in diagnostics)


def test_swarm_plan_validation_reports_cycles_duplicates_tools_and_budget(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Validate", "Validate", [], [], workflow_mode="swarm")
    lead = service.lead_agent_id(session)
    plan = {
        "id": "swarm_test",
        "goal": "Validate",
        "status": "active",
        "strategy": "map_reduce",
        "lead_agent_id": lead,
        "reducer_agent_id": lead,
        "reviewer_agent_id": None,
        "budgets": {**session.budget_limits, "max_work_units": 1},
        "policy": {"allowed_tools": ["cowork_internal"]},
        "work_units": [
            {
                "id": "unit_a",
                "title": "A",
                "description": "A",
                "dependencies": ["unit_b"],
                "status": "pending",
                "tool_allowlist": ["cowork_internal", "exec"],
            },
            {
                "id": "unit_b",
                "title": "B",
                "description": "B",
                "dependencies": ["unit_a"],
                "status": "pending",
                "tool_allowlist": ["cowork_internal"],
            },
            {
                "id": "unit_b",
                "title": "Duplicate B",
                "description": "Duplicate B",
                "dependencies": ["unit_a"],
                "status": "ready",
                "tool_allowlist": ["cowork_internal"],
            },
        ],
    }

    codes = {item["code"] for item in validate_swarm_plan(plan, agents=session.agents, tasks=session.tasks)}

    assert "duplicate_work_unit_id" in codes
    assert "tool_disallowed" in codes
    assert "work_unit_dependency_cycle" in codes
    assert "work_unit_budget_exhausted" in codes


def test_task_completion_syncs_swarm_work_unit_result_and_artifact(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Produce report", "Report", [], [], workflow_mode="swarm")
    task_id = next(iter(session.tasks))

    service.complete_task(
        session,
        task_id,
        '{"answer":"done","findings":["f"],"artifacts":["report.md"],"confidence":0.8}',
    )

    unit = next(unit for unit in session.swarm_plan["work_units"] if unit["source_task_id"] == task_id)
    assert unit["status"] == "completed"
    assert unit["result"]["answer"] == "done"
    assert unit["artifacts"][0]["path_or_url"] == "report.md"
    assert unit["confidence"] == 0.8


def test_work_unit_lifecycle_start_fail_retry_skip(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Lifecycle", "Lifecycle", [], [], workflow_mode="swarm")
    unit_id = session.swarm_plan["work_units"][0]["id"]
    agent_id = next(iter(session.agents))

    started = service.start_work_unit(session, unit_id, agent_id)
    failed = service.fail_work_unit(session, unit_id, "boom")
    retried = service.retry_work_unit(session, unit_id, reason="try again")
    skipped = service.skip_work_unit(session, unit_id, reason="not needed")
    cancelled = service.cancel_work_unit(session, unit_id, reason="stop")

    unit = session.swarm_plan["work_units"][0]
    assert "started" in started
    assert "failed" in failed
    assert "queued for retry" in retried
    assert "skipped" in skipped
    assert "cancelled" in cancelled
    assert unit["status"] == "cancelled"
    assert any(span.name == "Work unit started" for span in session.trace_spans)
    assert any(span.name == "Work unit failed" for span in session.trace_spans)
    assert any(span.name == "Work unit retried" for span in session.trace_spans)
    assert any(span.name == "Work unit skipped" for span in session.trace_spans)
    assert any(span.name == "Work unit cancelled" for span in session.trace_spans)


def test_temporary_worker_inherits_swarm_tool_policy(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Spawn worker",
        "Spawn",
        [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]}],
        [],
        workflow_mode="swarm",
        budgets={"max_spawned_agents": 1},
        blueprint={"policy": {"allowed_tools": ["cowork_internal", "read_file"], "allow_exec": False}},
    )

    worker = service.spawn_agent(
        session,
        parent_agent_id="lead",
        role="Research specialist",
        goal="Inspect context",
        tools=["cowork_internal", "read_file", "exec"],
        reason="Need bounded specialist",
        work_unit_id=session.swarm_plan["work_units"][0]["id"],
    )

    assert not isinstance(worker, str)
    assert worker.lifetime == "temporary"
    assert worker.parent_agent_id == "lead"
    assert worker.tools == ["cowork_internal", "read_file"]
    spawn_event = next(event for event in session.events if event.type == "agent.spawned")
    assert spawn_event.data["removed_tools_by_policy"] == ["exec"]
    assert spawn_event.data["work_unit_id"] == session.swarm_plan["work_units"][0]["id"]


def test_swarm_scheduler_respects_parallel_width_and_starts_units(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Run bounded swarm",
        "Bounded swarm",
        [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]},
            {"id": "a", "name": "A", "role": "Worker", "goal": "A", "tools": ["cowork_internal"]},
            {"id": "b", "name": "B", "role": "Worker", "goal": "B", "tools": ["cowork_internal"]},
            {"id": "c", "name": "C", "role": "Worker", "goal": "C", "tools": ["cowork_internal"]},
        ],
        [
            {"id": "unit_a", "title": "Unit A", "description": "A", "assigned_agent_id": "a"},
            {"id": "unit_b", "title": "Unit B", "description": "B", "assigned_agent_id": "b"},
            {"id": "unit_c", "title": "Unit C", "description": "C", "assigned_agent_id": "c"},
        ],
        workflow_mode="swarm",
        budgets={"parallel_width": 2},
    )
    for agent_id in session.agents:
        service.mark_messages_read(session, agent_id)

    selected = service.select_active_agents(session, limit=10)

    assert [agent.id for agent in selected] == ["a", "b"]
    in_progress = [unit for unit in session.swarm_plan["work_units"] if unit["status"] == "in_progress"]
    assert [unit["id"] for unit in in_progress] == ["unit_a", "unit_b"]
    assert session.tasks["unit_c"].status == "pending"
    assert any(span.name == "Work unit started" for span in session.trace_spans)


def test_swarm_scheduler_prevents_duplicate_work_unit_activation(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Deduplicate",
        "Deduplicate",
        [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]},
            {"id": "a", "name": "A", "role": "Worker", "goal": "A", "tools": ["cowork_internal"]},
            {"id": "b", "name": "B", "role": "Worker", "goal": "B", "tools": ["cowork_internal"]},
        ],
        [],
        workflow_mode="swarm",
        budgets={"parallel_width": 2},
    )
    session.tasks.clear()
    session.swarm_plan["work_units"] = [
        {
            "id": "same_a",
            "title": "Same",
            "description": "same input",
            "input": {"topic": "x"},
            "expected_output_schema": {"answer": "string"},
            "completion_criteria": ["answer"],
            "assigned_agent_id": "a",
            "dependencies": [],
            "status": "ready",
            "priority": 0,
            "attempts": 0,
            "max_attempts": 2,
            "tool_allowlist": ["cowork_internal"],
        },
        {
            "id": "same_b",
            "title": "Same",
            "description": "same input",
            "input": {"topic": "x"},
            "expected_output_schema": {"answer": "string"},
            "completion_criteria": ["answer"],
            "assigned_agent_id": "b",
            "dependencies": [],
            "status": "ready",
            "priority": 0,
            "attempts": 0,
            "max_attempts": 2,
            "tool_allowlist": ["cowork_internal"],
        },
    ]
    for agent_id in session.agents:
        service.mark_messages_read(session, agent_id)

    selected = service.select_active_agents(session, limit=2)

    assert [agent.id for agent in selected] == ["a"]
    assert session.swarm_plan["work_units"][0]["status"] == "in_progress"
    assert session.swarm_plan["work_units"][1]["status"] == "ready"
    assert any(event.type == "swarm.duplicate_activation_skipped" for event in session.events)


def test_swarm_reducer_is_scheduled_before_completion(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Reduce work",
        "Reduce",
        [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]},
            {"id": "worker", "name": "Worker", "role": "Worker", "goal": "Work", "tools": ["cowork_internal"]},
        ],
        [
            {"id": "map_a", "title": "Map A", "description": "A", "assigned_agent_id": "worker"},
            {"id": "map_b", "title": "Map B", "description": "B", "assigned_agent_id": "worker"},
        ],
        workflow_mode="swarm",
    )

    service.complete_task(session, "map_a", '{"answer":"a","confidence":0.8}')
    service.complete_task(session, "map_b", '{"answer":"b","confidence":0.8}')

    reducer_task = next(task for task in session.tasks.values() if task.title == "Reduce swarm results")
    reducer_unit = service.swarm_work_unit_for_task(session, reducer_task.id)
    assert session.status == "active"
    assert session.swarm_plan["status"] == "reducing"
    assert reducer_task.status == "pending"
    assert reducer_unit is not None
    assert reducer_unit["kind"] == "reducer"
    assert any(event.type == "swarm.reducer_scheduled" for event in session.events)


def test_swarm_replanning_adds_follow_up_from_open_question(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Follow up",
        "Follow",
        [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]},
            {"id": "worker", "name": "Worker", "role": "Worker", "goal": "Work", "tools": ["cowork_internal"]},
        ],
        [{"id": "map_a", "title": "Map A", "description": "A", "assigned_agent_id": "worker"}],
        workflow_mode="swarm",
        budgets={"max_work_units": 4},
    )

    service.complete_task(session, "map_a", '{"answer":"a","open_questions":["Check missing source"],"confidence":0.6}')

    followups = [unit for unit in session.swarm_plan["work_units"] if unit.get("kind") == "follow_up"]
    assert len(followups) == 1
    assert followups[0]["source_work_unit_id"] == "map_a"
    assert "Check missing source" in followups[0]["description"]
    assert any(event.type == "swarm.work_unit_added" for event in session.events)

    created_count = len(session.swarm_plan["work_units"])
    service.replan_swarm(session)
    assert len(session.swarm_plan["work_units"]) == created_count
    assert any(event.type == "swarm.replan_duplicate_rejected" for event in session.events)


def test_swarm_replanning_splits_broad_failed_unit(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Split failed",
        "Split",
        [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]},
            {"id": "worker", "name": "Worker", "role": "Worker", "goal": "Work", "tools": ["cowork_internal"]},
        ],
        [
            {
                "id": "broad",
                "title": "Broad unit",
                "description": "This scope is too broad",
                "assigned_agent_id": "worker",
            }
        ],
        workflow_mode="swarm",
        budgets={"max_work_units": 5},
    )

    service.fail_work_unit(session, "broad", "scope too large")

    revisions = [unit for unit in session.swarm_plan["work_units"] if unit.get("kind") == "revision"]
    assert [unit["replan_reason"] for unit in revisions] == ["split_failed_or_broad_unit", "split_failed_or_broad_unit"]
    assert revisions[1]["dependencies"] == [revisions[0]["source_task_id"]]


def test_swarm_replanning_stops_at_autonomy_boundary(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Boundary",
        "Boundary",
        [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]}],
        [],
        workflow_mode="swarm",
        blueprint={"policy": {"allowed_tools": ["cowork_internal"], "allow_exec": False}},
    )

    added = service.add_swarm_work_unit(
        session,
        title="Run command",
        description="Needs a command",
        assigned_agent_id="lead",
        tool_allowlist=["exec"],
        source_work_unit_id=session.swarm_plan["work_units"][0]["id"],
        reason="needs_exec",
    )

    assert added is None
    assert session.swarm_plan["status"] == "blocked"
    assert session.stop_reason == "autonomy_boundary"
    assert any(event.type == "scheduler.stop" for event in session.events)


def test_swarm_reducer_updates_final_draft_and_schedules_reviewer(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Review reducer",
        "Review reducer",
        [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]},
            {"id": "reviewer", "name": "Reviewer", "role": "Reviewer", "goal": "Review", "tools": ["cowork_internal"]},
            {"id": "worker", "name": "Worker", "role": "Worker", "goal": "Work", "tools": ["cowork_internal"]},
        ],
        [{"id": "map_a", "title": "Map A", "description": "A", "assigned_agent_id": "worker"}],
        workflow_mode="swarm",
    )
    session.swarm_plan["reviewer_agent_id"] = "reviewer"
    session.swarm_plan["review"] = {"required": True, "agent_id": "reviewer"}
    service.complete_task(session, "map_a", '{"answer":"a","confidence":0.8}')
    reducer_task = next(task for task in session.tasks.values() if task.title == "Reduce swarm results")

    service.complete_task(
        session,
        reducer_task.id,
        '{"answer":"final answer","findings":["f"],"confidence":0.9,"source_work_unit_ids":["map_a"]}',
    )

    reviewer_task = next(task for task in session.tasks.values() if task.title == "Review swarm synthesis")
    assert session.final_draft == "final answer"
    assert session.swarm_plan["status"] == "reviewing"
    assert reviewer_task.assigned_agent_id == "reviewer"
    assert reviewer_task.dependencies == [reducer_task.id]
    assert any(event.type == "swarm.reviewer_scheduled" for event in session.events)


def test_swarm_reviewer_needs_revision_creates_revision_unit(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Needs revision",
        "Needs revision",
        [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]},
            {"id": "reviewer", "name": "Reviewer", "role": "Reviewer", "goal": "Review", "tools": ["cowork_internal"]},
            {"id": "worker", "name": "Worker", "role": "Worker", "goal": "Work", "tools": ["cowork_internal"]},
        ],
        [{"id": "map_a", "title": "Map A", "description": "A", "assigned_agent_id": "worker"}],
        workflow_mode="swarm",
        budgets={"max_work_units": 10},
    )
    session.swarm_plan["reviewer_agent_id"] = "reviewer"
    session.swarm_plan["review"] = {"required": True, "agent_id": "reviewer"}
    service.complete_task(session, "map_a", '{"answer":"a","confidence":0.8}')
    reducer_task = next(task for task in session.tasks.values() if task.title == "Reduce swarm results")
    service.complete_task(session, reducer_task.id, '{"answer":"draft","confidence":0.9}')
    reviewer_task = next(task for task in session.tasks.values() if task.title == "Review swarm synthesis")

    service.complete_task(
        session,
        reviewer_task.id,
        '{"verdict":"needs_revision","required_fixes":["Add missing evidence"],"confidence":0.7}',
    )

    revisions = [
        unit for unit in session.swarm_plan["work_units"] if unit.get("replan_reason") == "reviewer_needs_revision"
    ]
    assert session.swarm_plan["status"] == "active"
    assert len(revisions) == 1
    assert "Add missing evidence" in revisions[0]["description"]


def test_swarm_reviewer_blocks_completion(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Blocked review",
        "Blocked review",
        [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]},
            {"id": "reviewer", "name": "Reviewer", "role": "Reviewer", "goal": "Review", "tools": ["cowork_internal"]},
            {"id": "worker", "name": "Worker", "role": "Worker", "goal": "Work", "tools": ["cowork_internal"]},
        ],
        [{"id": "map_a", "title": "Map A", "description": "A", "assigned_agent_id": "worker"}],
        workflow_mode="swarm",
    )
    session.swarm_plan["reviewer_agent_id"] = "reviewer"
    session.swarm_plan["review"] = {"required": True, "agent_id": "reviewer"}
    service.complete_task(session, "map_a", '{"answer":"a","confidence":0.8}')
    reducer_task = next(task for task in session.tasks.values() if task.title == "Reduce swarm results")
    service.complete_task(session, reducer_task.id, '{"answer":"draft","confidence":0.9}')
    reviewer_task = next(task for task in session.tasks.values() if task.title == "Review swarm synthesis")

    service.complete_task(session, reviewer_task.id, '{"verdict":"blocked","issues":["Unsafe"],"confidence":0.5}')

    assert session.swarm_plan["status"] == "blocked"
    assert session.stop_reason == "review_blocked"
    assert session.status == "active"


def test_swarm_evaluations_pass_when_reducer_cites_sources(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Evaluate",
        "Evaluate",
        [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]},
            {"id": "worker", "name": "Worker", "role": "Worker", "goal": "Work", "tools": ["cowork_internal"]},
        ],
        [{"id": "map_a", "title": "Map A", "description": "A", "assigned_agent_id": "worker"}],
        workflow_mode="swarm",
    )
    service.complete_task(session, "map_a", '{"answer":"a","confidence":0.8}')
    reducer_task = next(task for task in session.tasks.values() if task.title == "Reduce swarm results")
    service.complete_task(
        session, reducer_task.id, '{"answer":"final","confidence":0.9,"source_work_unit_ids":["map_a"]}'
    )

    evaluations = session.runtime_state["swarm_evaluations"]
    assert {item["kind"] for item in evaluations} >= {"goal_coverage", "evidence_coverage", "budget_state"}
    assert all(item["status"] != "block" for item in evaluations)


def test_swarm_evaluation_blocks_missing_artifact(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Implement code artifact",
        "Artifact",
        [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]},
            {"id": "worker", "name": "Worker", "role": "Worker", "goal": "Work", "tools": ["cowork_internal"]},
        ],
        [{"id": "map_a", "title": "Map A", "description": "A", "assigned_agent_id": "worker"}],
        workflow_mode="swarm",
    )
    service.complete_task(session, "map_a", '{"answer":"a","confidence":0.8}')
    reducer_task = next(task for task in session.tasks.values() if task.title == "Reduce swarm results")
    service.complete_task(
        session, reducer_task.id, '{"answer":"final","confidence":0.9,"source_work_unit_ids":["map_a"]}'
    )

    artifact_eval = next(
        item for item in session.runtime_state["swarm_evaluations"] if item["kind"] == "artifact_validation"
    )
    assert artifact_eval["status"] == "block"
    assert session.completion_decision["next_action"] == "resolve_evaluation_blockers"


def test_swarm_reducer_stores_source_links_and_workstream_confidence(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Synthesize source-linked reports",
        "Source links",
        [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]}],
        [
            {
                "id": "market_a",
                "title": "Market",
                "description": "Market",
                "assigned_agent_id": "lead",
                "fanout_group_id": "market",
            },
            {
                "id": "risk_a",
                "title": "Risk",
                "description": "Risk",
                "assigned_agent_id": "lead",
                "fanout_group_id": "risk",
            },
        ],
        workflow_mode="swarm",
    )
    service.complete_task(session, "market_a", '{"answer":"m","artifacts":["market.md"],"confidence":0.8}')
    service.complete_task(session, "risk_a", '{"answer":"r","artifacts":["risk.md"],"confidence":0.8}')
    reducer_task = next(task for task in session.tasks.values() if task.title == "Reduce swarm results")

    service.complete_task(
        session,
        reducer_task.id,
        '{"answer":"final","findings":[{"summary":"Market works","source_work_unit_ids":["market_a"]}],'
        '"confidence":0.9,"source_work_unit_ids":["market_a","risk_a"],'
        '"source_artifact_refs":["market.md","risk.md"],"confidence_by_section":{"market":0.8,"risk":0.7}}',
    )

    reducer_unit = service.swarm_work_unit_for_task(session, reducer_task.id)
    assert reducer_task.result_data["source_artifact_refs"] == ["market.md", "risk.md"]
    assert reducer_task.result_data["coverage_by_workstream"] == {"market": 1.0, "risk": 1.0}
    assert reducer_unit["source_artifact_refs"] == ["market.md", "risk.md"]
    assert reducer_unit["confidence_by_section"]["market"] == 0.8


def test_swarm_reviewer_required_follow_up_units_keep_source_links(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Needs sourced follow-up",
        "Reviewer follow-up",
        [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]},
            {"id": "reviewer", "name": "Reviewer", "role": "Reviewer", "goal": "Review", "tools": ["cowork_internal"]},
        ],
        [{"id": "map_a", "title": "Map A", "description": "A", "assigned_agent_id": "lead"}],
        workflow_mode="swarm",
        budgets={"max_work_units": 8},
    )
    session.swarm_plan["reviewer_agent_id"] = "reviewer"
    session.swarm_plan["review"] = {"required": True, "agent_id": "reviewer"}
    service.complete_task(session, "map_a", '{"answer":"a","confidence":0.8}')
    reducer_task = next(task for task in session.tasks.values() if task.title == "Reduce swarm results")
    service.complete_task(
        session, reducer_task.id, '{"answer":"draft","confidence":0.9,"source_work_unit_ids":["map_a"]}'
    )
    reviewer_task = next(task for task in session.tasks.values() if task.title == "Review swarm synthesis")

    service.complete_task(
        session,
        reviewer_task.id,
        '{"verdict":"needs_revision","coverage_issues":[{"workstream":"default"}],'
        '"uncited_claims":[{"summary":"claim"}],"artifact_issues":["missing report"],'
        '"required_follow_up_units":[{"title":"Verify claim","description":"Verify the uncited claim",'
        '"source_work_unit_ids":["map_a"],"source_artifact_refs":["report.md"]}],"confidence":0.6}',
    )

    revisions = [
        unit for unit in session.swarm_plan["work_units"] if unit.get("replan_reason") == "reviewer_required_follow_up"
    ]
    assert reviewer_task.result_data["coverage_issues"][0]["workstream"] == "default"
    assert reviewer_task.result_data["uncited_claims"][0]["summary"] == "claim"
    assert len(revisions) == 1
    assert revisions[0]["source_work_unit_id"] == "map_a"
    assert revisions[0]["input"]["source_artifact_refs"] == ["report.md"]


def test_swarm_evaluators_warn_on_uncited_claims_missing_streams_and_artifacts(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Review source artifacts",
        "Evaluator warnings",
        [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]}],
        [
            {
                "id": "market_a",
                "title": "Market",
                "description": "Market",
                "assigned_agent_id": "lead",
                "fanout_group_id": "market",
            },
            {
                "id": "risk_a",
                "title": "Risk",
                "description": "Risk",
                "assigned_agent_id": "lead",
                "fanout_group_id": "risk",
            },
        ],
        workflow_mode="swarm",
    )
    service.complete_task(session, "market_a", '{"answer":"m","artifacts":["market.md"],"confidence":0.8}')
    service.complete_task(session, "risk_a", '{"answer":"r","artifacts":["risk.md"],"confidence":0.8}')
    reducer_task = next(task for task in session.tasks.values() if task.title == "Reduce swarm results")
    service.complete_task(
        session,
        reducer_task.id,
        '{"answer":"final","findings":["Important claim"],"confidence":0.9}',
    )

    evaluations = {item["kind"]: item for item in session.runtime_state["swarm_evaluations"]}
    assert evaluations["uncited_claims"]["status"] == "warn"
    assert evaluations["workstream_coverage"]["status"] == "warn"
    assert evaluations["artifact_validation"]["status"] == "warn"
    assert {item["workstream"] for item in evaluations["workstream_coverage"]["issues"]} == {"market", "risk"}


def test_source_linked_swarm_scenario_fixtures(temp_workspace):
    service = CoworkService(temp_workspace)

    expert = create_expert_panel_fixture(service)
    research = create_research_matrix_fixture(service)
    code_review = create_code_review_swarm_fixture(service)
    budget = create_budget_exhaustion_fixture(service)
    large = create_large_swarm_fixture(service)

    assert (
        len([unit for unit in expert.swarm_plan["work_units"] if unit.get("kind") not in {"reducer", "reviewer"}]) >= 6
    )
    assert expert.swarm_plan["orchestration"]["recommended_mode"] in {"small_swarm", "large_swarm"}
    assert (
        len([unit for unit in research.swarm_plan["work_units"] if unit.get("kind") not in {"reducer", "reviewer"}])
        == 24
    )
    assert build_swarm_parallel_metrics(research)["fanout_utilization"] > 0
    assert {unit["fanout_group_id"] for unit in code_review.swarm_plan["work_units"]} >= {"backend", "frontend"}
    assert budget.stop_reason == "work_unit_budget_exhausted"
    assert large.swarm_plan["orchestration"]["recommended_mode"] == "large_swarm"


def test_large_swarm_fixture_projection_supports_clustered_ui_behavior(temp_workspace):
    service = CoworkService(temp_workspace)
    session = create_large_swarm_fixture(service, count=120)

    organization = build_cowork_swarm_organization(session)
    snapshot = cowork_session_snapshot(session)

    assert organization["enabled"] is True
    assert organization["total_work_units"] == 120
    assert organization["grouped_counts"]["workstreams"] == 8
    assert len(organization["workstreams"]) == 8
    assert snapshot["large_swarm_summary"]["enabled"] is True
    assert snapshot["large_swarm_summary"]["render_limit"] == 60


def test_phase3_event_log_snapshot_and_replay_load(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Replayable swarm",
        "Replay",
        [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]}],
        [{"id": "unit_a", "title": "Unit A", "description": "A", "assigned_agent_id": "lead"}],
        workflow_mode="swarm",
    )
    service.add_event(session, "test.event", "extra event")
    event_log = temp_workspace / "cowork" / "events" / f"{session.id}.jsonl"
    snapshot = temp_workspace / "cowork" / "snapshots" / f"{session.id}.json"
    artifact_index = temp_workspace / "cowork" / "artifacts" / session.id / "index.json"

    assert event_log.exists()
    assert snapshot.exists()
    assert artifact_index.exists()

    (temp_workspace / "cowork" / "store.json").unlink()
    reloaded = CoworkService(temp_workspace)
    loaded = reloaded.get_session(session.id)

    assert loaded is not None
    assert loaded.workflow_mode == "swarm"
    assert any(event.type == "test.event" for event in loaded.events)


def test_phase3_interrupted_trace_recovery_from_snapshot(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Interrupted", "Interrupted", [], [], workflow_mode="swarm")
    span = service.start_trace_span(session, kind="agent", name="Running worker", actor_id=next(iter(session.agents)))
    service._save()
    (temp_workspace / "cowork" / "store.json").unlink()

    loaded = CoworkService(temp_workspace).get_session(session.id)

    assert loaded is not None
    recovered = next(item for item in loaded.trace_spans if item.id == span.id)
    assert recovered.status == "failed"
    assert recovered.error == "Interrupted before the process stopped."


def test_phase3_swarm_scheduler_queue_projection(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Queue swarm",
        "Queues",
        [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]}],
        [
            {"id": "unit_a", "title": "A", "description": "A", "assigned_agent_id": "lead"},
            {"id": "unit_b", "title": "B", "description": "B", "assigned_agent_id": "lead", "dependencies": ["unit_a"]},
        ],
        workflow_mode="swarm",
        budgets={"parallel_width": 3},
    )

    queues = build_swarm_scheduler_queues(session)

    assert queues["schema_version"] == "cowork.swarm_queues.v1"
    assert queues["parallel_width"] == 3
    assert [item["id"] for item in queues["queues"]["ready"]] == ["unit_a"]
    assert [item["id"] for item in queues["queues"]["blocked"]] == ["unit_b"]
    assert queues["queues"]["blocked"][0]["blocked_by"] == ["unit_a"]

import pytest

from tinybot.agent.tools.cowork import CoworkTool
from tinybot.cowork.service import CoworkService
from tinybot.cowork.swarm import normalize_swarm_plan, validate_swarm_plan
from tinybot.providers.base import LLMResponse, ToolCallRequest


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

    unit = session.swarm_plan["work_units"][0]
    assert "started" in started
    assert "failed" in failed
    assert "queued for retry" in retried
    assert "skipped" in skipped
    assert unit["status"] == "skipped"
    assert any(span.name == "Work unit started" for span in session.trace_spans)
    assert any(span.name == "Work unit failed" for span in session.trace_spans)
    assert any(span.name == "Work unit retried" for span in session.trace_spans)
    assert any(span.name == "Work unit skipped" for span in session.trace_spans)


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

import json

from tinybot.cowork.blueprint import preview_blueprint, validate_blueprint
from tinybot.cowork.service import CoworkService


def test_minimal_blueprint_preview_does_not_persist_session(temp_workspace):
    service = CoworkService(temp_workspace)

    preview = service.preview_blueprint({"goal": "Plan launch"})

    assert preview["ok"] is True
    assert preview["blueprint"]["agents"]
    assert preview["blueprint"]["tasks"]
    assert preview["graph_preview"]["schema_version"] == "cowork.graph.preview.v1"
    assert preview["initial_ready_work"]["ready_task_ids"]
    assert service.list_sessions(include_completed=True) == []


def test_blueprint_validation_reports_duplicate_missing_cycle_and_policy_errors():
    blueprint = {
        "goal": "Validate",
        "agents": [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]},
            {"id": "lead", "name": "Dupe", "role": "Dupe", "goal": "Dupe", "tools": ["shell"]},
        ],
        "tasks": [
            {"id": "a", "title": "A", "description": "A", "dependencies": ["b"], "assigned_agent_id": "missing"},
            {"id": "b", "title": "B", "description": "B", "dependencies": ["a"]},
        ],
        "routes": [{"from": "lead", "to": "missing"}],
    }

    result = validate_blueprint(blueprint)
    codes = {item["code"] for item in result["diagnostics"]}

    assert result["ok"] is False
    assert {
        "duplicate_id",
        "tool_disallowed",
        "missing_task_owner",
        "missing_route_target",
        "task_dependency_cycle",
    } <= codes


def test_blueprint_compile_export_and_recreate_round_trip(temp_workspace):
    service = CoworkService(temp_workspace)
    blueprint = {
        "goal": "Ship docs",
        "workflow_mode": "swarm",
        "agents": [
            {"id": "lead", "name": "Lead", "role": "Coordinator", "goal": "Coordinate", "tools": ["cowork_internal"]},
            {
                "id": "writer",
                "name": "Writer",
                "role": "Writer",
                "goal": "Write",
                "tools": ["read_file", "cowork_internal"],
            },
        ],
        "tasks": [
            {"id": "draft", "title": "Draft", "description": "Draft docs", "assigned_agent_id": "writer"},
            {
                "id": "review",
                "title": "Review",
                "description": "Review docs",
                "assigned_agent_id": "lead",
                "dependencies": ["draft"],
                "review_required": True,
                "reviewer_agent_ids": ["lead"],
            },
        ],
        "routes": [{"id": "handoff", "from": "lead", "to": "writer", "kind": "handoff", "topic": "docs"}],
        "budgets": {"parallel_width": 4, "max_agent_calls": 12, "max_spawned_agents": 2},
        "layout": {"nodes": {"lead": {"x": 100, "y": 120}}},
    }

    session, diagnostics = service.create_session_from_blueprint(blueprint)

    assert session is not None
    assert diagnostics == []
    assert session.workflow_mode == "swarm"
    assert session.budget_limits["parallel_width"] == 4
    assert session.blueprint["routes"][0]["id"] == "handoff"
    exported = service.export_blueprint(session)
    assert exported["agents"][0]["id"] == "lead"
    assert exported["tasks"][0]["id"] == "draft"

    recreated, recreated_diagnostics = service.create_session_from_blueprint(json.loads(json.dumps(exported)))
    assert recreated is not None
    assert recreated_diagnostics == []
    assert set(recreated.agents) == {"lead", "writer"}


def test_blueprint_preview_graph_maps_source_ids():
    preview = preview_blueprint(
        {
            "goal": "Map graph",
            "agents": [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead"}],
            "tasks": [{"id": "task1", "title": "Task", "description": "Do it", "assigned_agent_id": "lead"}],
        }
    )

    graph = preview["graph_preview"]
    assert any(node["id"] == "agent:lead" and node["source_blueprint_id"] == "lead" for node in graph["nodes"])
    assert any(edge["kind"] == "assigned_to" for edge in graph["edges"])

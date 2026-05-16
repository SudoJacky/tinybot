"""Scenario fixtures for practical Cowork swarm validation."""

from __future__ import annotations

from tinybot.cowork.service import CoworkService
from tinybot.cowork.types import CoworkSession


def create_expert_panel_fixture(service: CoworkService) -> CoworkSession:
    specialists = [
        ("market", "Market expert"),
        ("security", "Security expert"),
        ("customer", "Customer expert"),
        ("gtm", "GTM expert"),
        ("finance", "Finance expert"),
        ("engineering", "Engineering expert"),
    ]
    agents = [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Synthesize", "tools": ["cowork_internal"]}]
    agents.extend(
        {"id": agent_id, "name": role.split()[0], "role": role, "goal": role, "tools": ["cowork_internal"]}
        for agent_id, role in specialists
    )
    tasks = [
        {
            "id": f"{agent_id}_review",
            "title": f"{role} review",
            "description": f"Review the strategy from the {role.lower()} perspective.",
            "assigned_agent_id": agent_id,
            "fanout_group_id": agent_id,
            "expected_output": "Perspective, evidence, risks, prioritized actions, confidence.",
        }
        for agent_id, role in specialists
    ]
    return service.create_session(
        "Run an expert panel product strategy review with six specialists",
        "Expert panel fixture",
        agents,
        tasks,
        workflow_mode="swarm",
        budgets={"parallel_width": 4, "max_work_units": 20, "max_spawned_agents": 6},
    )


def create_research_matrix_fixture(service: CoworkService, count: int = 24) -> CoworkSession:
    agents = [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Coordinate", "tools": ["cowork_internal"]}]
    agents.extend(
        {
            "id": f"researcher_{index}",
            "name": f"R{index}",
            "role": "Research specialist",
            "goal": "Research target",
            "tools": ["cowork_internal"],
        }
        for index in range(1, 5)
    )
    tasks = [
        {
            "id": f"target_{index:02d}",
            "title": f"Research target {index:02d}",
            "description": f"Research independent target {index:02d}.",
            "assigned_agent_id": f"researcher_{((index - 1) % 4) + 1}",
            "fanout_group_id": f"segment_{((index - 1) // 6) + 1}",
            "input": {"target_id": index},
        }
        for index in range(1, count + 1)
    ]
    return service.create_session(
        "Build a research matrix across many independent targets",
        "Research matrix fixture",
        agents,
        tasks,
        workflow_mode="swarm",
        budgets={"parallel_width": 6, "max_work_units": count + 8},
    )


def create_code_review_swarm_fixture(service: CoworkService) -> CoworkSession:
    files = [
        "tinybot/cowork/service.py",
        "tinybot/cowork/swarm.py",
        "tinybot/api/cowork.py",
        "webui/assets/src/legacy/app.js",
    ]
    agents = [
        {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Synthesize code review", "tools": ["cowork_internal"]},
        {
            "id": "backend",
            "name": "Backend",
            "role": "Backend reviewer",
            "goal": "Review Python",
            "tools": ["cowork_internal"],
        },
        {
            "id": "frontend",
            "name": "Frontend",
            "role": "Frontend reviewer",
            "goal": "Review WebUI",
            "tools": ["cowork_internal"],
        },
    ]
    tasks = [
        {
            "id": f"review_{index}",
            "title": f"Review {path}",
            "description": f"Review changed file {path} for regressions and missing tests.",
            "assigned_agent_id": "frontend" if path.startswith("webui/") else "backend",
            "fanout_group_id": "frontend" if path.startswith("webui/") else "backend",
            "input": {"file": path},
        }
        for index, path in enumerate(files, start=1)
    ]
    return service.create_session(
        "Run a code-review swarm across changed files",
        "Code review fixture",
        agents,
        tasks,
        workflow_mode="swarm",
        budgets={"parallel_width": 3, "max_work_units": 16},
    )


def create_budget_exhaustion_fixture(service: CoworkService) -> CoworkSession:
    session = service.create_session(
        "Explain budget exhaustion",
        "Budget fixture",
        [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]}],
        [{"id": "unit_a", "title": "A", "description": "A", "assigned_agent_id": "lead"}],
        workflow_mode="swarm",
        budgets={"max_work_units": 1, "parallel_width": 1, "max_spawned_agents": 0},
    )
    service.add_swarm_work_unit(
        session,
        title="Overflow",
        description="This unit should exceed the budget.",
        assigned_agent_id="lead",
        source_work_unit_id="unit_a",
        reason="budget_fixture",
    )
    return session


def create_large_swarm_fixture(service: CoworkService, count: int = 120) -> CoworkSession:
    agents = [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Coordinate", "tools": ["cowork_internal"]}]
    agents.extend(
        {
            "id": f"worker_{index}",
            "name": f"W{index}",
            "role": "Worker",
            "goal": "Complete units",
            "tools": ["cowork_internal"],
        }
        for index in range(1, 9)
    )
    tasks = [
        {
            "id": f"unit_{index:03d}",
            "title": f"Large unit {index:03d}",
            "description": f"Validate large swarm item {index:03d}.",
            "assigned_agent_id": f"worker_{((index - 1) % 8) + 1}",
            "fanout_group_id": f"stream_{((index - 1) // 15) + 1}",
            "input": {"row": index},
        }
        for index in range(1, count + 1)
    ]
    return service.create_session(
        "Validate a large swarm with more than one hundred work units",
        "Large swarm fixture",
        agents,
        tasks,
        workflow_mode="swarm",
        budgets={"parallel_width": 8, "max_work_units": count + 12, "max_spawned_agents": 8},
    )

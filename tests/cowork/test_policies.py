from tinybot.cowork.policies import default_policy_registry
from tinybot.cowork.policies.adaptive_starter import AdaptiveStarterPolicy
from tinybot.cowork.service import CoworkService


def test_default_policy_registry_resolves_supported_architectures():
    registry = default_policy_registry()

    assert isinstance(registry.resolve("adaptive_starter"), AdaptiveStarterPolicy)
    assert isinstance(registry.resolve("hybrid"), AdaptiveStarterPolicy)
    assert registry.resolve("missing").architecture == "adaptive_starter"
    assert registry.resolve("generator_verifier").runtime_profile == "generator_verifier"
    assert registry.resolve("team").display_name == "Agent Team"
    assert registry.resolve("message_bus").runtime_profile == "message_bus"
    assert registry.resolve("shared_state").runtime_profile == "shared_state"
    assert registry.resolve("swarm").runtime_profile == "swarm"


def test_policy_capability_hooks_delegate_during_migration():
    policy = default_policy_registry().resolve("swarm")

    assert policy.topology(None).status == "available"
    assert policy.initialize_branch(None).status == "delegated"
    assert policy.select_step(None).status == "delegated"
    assert policy.route_envelope(None, None).status == "delegated"
    assert policy.handle_delegation(None, {}).status == "delegated"
    assert policy.evaluate_completion(None).status == "delegated"
    assert policy.build_projection(None).status == "available"


def test_adaptive_starter_topology_shape(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Clarify goal", "Clarify", [], [])
    topology = service.architecture_policy(session.workflow_mode).topology(session).payload

    assert topology["schema_version"] == "cowork.architecture_topology.v1"
    assert topology["architecture"] == "adaptive_starter"
    assert topology["branch_id"] == "default"
    assert topology["roles"]
    assert topology["relationships"]
    assert topology["loops"][0]["kind"] == "starter_loop"


def test_swarm_topology_projects_plan_and_queues(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Fan out",
        "Swarm",
        [
            {"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead", "tools": ["cowork_internal"]},
            {"id": "worker", "name": "Worker", "role": "Worker", "goal": "Work", "tools": ["cowork_internal"]},
        ],
        [{"id": "unit_a", "title": "Unit A", "description": "A", "assigned_agent_id": "worker"}],
        workflow_mode="swarm",
    )
    topology = service.architecture_policy("swarm").topology(session).payload
    projection = service.architecture_policy("swarm").build_projection(session).payload

    assert topology["architecture"] == "swarm"
    assert topology["metadata"]["work_unit_count"] == 1
    assert topology["metadata"]["queue_counts"]
    assert any(item["kind"] == "owns_work_unit" for item in topology["relationships"])
    assert projection["sections"][0]["id"] == "swarm_plan"

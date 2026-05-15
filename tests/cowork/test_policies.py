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
    assert policy.handle_delegation(None, {}).status == "allowed"
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


def test_message_bus_policy_routes_and_projects_envelopes(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Route incidents",
        "Bus",
        [
            {"id": "coordinator", "name": "Coordinator", "role": "Lead", "goal": "Lead", "subscriptions": []},
            {"id": "analyst", "name": "Analyst", "role": "Analysis", "goal": "Analyze", "subscriptions": ["incident"]},
            {
                "id": "researcher",
                "name": "Researcher",
                "role": "Research",
                "goal": "Research",
                "subscriptions": ["research"],
            },
        ],
        [],
        workflow_mode="message_bus",
    )
    from tinybot.cowork.mailbox import CoworkEnvelope, CoworkMailbox

    CoworkMailbox(service).deliver(
        session,
        CoworkEnvelope(
            sender_id="user", visibility="group", topic="incident", event_type="alert", content="Investigate"
        ),
    )

    policy = service.architecture_policy("message_bus")
    decision = policy.route_envelope(
        session,
        CoworkEnvelope(sender_id="user", visibility="group", topic="incident", content="Follow up"),
    )
    projection = policy.build_projection(session).payload

    assert decision.payload["recipients"] == ["analyst"]
    assert decision.payload["route_type"] == "topic_route"
    assert projection["sections"][0]["id"] == "subscribers"
    assert projection["sections"][1]["items"][0]["route_type"] == "topic_route"
    assert projection["metadata"]["topic_count"] == 1


def test_shared_state_policy_projects_contributions_and_blocks_competing_claims(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Resolve claims", "Shared", [], [], workflow_mode="shared_state")
    session.shared_memory["claims"] = [
        {"text": "API is ready", "author": "coordinator"},
        {"text": "API is not ready", "author": "memory_curator"},
    ]

    policy = service.architecture_policy("shared_state")
    decision = policy.evaluate_completion(session)
    projection = policy.build_projection(session).payload

    assert decision.status == "blocked"
    assert decision.payload["next_action"] == "resolve_competing_claims"
    assert projection["sections"][0]["id"] == "shared_knowledge_space"
    assert projection["sections"][1]["items"]


def test_generator_verifier_policy_exposes_rubric_candidates_and_verdicts(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Write and verify",
        "GV",
        [],
        [
            {"id": "draft", "title": "Draft", "description": "Draft", "assigned_agent_id": "producer"},
            {
                "id": "verify",
                "title": "Verify",
                "description": "Verify",
                "assigned_agent_id": "verifier",
                "dependencies": ["draft"],
            },
        ],
        workflow_mode="generator_verifier",
        blueprint={"rubric": ["correctness", "coverage"], "max_iterations": 2},
    )
    service.complete_task(session, "draft", '{"answer":"candidate","confidence":0.8}')
    service.complete_task(session, "verify", '{"verdict":"pass","issues":[],"confidence":0.9}')

    policy = service.architecture_policy("generator_verifier")
    decision = policy.evaluate_completion(session)
    projection = policy.build_projection(session).payload

    assert decision.status == "complete"
    assert projection["sections"][0]["items"] == [{"criterion": "correctness"}, {"criterion": "coverage"}]
    assert projection["sections"][1]["items"][0]["summary"] == "candidate"
    assert projection["sections"][2]["items"][0]["verdict"] == "pass"


def test_agent_team_policy_projects_coordinator_and_worker_domains(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Coordinate specialists",
        "Team",
        [
            {"id": "coordinator", "name": "Coordinator", "role": "Lead", "goal": "Lead"},
            {
                "id": "researcher",
                "name": "Researcher",
                "role": "Research",
                "goal": "Research",
                "responsibilities": ["Evidence"],
            },
        ],
        [{"id": "research", "title": "Research", "description": "Research", "assigned_agent_id": "researcher"}],
        workflow_mode="team",
    )

    policy = service.architecture_policy("team")
    topology = policy.topology(session).payload
    projection = policy.build_projection(session).payload

    assert topology["metadata"]["coordinator_id"] == "coordinator"
    assert any(item["kind"] == "coordinates_worker_domain" for item in topology["relationships"])
    assert projection["sections"][1]["items"][0]["worker_domain"] == "Evidence"


def test_swarm_policy_selects_steps_and_tracks_synthesis_gate(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session(
        "Fanout then synthesize",
        "Swarm",
        [{"id": "lead", "name": "Lead", "role": "Lead", "goal": "Lead"}],
        [{"id": "unit_a", "title": "A", "description": "A", "assigned_agent_id": "lead"}],
        workflow_mode="swarm",
        budgets={"parallel_width": 1},
    )
    policy = service.architecture_policy("swarm")

    selected = policy.select_step(session).payload["selected_work_units"]
    assert [item["id"] for item in selected] == ["unit_a"]

    service.complete_task(session, "unit_a", '{"answer":"a","confidence":0.8}')
    decision = policy.evaluate_completion(session)
    assert decision.status == "continue"
    assert decision.payload["next_action"] == "run_reducer"


def test_adaptive_starter_policy_recommends_derivation_target(temp_workspace):
    service = CoworkService(temp_workspace)
    session = service.create_session("Review this with a strict rubric", "Starter", [], [])

    policy = service.architecture_policy("adaptive_starter")
    projection = policy.build_projection(session).payload
    decision = policy.evaluate_completion(session)

    assert projection["metadata"]["recommendation"]["architecture"] == "generator_verifier"
    assert decision.payload["can_derive"] is True

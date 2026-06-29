import { describe, expect, it } from "vitest";

import type { AgentMessage } from "../agent/agentRunSpec";
import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider";
import { CoworkTeamPlanner } from "./coworkTeamPlanner";

class QueueProvider implements ModelProvider {
  readonly messages: AgentMessage[][] = [];
  readonly options: ModelRequestOptions[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(messages: AgentMessage[], options: ModelRequestOptions = {}): Promise<ModelResponse> {
    this.messages.push(messages.map((message) => ({ ...message })));
    this.options.push({ ...options });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("no queued model response");
    }
    return response;
  }
}

describe("CoworkTeamPlanner", () => {
  it("plans a compact team from the provider submit_cowork_team tool call", async () => {
    const provider = new QueueProvider([{
      content: "",
      stopReason: "tool_calls",
      toolCalls: [{
        id: "team-1",
        name: "submit_cowork_team",
        argumentsJson: JSON.stringify({
          title: "Migration Review",
          agents: [{
            id: "lead",
            name: "Lead",
            role: "Coordinator",
            goal: "Coordinate TS migration",
            responsibilities: ["Plan work"],
            subscriptions: ["coordination"],
          }],
          tasks: [{
            id: "lead_start",
            title: "Plan migration",
            description: "Decide whether more agents are needed",
            assigned_agent_id: "lead",
          }],
        }),
      }],
    }]);
    const planner = new CoworkTeamPlanner({ provider, model: "test-model", workspace: "D:/code/tinybot/tinybot" });

    const plan = await planner.plan("Migrate cowork planner", "team");

    expect(provider.options[0]).toMatchObject({
      model: "test-model",
      toolChoice: { type: "function", function: { name: "submit_cowork_team" } },
    });
    expect(provider.options[0].tools?.[0]).toMatchObject({ name: "submit_cowork_team" });
    expect(plan).toMatchObject({
      title: "Migration Review",
      agents: [expect.objectContaining({ id: "lead", role: "Coordinator" })],
      tasks: [expect.objectContaining({ id: "lead_start", assigned_agent_id: "lead" })],
    });
  });

  it("falls back to a coordinator, reviewer, and lead-start task when provider planning fails for risky goals", async () => {
    const provider: ModelProvider = {
      async complete() {
        throw new Error("provider unavailable");
      },
    };
    const planner = new CoworkTeamPlanner({ provider, model: "test-model", workspace: "D:/code/tinybot/tinybot" });

    const plan = await planner.plan("Review code, verify tests, and compare risks", "team");

    expect(plan.title).toBe("Cowork Session");
    expect(plan.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "coordinator", role: "Team coordinator" }),
      expect.objectContaining({ id: "reviewer", role: "Quality and risk reviewer" }),
    ]));
    expect(plan.tasks).toEqual([expect.objectContaining({
      id: "lead_start",
      title: "Decide team plan and delegation",
      assigned_agent_id: "coordinator",
      dependencies: [],
    })]);
    expect(plan.tasks[0].description).toContain("Review code, verify tests, and compare risks");
  });
});

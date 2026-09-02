# 0001: Separate Agent Graph definitions, runs, and Threads

Status: Accepted

## Context

Agent Graph is a standalone product surface rather than a Chat mode. A Graph
can contain multiple Agent Loop nodes, and each Agent node may execute in a
different workspace. The canvas therefore needs durable topology and node
configuration, while execution still needs Tinybot's existing Thread lifecycle,
Rollout persistence, cancellation, checkpoints, and diagnostics.

Keeping all of this state in one record would mix three different lifecycles:

- users edit and save a reusable Graph definition;
- one execution creates short-lived orchestration state;
- every Agent Loop invocation creates durable conversation history.

The standalone editor, definition store, and bounded routing runtime implement
these separate lifecycles through explicit interfaces.

## Decision

Tinybot will use three distinct authorities:

| Authority | Owns | Storage |
| --- | --- | --- |
| Graph definition | Name, topology, canvas positions, and node configuration | `<definition-workspace>/.tinybot/graphs/<graph-id>.json` |
| Graph Run | One execution's status and node-invocation mapping | `~/.tinybot/graph-runs/<graph-id>/<run-id>.json` |
| Agent Thread | One Agent Loop invocation and its canonical conversation history | Existing `~/.tinybot/threads/...` Rollout storage |

The Graph runtime coordinates these authorities through Interfaces. It must not
make the renderer, a Chat session, or a synthetic parent Thread an alternate
authority.

### Definition and execution workspaces

The workspace containing the Graph file is its **definition workspace**. The
Input node is a configuration-free runtime boundary, while each Agent node
separately owns an **execution workspace** and role configuration:

```ts
type AgentGraphInputNode = {
  id: string;
  kind: "input";
  position: AgentGraphNodePosition;
};

type AgentLoopNodeConfig = {
  workspacePath: string;
  instructions: string;
  model?: {
    providerId?: string;
    modelId: string;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  };
};

type AgentGraphAgentNode = {
  id: string;
  kind: "agent";
  position: AgentGraphNodePosition;
  config: AgentLoopNodeConfig;
};

type AgentGraphRouterNode = {
  id: string;
  kind: "condition"; // persisted schema name; presented as Router
  position: AgentGraphNodePosition;
  config: {
    task?: string;
    routes: Array<{ id: string; label: string; description: string }>;
    model?: AgentLoopNodeConfig["model"];
  };
};
```

A newly inserted Agent node defaults to the definition workspace. The editor
builds its workspace choices from the application `WorkspaceRegistry`, but it
stores only the selected `workspacePath`; it does not
depend on Chat route state or a Chat session identity.

A missing or moved execution workspace does not make the definition
uneditable. Run preflight canonicalizes and validates every Agent workspace and
reports a node-specific error before starting work. Node instructions are
appended through the existing turn-scoped agent-role instruction source; they
do not replace Tinybot's base, workspace, project, memory, or runtime
instructions. The preceding node's final output remains ordinary Turn input.
Run start requires Graph identity, revision, definition workspace, and a
non-empty runtime input. That input is ordinary Turn input for the first Agent
and belongs to the Run rather than the reusable definition. Legacy `prompt`
configuration on Input nodes is ignored and stripped instead of migrated or
used as a fallback.

The optional model tuple pins a node to a configured provider and model, with
an optional reasoning effort. When it is absent, execution inherits normal
application defaults. Display labels and credentials remain configuration
concerns and are not copied into the Graph. Agent and Router configuration
fields are required by `tinybot.agent_graph.v1`; Input has no configuration.

Router route IDs are stable definition identity; edges reference them through
`sourceRouteId`. User-facing labels and descriptions may change without
rewiring the graph. Generated `ROUTE_A`, `ROUTE_B`, and later tokens exist only
inside one model request and are mapped back to stable IDs by route order.
Every Router has at least two routes and exactly one outgoing edge per route.

### Definition persistence Interface

The renderer-facing store remains small:

```ts
type StoredAgentGraph = {
  definition: AgentGraphDefinition;
  revision: string;
};

type AgentGraphStore = {
  list(workspacePath: string): Promise<StoredAgentGraph[]>;
  save(input: {
    workspacePath: string;
    definition: AgentGraphDefinition;
    expectedRevision?: string;
  }): Promise<StoredAgentGraph>;
  delete(input: {
    workspacePath: string;
    graphId: string;
    expectedRevision: string;
  }): Promise<void>;
};
```

The native Adapter validates the Graph, writes one JSON file per definition by
atomic replacement, and returns a SHA-256 revision of the exact persisted
bytes. Save and delete use the expected revision to surface concurrent edits
instead of silently overwriting them. The revision is not duplicated inside
the JSON document.

The first version uses explicit Save. It has no autosave, database, catalog
index, edit history, cache, or generic repository framework. Scanning the small
`.tinybot/graphs` directory is sufficient for `list`.

### Graph Run and Agent Thread lifecycle

Each execution creates one lightweight Graph Run. Each visited Agent or Router
node creates a distinct node-run entry; nodes on unselected branches create no
entry:

```ts
type AgentGraphRun = {
  id: string;
  graphId: string;
  graphRevision: string;
  definitionWorkspacePath: string;
  status: "running" | "completed" | "failed" | "cancelled";
  input: string;
  nodeRuns: Array<{
    id: string;
    nodeId: string;
    threadId?: string;
    status: "pending" | "running" | "completed" | "failed" | "cancelled";
    router?: {
      rawResponse: string;
      selectedRouteId: string;
      selectedEdgeId: string;
      usage?: unknown;
    };
    error?: string;
  }>;
};
```

Input, Router, and Output nodes execute in the Graph runtime and do not create
Threads. The first visit to an Agent node creates a standard Thread with no
synthetic parent and enough origin metadata to trace it back. Re-entering that
node during the same Run appends another Turn to the existing Thread while
recording a distinct node-run:

```json
{
  "source": "agent_graph",
  "parentThreadId": null,
  "metadata": {
    "workingDirectory": "<agent-node-workspace>",
    "extra": {
      "graphId": "<graph-id>",
      "graphRevision": "sha256:<revision>",
      "graphRunId": "<run-id>",
      "graphNodeId": "<node-id>",
      "nodeRunId": "<node-run-id>"
    }
  }
}
```

The Agent Thread follows the normal Agent Loop and Rollout path. Its terminal
state updates the corresponding node run; the Graph runtime then chooses the
next edge or terminates the Graph Run. Failures remain visible on the node run
and Graph Run rather than being converted into successful empty output.

A Router is not an Agent Loop. It makes exactly one non-streaming request to
the configured or inherited provider/model with a dedicated routing system
prompt, the current graph value as user data, and no tools. It does not load
Tinybot Agent instructions, workspace instructions, skills, memory, or create
a Thread. The optional user routing task augments required route descriptions.
The complete response is trimmed and must exactly equal one generated route
token. Prose, code fences, unknown tokens, and ambiguous output fail the node;
the runtime does not search substrings, guess a default, or retry.

Runtime preflight accepts Router branches that reconverge or form controlled
loops. Every cyclic strongly connected component must contain a Router with a
route that exits the component; non-Router cycles and loops without an exit are
rejected. Every node must be reachable from Input and able to reach Output.
Input and Agent nodes have one outgoing edge, and each Router route has one
outgoing edge. A Run may execute at most 64 Agent or Router node-runs, after
which it fails explicitly rather than allowing a model-selected route to loop
forever.

The Graph revision identifies the definition loaded at run start and detects
later divergence. The first version does not retain historical definition
snapshots, so an old revision is traceable but not necessarily reconstructable
after the definition is edited. The Run copies the runtime input so node
inspection still shows the exact task used for that execution.

### Chat tool exposure

A Chat Turn may select saved Graphs as tools only when the Thread or Turn
declares a working directory. The runtime lists Graph definitions from exactly
that canonical directory; the global backend-workspace fallback does not imply
Graph scope. Graphs from other workspaces and Graphs for a workspace-less
Thread are absent. Each registry entry is Deferred and binds the
definition workspace, Graph ID, and exact revision. Its model-visible input
schema contains only one required `input` string, so the model cannot substitute
another workspace, Graph, or revision.

Tool discovery is deliberately tolerant at the file boundary: an invalid saved
Graph is omitted with a path-specific diagnostic while other valid Graphs remain
available. Definition management listing stays strict and reports the invalid
file, preserving visibility of corrupt or obsolete definitions without allowing
one of them to abort an unrelated Chat Turn.

The tool waits for the Graph Run to reach a terminal state. A completed Run's
final output becomes the model-visible content of the normal tool result in the
parent Turn, so subsequent context assembly and token estimation use the
existing tool-history path. Failures remain failed tool results. Parent Turn
cancellation cancels the active Graph node and records the Run as cancelled.
Agent Threads created by a Graph do not receive Agent Graph tools; nested and
recursive Graph execution is outside this decision.

### Conversation isolation

Graph-created Threads share the canonical Thread store so they immediately
reuse existing persistence, replay, compression, checkpoints, cancellation,
and diagnostics. They are logically isolated by `source: "agent_graph"`:

- the Chat session list must exclude them;
- the Graph page discovers execution through Graph Runs, not Chat sessions;
- Thread APIs and diagnostic tools may still read them by explicit ID.

Before Graph execution ships, the current renderer conversation filter must be
updated: it currently admits every parentless Thread. A Graph Thread is
parentless by design and would otherwise leak into Chat.

## Alternatives

### Store Graph Threads under a separate physical root

This gives strong physical separation but duplicates or complicates the
Rollout store, index, replay, compression, recovery, and Thread tooling. Tinybot
will split the physical store only if Graph runs later need materially different
retention, access control, or scale characteristics.

### Represent a Graph Run as a parent Thread

A synthetic parent would reuse Thread hierarchy, but a Graph Run is
orchestration state rather than a conversation. It would distort Thread
semantics and make Chat filtering and lifecycle rules harder to understand.

### Store definitions and runs together

Embedding run state in the workspace definition would create noisy edits,
concurrent-write conflicts, and unclear ownership. Definitions are reusable
workspace content; runs are application execution records.

## Consequences

- A Graph remains portable, readable workspace data and can be reviewed in
  source control.
- Different Agent nodes can safely select different workspaces without
  coupling the Graph page to Chat.
- Existing Agent and Thread implementations remain reusable behind the Graph
  runtime Interface.
- Graph Run cleanup and retention are independent from definition deletion.
- Chat queries must apply an explicit source policy rather than assuming every
  parentless Thread is a conversation.
- Historical runs initially retain identity and Thread evidence, but not a full
  immutable Graph definition snapshot.

## Related documentation

- [System overview](../architecture/system-overview.md)
- [Agent Graph application core](../../src/app-core/agent-graph/README.md)
- [Agent Graph workbench](../../src/react-workbench/agent-graph/README.md)
- [Thread and Rollout persistence](../architecture/thread-rollout-persistence.md)

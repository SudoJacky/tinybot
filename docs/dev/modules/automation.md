# Cron, Heartbeat, and Events

Tinybot has background automation primitives for scheduled jobs, periodic heartbeat decisions, and event queueing. These are infrastructure services, not agent reasoning modules.

## Ownership

| Concern | Module |
| --- | --- |
| Cron data model | `tinybot/cron/types.py` |
| Cron scheduling and execution | `tinybot/cron/service.py` |
| Heartbeat loop | `tinybot/heartbeat/service.py` |
| Message/event bus | `tinybot/bus/` |
| Gateway startup wiring | `tinybot/cli/commands.py` |

## Cron Design

Cron jobs are persisted schedules with payload, state, run records, and next-run timestamps. The service owns schedule validation, next-run computation, timer arming, execution, and run history.

Cron should remain explicit and inspectable. Jobs should have bounded payloads, clear enabled/disabled state, and protected system jobs where removal would break runtime behavior.

## Heartbeat Design

Heartbeat is a periodic service that reads a heartbeat instruction file, asks for a decision, and optionally triggers a follow-up notification or task. It is useful for "keep checking" behavior attached to a running gateway.

Heartbeat should be conservative. If there is no actionable content or the decision is to wait, it should avoid noisy output.

## Event and Message Bus

The bus is an async transport between channel adapters and runtime consumers. It should carry normalized messages, not domain-specific service objects. Queue batching and timeouts belong in the bus, while interpretation belongs to consumers.

## Boundaries

- Cron owns when a job runs, not how the agent reasons about its task.
- Heartbeat owns periodic decision loops, not general scheduling.
- The bus owns transport and buffering, not business policy.
- Gateway startup wires services together but should not become the implementation home for automation logic.

## Extension Checklist

- Add new schedule capabilities in the cron service with validation and next-run tests.
- Keep job payloads serializable and version-tolerant.
- Add status fields before adding UI controls.
- For heartbeat behavior, define when it should stay silent.
- For bus changes, test batching, queue size, and timeout behavior.

## Test Strategy

Use `tests/bus/` for queue behavior. Add service-level tests for cron schedule computation and run-state transitions when changing automation behavior. Heartbeat tests should isolate the decision provider from timer mechanics.

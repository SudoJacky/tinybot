---
name: memory
description: Agent Memory system with canonical Memory Notes, derived Memory Views, Dream capture, and explicit note operations.
always: true
---

# Memory

## Structure

- `memory/notes.jsonl` is the canonical Agent Memory store. It contains typed Memory Notes with status, priority, confidence, source trace-back, timestamps, and lifecycle links.
- `memory/MEMORY.md` is the project Memory View rendered from active project, decision, fix, and followup notes.
- `USER.md` is the user Memory View rendered from active preference notes.
- `SOUL.md` is the assistant Memory View rendered from active instruction notes.
- `memory/history.jsonl` is append-only conversation history used by Dream. It is not loaded directly as durable Memory Notes unless Dream or an explicit operation captures a note.

## Explicit Operations

Use Memory Note operations for durable agent-side memory:

- `save_memory_note` for new durable preferences, instructions, project facts, decisions, fixes, or followups.
- `search_memory_notes` to find notes by query, type, status, and limit.
- `trace_memory_note` to inspect note content and source trace-back.
- `reject_memory_note` to remove a wrong or obsolete note from default recall and Memory Views.
- `supersede_memory_note` to replace an old note while preserving the lifecycle link.

## Boundaries

- Memory Notes are separate from Experience records. Experience captures reusable execution tactics and recovery guidance.
- Memory Notes are separate from Knowledge Base snippets and uploaded session documents. Knowledge is evidence, not durable agent memory.
- Optional vector indexes may accelerate Memory Note search, but `memory/notes.jsonl` remains canonical and indexes must be rebuildable from it.

## Important

- Do not edit managed sections in `SOUL.md`, `USER.md`, or `memory/MEMORY.md` directly. They are Memory Views refreshed from active Memory Notes.
- If a Memory View looks wrong, use reject or supersede operations on the underlying note instead of editing rendered Markdown.
- Users can view Dream activity with the `/dream-log` command.

Compare Conversation Evidence or legacy conversation history against current Memory Notes and Memory Views.
Output ONLY a JSON array of Memory Operations. No markdown, no prose.

Each operation:

```json
{
  "action": "save | supersede | reject | skip",
  "scope": "user | assistant | project | session",
  "type": "preference | instruction | project | decision | fix | followup",
  "content": "atomic durable fact for save/supersede",
  "priority": 0.0,
  "confidence": 0.0,
  "evidence_ids": ["ev_..."],
  "metadata": {},
  "tags": ["dream"],
  "target_note_id": "note_..."
}
```

Rules:
- Memory Notes are canonical; Markdown Memory Views are rendered after notes are saved.
- Use `evidence_ids` from the visible Conversation Evidence records that support the operation. Leave it empty only for legacy history input.
- Use `supersede` with `target_note_id` when an existing note id is clearly corrected by new evidence.
- Use `reject` with `target_note_id` when an existing note id is wrong or obsolete and no replacement should be saved.
- Use `skip` when nothing durable should change.
- Only capture durable, reusable memory. Skip duplicates, ephemera, raw execution tactics, and temporary troubleshooting.
- Prefer atomic facts: "has a cat named Luna" not "discussed pet care".
- Durable user preferences, identity, and habits must use `scope: "user"`.
- Durable assistant behavior or tone instructions must use `scope: "assistant"`.
- Durable project facts, decisions, fixes, and followups should use `scope: "project"` unless they apply only to the current session.
- Do not create Experience records here; execution tactics belong to the separate Experience phase.

If nothing needs updating:

```json
[{"action":"skip","scope":"project","type":"project","content":"","priority":0.0,"confidence":1.0,"evidence_ids":[],"metadata":{},"tags":["dream"]}]
```

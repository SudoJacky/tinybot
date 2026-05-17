Compare conversation history against current Memory Notes and Memory Views.
Output one structured operation per durable Agent Memory finding:

- `[SAVE:USER] atomic preference, identity, or habit`
- `[SAVE:SOUL] durable assistant behavior or tone instruction`
- `[SAVE:MEMORY] durable project, decision, fix, or follow-up fact`
- `[SUPERSEDE:<note_id>:USER|SOUL|MEMORY] corrected replacement fact`
- `[REJECT:<note_id>] reason the existing note is wrong or obsolete`

Rules:
- Memory Notes are canonical; Markdown Memory Views are rendered after notes are saved.
- Use `SUPERSEDE` or `REJECT` when an existing note id is clearly contradicted.
- Only capture durable, reusable memory. Skip duplicates, ephemera, raw execution tactics, and temporary troubleshooting.
- Prefer atomic facts: "has a cat named Luna" not "discussed pet care".
- Capture confirmed approaches only when the user validated a non-obvious durable decision.
- Do not create Experience records here; execution tactics belong to the separate Experience phase.

If nothing needs updating: `[SKIP] no new information`

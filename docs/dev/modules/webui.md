# WebUI

The WebUI is a static frontend served by the gateway. It is intentionally close to the gateway API contract: the frontend renders snapshots and sends explicit control commands rather than reimplementing backend state machines.

## Ownership

| Concern | Files |
| --- | --- |
| HTML shell | `webui/index.html` |
| Legacy application logic | `webui/assets/src/legacy/app.js` |
| Modular JS entry/state/helpers | `webui/assets/src/` |
| Styles | `webui/assets/styles.css`, `webui/assets/styles/` |
| Generated docs output | `webui/docs/` |
| Source docs | `docs/` |
| Docs builder | `scripts/build_docs.py` |

## Design Shape

The WebUI combines chat, settings, knowledge, skills, workspace file editing, and Cowork. State is mostly browser-side view state backed by gateway snapshots. Durable domain state should remain in Python services.

For complex surfaces such as Cowork, the UI should render backend projections: graph, trace, artifact index, scheduler decisions, work queues, and completion decisions. Avoid deriving business state in JavaScript when the backend can expose it explicitly and test it.

## API Coupling

The frontend should depend on stable API fields, not internal Python class names. When a field is added for UI needs, add it to the API snapshot and cover it in API tests.

For Cowork, especially preserve:

- `completion_decision`
- `final_draft`
- `agent_steps`
- `trace_spans`
- `artifact_index`
- `scheduler_decisions`
- `run_metrics`
- branch and branch result summaries

## Documentation Build

`scripts/build_docs.py` builds selected Markdown files from `docs/` into `webui/docs/`. It uses a fixed navigation list and does not currently build nested developer docs under `docs/dev/`.

That separation is intentional for now: `docs/dev/` is maintainer documentation and should not appear in the public WebUI docs unless deliberately exposed later.

## Validation

Run JavaScript syntax checks after frontend edits:

```bash
node --check webui/assets/src/legacy/app.js
```

For layout or interaction changes, also run the gateway and inspect the affected route. API tests are still needed when frontend changes depend on new backend payloads.

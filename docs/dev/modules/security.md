# Security

Security modules provide guardrails for tool execution, network access, secret storage, and audit visibility. The design goal is to make risky actions explicit and reviewable while keeping low-risk local work smooth.

## Ownership

| Concern | Module |
| --- | --- |
| Approval classification and decisions | `tinybot/security/approval.py` |
| Audit logging | `tinybot/security/audit.py` |
| API key encryption | `tinybot/security/crypto.py` |
| Network target validation | `tinybot/security/net.py` |
| Shell/filesystem tools that trigger security checks | `tinybot/agent/tools/shell.py`, `tinybot/agent/tools/filesystem.py` |

## Approval Model

Approval logic classifies tool calls into risk categories and decides whether a call can proceed, needs one-time approval, can be approved for a session, or must be denied.

The approval system should be deterministic. Similar calls should produce stable fingerprints so user decisions can be reused safely within their intended scope.

## Network Guardrails

Network validation protects against unsafe URL targets and redirect chains. The network layer should validate both the original URL and resolved targets where possible. SSRF-sensitive behavior belongs here instead of being reimplemented by each tool.

## Secret Handling

API keys and credentials should prefer environment-variable references. When local encryption is used, encryption/decryption belongs in `security/crypto.py`; callers should not invent their own storage format.

## Audit Design

Audit events should record what happened, why it was allowed, and enough metadata to diagnose a later issue. They should avoid leaking raw secrets or unnecessary content.

Audit logging should be called at action boundaries: command execution, URL access, API-key handling, and approval decisions.

## Boundaries

- Security modules classify and record risk; tools still own their domain execution.
- UI/API layers can display pending approvals but should not duplicate classifier logic.
- Provider code should not bypass approval checks by executing side effects directly.
- Network validation should be centralized so allow-list and redirect behavior stays consistent.

## Extension Checklist

- Add new risky tool categories to approval classification.
- Define fingerprint scope and summary text.
- Add audit events if the action has security relevance.
- Add tests for allow, deny, approval reuse, and unsafe input.
- Keep error messages actionable but do not expose sensitive internals.

## Test Strategy

Use `tests/security/`. Add cases for command normalization, shell control operators, URL/private network detection, redirect handling, encryption round trips, and audit event redaction.

"""Security utilities for Tinybot."""

from tinybot.security.audit import (
    AuditEventType,
    AuditLogger,
    AuditEvent,
    configure_audit,
    get_audit_logger,
    log_command_exec,
    log_url_access,
    log_api_key_event,
)
from tinybot.security.crypto import (
    encrypt_api_key,
    decrypt_api_key,
    is_encrypted_key,
    get_encryptor,
    KeyEncryptor,
)
from tinybot.security.net import (
    validate_url_target,
    validate_resolved_url,
    validate_redirect_chain,
    contains_internal_url,
    configure_ssrf_whitelist,
    configure_redirect_limits,
    clear_dns_cache,
)
from tinybot.security.approval import (
    ApprovalAction,
    ApprovalManager,
    ApprovalRequest,
    ApprovalScope,
    format_approval_required,
)

__all__ = [
    # Audit
    "AuditEventType",
    "AuditLogger",
    "AuditEvent",
    "configure_audit",
    "get_audit_logger",
    "log_command_exec",
    "log_url_access",
    "log_api_key_event",
    # Crypto
    "encrypt_api_key",
    "decrypt_api_key",
    "is_encrypted_key",
    "get_encryptor",
    "KeyEncryptor",
    # Net
    "validate_url_target",
    "validate_resolved_url",
    "validate_redirect_chain",
    "contains_internal_url",
    "configure_ssrf_whitelist",
    "configure_redirect_limits",
    "clear_dns_cache",
    # Approval
    "ApprovalAction",
    "ApprovalManager",
    "ApprovalRequest",
    "ApprovalScope",
    "format_approval_required",
]

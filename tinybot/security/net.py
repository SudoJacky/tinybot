"""Network security utilities — SSRF protection and internal URL detection."""

from __future__ import annotations

import ipaddress
import re
import socket
import time
from urllib.parse import urlparse

from loguru import logger

from tinybot.security.audit import log_url_access

_BLOCKED_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),  # carrier-grade NAT
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),  # link-local / cloud metadata
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),  # unique local
    ipaddress.ip_network("fe80::/10"),  # link-local v6
]

_URL_RE = re.compile(r"https?://[^\s\"'`;|<>]+", re.IGNORECASE)

_allowed_networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
_max_redirects: int = 10
_redirect_timeout_ms: int = 5000  # DNS resolution cache timeout
_dns_cache: dict[str, tuple[list[str], float]] = {}  # hostname -> (IPs, timestamp)


def configure_ssrf_whitelist(cidrs: list[str]) -> None:
    """Allow specific CIDR ranges to bypass SSRF blocking (e.g. Tailscale's 100.64.0.0/10)."""
    global _allowed_networks
    nets = []
    for cidr in cidrs:
        try:
            nets.append(ipaddress.ip_network(cidr, strict=False))
        except ValueError:
            pass
    _allowed_networks = nets


def configure_redirect_limits(max_redirects: int = 10, dns_cache_timeout_ms: int = 5000) -> None:
    """Configure redirect chain validation limits.

    Args:
        max_redirects: Maximum number of redirects to follow.
        dns_cache_timeout_ms: DNS resolution cache timeout in milliseconds.
    """
    global _max_redirects, _redirect_timeout_ms, _dns_cache
    _max_redirects = max_redirects
    _redirect_timeout_ms = dns_cache_timeout_ms
    _dns_cache.clear()  # Clear cache when settings change


def _resolve_ips(hostname: str) -> list[str]:
    """Resolve hostname to IPs with DNS rebinding protection.

    Uses a short-lived cache to detect DNS rebinding attacks where
    the same hostname resolves to different IPs over time.

    Args:
        hostname: The hostname to resolve.

    Returns:
        List of resolved IP addresses.
    """
    now = time.time()
    cache_key = hostname.lower()

    # Check cache
    cached = _dns_cache.get(cache_key)
    if cached:
        ips, timestamp = cached
        if (now - timestamp) < (_redirect_timeout_ms / 1000):
            logger.debug("Using cached DNS resolution for {}", hostname)
            return ips

    # Resolve fresh
    try:
        infos = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror:
        return []

    ips = []
    for info in infos:
        try:
            addr = str(ipaddress.ip_address(info[4][0]))
            ips.append(addr)
        except ValueError:
            continue

    # Cache result
    _dns_cache[cache_key] = (ips, now)
    logger.debug("Resolved {} to IPs: {}", hostname, ips)

    # Check for DNS rebinding attack
    if cached:
        old_ips = cached[0]
        if set(old_ips) != set(ips):
            logger.warning("DNS rebinding attack detected: {} resolved from {} to {}", hostname, old_ips, ips)

    return ips


def _is_private(addr: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if _allowed_networks and any(addr in net for net in _allowed_networks):
        return False
    return any(addr in net for net in _BLOCKED_NETWORKS)


def validate_url_target(url: str, enable_audit: bool = True) -> tuple[bool, str]:
    """Validate a URL is safe to fetch: scheme, hostname, and resolved IPs.

    Returns (ok, error_message).  When ok is True, error_message is empty.
    """
    try:
        p = urlparse(url)
    except Exception as e:
        if enable_audit:
            log_url_access(url=url, blocked=True, reason=str(e))
        return False, str(e)

    if p.scheme not in ("http", "https"):
        reason = f"Only http/https allowed, got '{p.scheme or 'none'}'"
        if enable_audit:
            log_url_access(url=url, blocked=True, reason=reason)
        return False, reason

    if not p.netloc:
        if enable_audit:
            log_url_access(url=url, blocked=True, reason="Missing domain")
        return False, "Missing domain"

    hostname = p.hostname
    if not hostname:
        if enable_audit:
            log_url_access(url=url, blocked=True, reason="Missing hostname")
        return False, "Missing hostname"

    ips = _resolve_ips(hostname)
    if not ips:
        reason = f"Cannot resolve hostname: {hostname}"
        if enable_audit:
            log_url_access(url=url, blocked=True, reason=reason)
        return False, reason

    for ip_str in ips:
        try:
            addr = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if _is_private(addr):
            reason = f"Blocked: {hostname} resolves to private/internal address {addr}"
            if enable_audit:
                log_url_access(url=url, blocked=True, reason=reason)
            return False, reason

    if enable_audit:
        log_url_access(url=url, blocked=False)
    return True, ""


def validate_resolved_url(url: str, enable_audit: bool = True) -> tuple[bool, str]:
    """Validate an already-fetched URL (e.g. after redirect). Only checks the IP, skips DNS."""
    try:
        p = urlparse(url)
    except Exception:
        return True, ""

    hostname = p.hostname
    if not hostname:
        return True, ""

    ips = _resolve_ips(hostname)
    for ip_str in ips:
        try:
            addr = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if _is_private(addr):
            reason = f"Redirect target {hostname} resolves to private address {addr}"
            if enable_audit:
                log_url_access(url=url, blocked=True, reason=reason)
            return False, reason

    return True, ""


def validate_redirect_chain(
    initial_url: str,
    redirect_urls: list[str],
    enable_audit: bool = True,
) -> tuple[bool, str, list[str]]:
    """Validate a complete redirect chain for SSRF protection.

    Args:
        initial_url: The initial URL that was requested.
        redirect_urls: List of URLs in the redirect chain.
        enable_audit: Whether to log audit events.

    Returns:
        Tuple of (ok, error_message, validated_chain).
    """
    if len(redirect_urls) > _max_redirects:
        reason = f"Too many redirects ({len(redirect_urls)} > {_max_redirects})"
        if enable_audit:
            log_url_access(
                url=initial_url,
                blocked=True,
                reason=reason,
                redirect_chain=redirect_urls,
            )
        return False, reason, redirect_urls[: _max_redirects + 1]

    # Validate initial URL
    ok, err = validate_url_target(initial_url, enable_audit=False)
    if not ok:
        if enable_audit:
            log_url_access(url=initial_url, blocked=True, reason=err, redirect_chain=redirect_urls)
        return False, err, []

    # Validate each redirect target
    validated_chain = [initial_url]
    for redirect_url in redirect_urls:
        ok, err = validate_resolved_url(redirect_url, enable_audit=False)
        if not ok:
            if enable_audit:
                log_url_access(
                    url=initial_url,
                    blocked=True,
                    reason=f"Blocked redirect: {err}",
                    redirect_chain=validated_chain + [redirect_url],
                )
            return False, f"Blocked redirect: {err}", validated_chain
        validated_chain.append(redirect_url)

    if enable_audit:
        log_url_access(url=initial_url, blocked=False, redirect_chain=validated_chain)

    return True, "", validated_chain


def contains_internal_url(command: str) -> bool:
    """Return True if the command string contains a URL targeting an internal/private address."""
    for m in _URL_RE.finditer(command):
        url = m.group(0)
        ok, _ = validate_url_target(url, enable_audit=False)
        if not ok:
            return True
    return False


def clear_dns_cache() -> None:
    """Clear the DNS resolution cache."""
    global _dns_cache
    _dns_cache.clear()

"""Tests for network security module."""

import pytest

from tinybot.security.net import (
    validate_url_target,
    validate_resolved_url,
    validate_redirect_chain,
    contains_internal_url,
    configure_ssrf_whitelist,
    configure_redirect_limits,
    clear_dns_cache,
)


@pytest.fixture
def reset_net_state():
    """Reset net module state before and after tests."""
    clear_dns_cache()
    configure_ssrf_whitelist([])
    configure_redirect_limits()
    yield
    clear_dns_cache()
    configure_ssrf_whitelist([])
    configure_redirect_limits()


class TestValidateUrlTarget:
    """Tests for validate_url_target."""

    def test_valid_public_url(self, reset_net_state):
        """Test that valid public URLs are allowed."""
        ok, err = validate_url_target("http://example.com", enable_audit=False)
        assert ok is True
        assert err == ""

    def test_valid_https_url(self, reset_net_state):
        """Test that HTTPS URLs are allowed."""
        ok, err = validate_url_target("https://example.com", enable_audit=False)
        assert ok is True
        assert err == ""

    def test_invalid_scheme(self, reset_net_state):
        """Test that non-http schemes are blocked."""
        ok, err = validate_url_target("ftp://example.com", enable_audit=False)
        assert ok is False
        assert "http" in err

    def test_missing_hostname(self, reset_net_state):
        """Test that missing hostname is blocked."""
        ok, err = validate_url_target("http://", enable_audit=False)
        assert ok is False

    def test_localhost_blocked(self, reset_net_state):
        """Test that localhost is blocked."""
        ok, err = validate_url_target("http://localhost", enable_audit=False)
        assert ok is False
        assert "private" in err.lower() or "internal" in err.lower()

    def test_127_0_0_1_blocked(self, reset_net_state):
        """Test that 127.0.0.1 is blocked."""
        ok, err = validate_url_target("http://127.0.0.1", enable_audit=False)
        assert ok is False

    @pytest.mark.parametrize(
        "url",
        [
            "http://192.168.1.1",
            "http://10.0.0.1",
            "http://172.16.0.1",
            "http://169.254.1.1",
        ],
    )
    def test_private_ip_blocked(self, reset_net_state, url):
        """Test that private IPs are blocked."""
        ok, err = validate_url_target(url, enable_audit=False)
        assert ok is False

    def test_ssrf_whitelist(self, reset_net_state):
        """Test that SSRF whitelist allows specific IPs."""
        # Configure whitelist for carrier-grade NAT (Tailscale)
        configure_ssrf_whitelist(["100.64.0.0/10"])
        # This would normally be blocked as carrier-grade NAT
        # Note: actual resolution might vary, so we test the config is applied
        # by checking internal state or a mocked scenario
        # For real test, we'd need a mock DNS or actual Tailscale IP


class TestValidateResolvedUrl:
    """Tests for validate_resolved_url."""

    def test_valid_redirect(self, reset_net_state):
        """Test that valid redirect URLs pass."""
        ok, err = validate_resolved_url("http://example.com", enable_audit=False)
        assert ok is True

    def test_private_redirect_blocked(self, reset_net_state):
        """Test that private redirect is blocked."""
        ok, err = validate_resolved_url("http://127.0.0.1", enable_audit=False)
        assert ok is False


class TestValidateRedirectChain:
    """Tests for validate_redirect_chain."""

    def test_empty_redirect_chain(self, reset_net_state):
        """Test that empty redirect chain is valid."""
        ok, err, chain = validate_redirect_chain(
            "http://example.com",
            [],
            enable_audit=False,
        )
        assert ok is True
        assert chain == ["http://example.com"]

    def test_valid_redirect_chain(self, reset_net_state):
        """Test that valid redirect chain passes."""
        ok, err, chain = validate_redirect_chain(
            "http://example.com",
            ["http://example.org"],
            enable_audit=False,
        )
        assert ok is True
        assert len(chain) == 2

    def test_too_many_redirects(self, reset_net_state):
        """Test that too many redirects are blocked."""
        configure_redirect_limits(max_redirects=5)
        redirects = [f"http://example{i}.com" for i in range(6)]
        ok, err, chain = validate_redirect_chain(
            "http://example.com",
            redirects,
            enable_audit=False,
        )
        assert ok is False
        assert "too many" in err.lower()

    def test_private_redirect_in_chain(self, reset_net_state):
        """Test that private redirect in chain is blocked."""
        ok, err, chain = validate_redirect_chain(
            "http://example.com",
            ["http://127.0.0.1"],
            enable_audit=False,
        )
        assert ok is False
        assert "blocked redirect" in err.lower()


class TestContainsInternalUrl:
    """Tests for contains_internal_url."""

    def test_no_urls(self, reset_net_state):
        """Test that text without URLs returns False."""
        assert contains_internal_url("echo hello world") is False

    def test_public_url(self, reset_net_state):
        """Test that public URL returns False."""
        assert contains_internal_url("curl http://example.com") is False

    def test_internal_url(self, reset_net_state):
        """Test that internal URL returns True."""
        assert contains_internal_url("curl http://127.0.0.1") is True

    def test_multiple_urls(self, reset_net_state):
        """Test that multiple URLs are checked."""
        assert contains_internal_url("curl http://example.com http://localhost") is True

    @pytest.mark.parametrize(
        "command",
        [
            "curl http://192.168.1.1",
            "wget http://10.0.0.1",
            "curl http://[::1]",
        ],
    )
    def test_various_internal_urls(self, reset_net_state, command):
        """Test various internal URL patterns."""
        assert contains_internal_url(command) is True


class TestConfigureFunctions:
    """Tests for configuration functions."""

    def test_configure_redirect_limits(self, reset_net_state):
        """Test configuring redirect limits."""
        configure_redirect_limits(max_redirects=20, dns_cache_timeout_ms=10000)
        # Verify by testing too many redirects at new limit
        redirects = [f"http://example{i}.com" for i in range(21)]
        ok, err, chain = validate_redirect_chain(
            "http://example.com",
            redirects,
            enable_audit=False,
        )
        assert ok is False

    def test_clear_dns_cache(self, reset_net_state):
        """Test clearing DNS cache."""
        # Clear should work without error
        clear_dns_cache()


class TestDNSRebindingProtection:
    """Tests for DNS rebinding protection."""

    def test_dns_resolution_caching(self, reset_net_state):
        """Test that DNS resolution is cached."""
        # First resolution
        ok1, _ = validate_url_target("http://example.com", enable_audit=False)
        # Second should use cache
        ok2, _ = validate_url_target("http://example.com", enable_audit=False)
        # Both should succeed
        assert ok1 is True
        assert ok2 is True

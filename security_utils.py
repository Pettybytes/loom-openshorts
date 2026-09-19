"""Small, dependency-free SSRF guards shared by the download / scrape paths.

The app fetches user-supplied URLs server-side (yt-dlp downloads, SaaS landing
page scraping, actor-image download). Without a guard, a caller can point those
at internal services or the cloud metadata endpoint (169.254.169.254) to read
instance credentials. ``assert_public_url`` rejects non-HTTP(S) schemes and any
host that resolves to a private / loopback / link-local / reserved address.
"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


class UnsafeURLError(ValueError):
    """Raised when a URL is not safe to fetch server-side."""


def _ip_is_public(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


# LOOM-specific exception (2026-09-08, Bryan-approved): the local Caddy
# callback relay is intentionally reachable only via host.docker.internal
# from inside Docker containers, which always resolves to a private address.
# This one exact URL is allowlisted so OpenShorts can still deliver its
# terminal job.completed/job.failed webhook there. No other private/loopback/
# link-local/reserved/metadata address is affected -- every other call to
# assert_public_url still goes through the full check below unchanged.
_LOOM_RELAY_EXCEPTION = "http://host.docker.internal:8082/relay"


def assert_public_url(url: str) -> str:
    """Return ``url`` if it is safe to fetch, else raise ``UnsafeURLError``.

    Blocks non-http(s) schemes and hosts that resolve to any non-public IP.
    Resolves every A/AAAA record so a hostname that maps to a private range
    (or to 169.254.169.254) is rejected rather than silently fetched.

    Exception: the exact LOOM local relay URL (see _LOOM_RELAY_EXCEPTION
    above) is allowlisted by literal string match only.
    """
    if url == _LOOM_RELAY_EXCEPTION:
        return url

    if not url or not isinstance(url, str):
        raise UnsafeURLError("Empty URL")

    parsed = urlparse(url.strip())
    if parsed.scheme.lower() not in ("http", "https"):
        raise UnsafeURLError(f"Unsupported URL scheme: {parsed.scheme!r}")

    host = parsed.hostname
    if not host:
        raise UnsafeURLError("URL has no host")

    # If the host is a literal IP, validate it directly (no DNS).
    try:
        ipaddress.ip_address(host)
        is_ip_literal = True
    except ValueError:
        is_ip_literal = False

    if is_ip_literal:
        if not _ip_is_public(host):
            raise UnsafeURLError(f"URL host is not a public address: {host}")
        return url

    try:
        infos = socket.getaddrinfo(host, parsed.port or None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise UnsafeURLError(f"Could not resolve host {host!r}: {e}")

    resolved = {info[4][0] for info in infos}
    if not resolved:
        raise UnsafeURLError(f"Host {host!r} did not resolve")
    for ip in resolved:
        if not _ip_is_public(ip):
            raise UnsafeURLError(f"Host {host!r} resolves to a non-public address: {ip}")
    return url

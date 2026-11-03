'use strict';

const dns = require('dns').promises;

// Returns true if the IP is a private/loopback/link-local address (SSRF protection)
const PRIVATE_IP_RE = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

function isBlockedIp(address) {
  return PRIVATE_IP_RE.test(address) || address === '::1' || address === '0.0.0.0';
}

// Resolves the hostname ONCE and returns a validated IP, so the caller can
// pin the actual outbound request to that address — prevents DNS-rebinding
// TOCTOU (a hostname that resolves to a safe IP for this check and a private
// IP a moment later, when a second, independent lookup would otherwise happen).
// Returns null if the URL/host/every resolved IP is blocked or unresolvable.
async function ssrfSafeIp(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (PRIVATE_IP_RE.test(host) || host === '::1' || host === '0.0.0.0') return null;
  try {
    const addrs = await dns.lookup(host, { all: true });
    const safe = addrs.find(({ address }) => !isBlockedIp(address));
    return safe ? safe.address : null;
  } catch { return null; }
}

module.exports = { isBlockedIp, ssrfSafeIp };

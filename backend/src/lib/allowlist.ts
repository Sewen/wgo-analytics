/**
 * Optional email-domain allowlist (ALLOWED_EMAIL_DOMAINS, comma-separated). `example.com` matches exactly;
 * `*.example.com` matches any subdomain. Empty = everyone is allowed.
 */
export function parseAllowlist(raw = process.env.ALLOWED_EMAIL_DOMAINS ?? ''): string[] {
  return raw.split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
}

export function emailAllowed(email: string, allowlist = parseAllowlist()): boolean {
  if (!allowlist.length) return true;
  const domain = email.trim().toLowerCase().split('@').pop() ?? '';
  return allowlist.some((d) => (d.startsWith('*.') ? domain.endsWith(d.slice(1)) : domain === d));
}

export const allowlistMessage = (allowlist = parseAllowlist()) =>
  `Only ${allowlist.map((d) => (d.startsWith('*.') ? `@…${d.slice(1)}` : `@${d}`)).join(', ')} email addresses can use this WGO instance.`;

# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in House of Business, please report it **privately**:

- **Email:** security@houseofbusiness.co.il
- **Response time:** We will acknowledge within 48 hours and provide a resolution timeline within 7 days.
- **Do not** open a public GitHub issue for security vulnerabilities.

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

We will credit researchers who report valid vulnerabilities (unless you prefer to remain anonymous).

---

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest (main branch) | ✅ |
| Older branches | ❌ |

---

## Security Measures

### Authentication
- JWT (HS256) — minimum 64-char secret in production, enforced at startup
- bcrypt password hashing (12 rounds)
- Account lockout after 5 failed login attempts (1-hour lock)
- TOTP 2FA support (speakeasy, 6-digit codes)
- Invite-only employee registration with expiring tokens

### Authorization
- Role-based access control: `owner`, `manager`, `employee`
- Fine-grained permissions: `finance`, `inventory`, `employees`, `ai`, `export`, `audit`
- All admin endpoints protected by `requireAdmin` middleware
- Business-scoped data isolation on every query (`WHERE business_id = $1`)

### Rate Limiting
- Global: 500 requests / 15 min per IP
- Per-user: 120 requests / min after authentication
- Auth endpoints: 15 attempts / 15 min per IP
- Password reset: 5 attempts / 15 min per email

### Input Validation
- Zod schemas with `.strip()` on all mutation endpoints (mass-assignment prevention)
- UUID format enforced on all ID parameters
- Max length limits on all string fields
- Email format validation on all email fields

### Transport Security
- HTTPS enforced in production (HSTS: 1 year, includeSubDomains)
- CORS allowlist — no wildcard origins in production
- Helmet.js security headers on all responses
- Content-Security-Policy on the Next.js frontend

### Data Protection
- No sensitive data in logs (passwords, tokens never logged)
- Error handler strips all internal details from 500 responses
- DB queries use parameterized statements ($1, $2...) — no string concatenation
- Uploaded files: auth-gated, filename whitelist regex, served from `/uploads/`

### CI/CD Security
- TruffleHog secret scanning on every push
- GitHub CodeQL static analysis (security-and-quality query suite)
- `npm audit --audit-level=high` on every PR
- JWT_SECRET entropy check in CI pipeline

---

## Known Limitations

- No nonce-based CSP (Next.js standalone requires `unsafe-inline`/`unsafe-eval` for hydration)
- SMS 2FA not implemented (TOTP app required)
- No IP allowlisting for admin panel

---

## Dependency Updates

We run `npm audit` in CI. Security patches are applied within 7 days of disclosure for high/critical severity issues.

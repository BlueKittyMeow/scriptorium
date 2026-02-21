# Codex Review — Phase 2 Auth Implementation Plan

## Document under review
`docs/implementation.md` — "Phase 2: The Lock and Key"

This is a **design review**, not a code review. No code has been written yet. We want to catch architectural issues, security gaps, and missing edge cases before implementation begins.

## Context
- Scriptorium: self-hosted novel writing app (SvelteKit, SQLite, better-sqlite3)
- Adding auth: username/password, two roles (writer/archivist), SQLite sessions
- Solo-friendly: one person can be their own archivist (common case)
- Import is accessible to all authenticated users, not admin-only
- bcryptjs for hashing, httpOnly cookies, 30-day sliding sessions
- Audit log from day one

## Review focus areas

### 1. Security
- Is bcryptjs with cost factor 12 sufficient? Any concerns with pure-JS implementation?
- Session token generation via `crypto.randomBytes(32).toString('hex')` — adequate entropy?
- httpOnly cookie settings: `secure` when not localhost, `sameSite=lax`, `path=/`
- Rate limiting: in-memory counter, 5 attempts/minute/IP — any bypass concerns?
- The `requireUser`/`requireArchivist` guard pattern — is checking at endpoint level sufficient, or should hooks do more?

### 2. Session management
- 30-day sliding expiry — extends on every request. Too long? Too generous?
- `cleanExpiredSessions` called "periodically" — when exactly? Startup? Timer? Per-request?
- No session revocation beyond logout — if a user's password is changed, should existing sessions be invalidated?

### 3. Account model
- Setup creates archivist, writer account is optional (created from admin panel)
- What happens if the archivist forgets their password? No email recovery. Is "delete the DB and re-setup" acceptable?
- Should there be a password recovery mechanism (even a CLI tool)?
- "Allow multiple archivists" — any risk of privilege escalation?

### 4. Import route placement
- Import endpoints live under `/api/admin/import/*` but use `requireUser` not `requireArchivist`
- Is this URL prefix misleading? Should they move to `/api/import/*`?
- Or is the current placement fine since the path doesn't imply the permission level?

### 5. Audit log
- `document.update` is "debounced — not every keystroke" — how? What's the debounce strategy?
- Audit log has no retention policy — should there be one?
- Is the audit log schema flexible enough (entity_type + entity_id + details TEXT)?

### 6. Missing edge cases
- Concurrent session limit? (One user logged in from multiple browsers)
- CSRF protection? (SvelteKit has built-in origin checking, but worth confirming)
- What happens to in-flight requests when a session expires mid-editing?
- Cookie behavior on browser close vs. explicit logout

### 7. Anything else
- Patterns that could cause problems at implementation time
- Suggestions for simplification
- Things the plan over-engineers vs. under-engineers

---

## Findings

| # | Severity | Finding | Details |
|---|----------|---------|---------|
| 1 | Medium | CSRF protection not specified | The plan relies on httpOnly cookies with `SameSite=lax` but doesn’t specify CSRF mitigation for state‑changing POST/PUT/DELETE routes. SvelteKit’s origin checks help, but explicit CSRF tokens or double‑submit cookies would harden the surface, especially if the app is exposed beyond localhost. |
| 2 | Medium | Sliding session expiry can thrash DB | “Extend on activity” implies updating `expires_at` on every request. With autosave and polling, this becomes frequent writes and potential WAL churn. Consider refreshing only when <N days from expiry or storing `last_seen` and extending opportunistically. |
| 3 | Medium | Session tokens stored in plaintext | Sessions are stored as raw tokens in SQLite. If the DB is copied, sessions can be replayed. Prefer storing a hash of the token (e.g., SHA‑256) and comparing hashed values, similar to password storage. |
| 4 | Medium | Password change does not revoke existing sessions | The plan doesn’t mention invalidating active sessions when a password is changed or role is updated. That leaves compromised sessions alive. Add a “revoke all sessions for user” step on password/role changes. |
| 5 | Medium | bcryptjs cost factor on low‑power devices | Cost 12 in pure JS can be slow on Pi‑class hardware, making login sluggish and enabling easy DoS. Consider making the cost configurable or using native `bcrypt` when available with a fallback to `bcryptjs`. |
| 6 | Low | Rate limiting only by IP is weak | The in‑memory 5/min/IP counter is easy to bypass in shared networks and doesn’t prevent user‑targeted brute force. Add per‑username throttling and exponential backoff, even if kept in memory. |
| 7 | Low | Import endpoints under `/api/admin` but open to writers | Keeping writer‑accessible routes under an admin prefix is easy to mis‑guard later and confusing for auditors. Consider `/api/import/*` or add explicit tests/comments to prevent accidental `requireArchivist` enforcement. |

(Fill in findings above)

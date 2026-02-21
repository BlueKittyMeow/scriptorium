# Gemini Review — Phase 2 Auth Implementation Plan

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

### 1. Security model
- bcryptjs cost factor 12, `crypto.randomBytes(32)` for session tokens
- httpOnly + secure + sameSite=lax cookies
- In-memory rate limiting (5 attempts/min/IP, resets on server restart)
- Guard functions (`requireUser`/`requireArchivist`) at each endpoint

### 2. Session design
- SQLite sessions table with 30-day sliding expiry
- `validateSession` checks expiry and returns user
- No mechanism to invalidate all sessions for a user (e.g., on password change)
- `cleanExpiredSessions` — trigger mechanism unspecified

### 3. First-run and account model
- Zero users → redirect to `/setup` → creates archivist
- Solo-friendly: archivist = the user, no separate writer needed
- Optional writer account created from admin panel
- No self-registration, no email, no password recovery
- What if only user loses access? Recovery story?

### 4. Route architecture
- Import under `/api/admin/import/*` with `requireUser` (not `requireArchivist`)
- Admin panel at `/routes/admin/` with archivist guard
- Layout server load handles redirects for unauthenticated users
- All existing API endpoints get `requireUser`

### 5. Audit and trash
- Audit log: flexible schema (action + entity_type + entity_id + details)
- Purge requires confirmation token (two-step permanent delete)
- Trash browser in admin panel lists soft-deleted items across all novels
- Document save audit is "debounced" — strategy unclear

### 6. Implementation concerns
- 21 new files + 8 edits — is the layered approach right?
- `compile_configs` table mentioned in a plan file but not in this auth plan — any interaction?
- Test coverage: source-scan pattern for route protection — sufficient?

---

## Findings

| # | Severity | Finding | Details |
|---|----------|---------|---------|
| 1 | Medium | Lack of Session Invalidation | No mechanism to invalidate all sessions for a user. Password changes or "logout all devices" won't work effectively without a way to delete all sessions for a `user_id`. |
| 2 | Medium | Account Recovery | In a self-hosted app without email, forgetting the archivist password is a fatal lockout. **Suggestion:** Implement a CLI command (e.g., `npm run reset-password --user=admin`) for emergency access. |
| 3 | Low | Rate Limiting Persistence | In-memory rate limiting resets on server restart. While acceptable for a 2-user app, it's a weak defense against distributed or persistent brute-force attempts. |
| 4 | Low | CSRF for API Endpoints | While SvelteKit protects Form Actions, custom `+server.ts` POST/PUT/DELETE endpoints need verification that they are protected against CSRF, especially since `sameSite=lax` is used. |
| 5 | Low | Session Cleanup Trigger | `cleanExpiredSessions` is defined but its execution trigger is missing. If not called (e.g., on a cron or on every Nth request), the `sessions` table will grow indefinitely. |
| 6 | Low | Last Archivist Race Condition | The check to "prevent demoting the last archivist" must be inside a transaction to avoid race conditions where two archivists demote each other simultaneously. |
| 7 | Note | Audit Log Entity Integrity | Purging an entity leaves "dead" IDs in the `audit_log`. This is acceptable for logs but should be documented as intended behavior. |
| 8 | Note | Document Save Audit Bloat | Debouncing document save audits is mentioned but the strategy isn't detailed. Over-logging saves could rapidly bloat the `audit_log` table. |

(Fill in findings above)

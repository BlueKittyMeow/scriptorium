# Phase 2: The Lock and Key — Auth Implementation Plan

## Design Decisions

### User model
- **Username + password** (not email — no mail server for a self-hosted app)
- **Two roles:** `writer` and `archivist` (archivist has all writer permissions + admin)
- **Solo-friendly** — one person can be their own archivist (the common case)
- **Shared library** — all users see all novels. Roles gate *actions*, not data visibility
- No self-registration — archivist creates additional accounts from admin panel

### Session management
- **SQLite `sessions` table** — consistent with our all-SQLite approach
- **httpOnly cookie** (`scriptorium-session`) with session ID
- **30-day expiry**, sliding — but only extend when within last 7 days (avoids DB thrash from autosave)
- **Session tokens hashed** — store SHA-256 of token in DB, compare hashes on validation. If DB is copied, raw tokens can't be replayed
- **Invalidate on password/role change** — `DELETE FROM sessions WHERE user_id = ?` when password or role is updated
- `secure` flag when not localhost, `sameSite=lax`, `path=/`

### Password hashing
- **bcryptjs** (pure JS, no native deps, fine for 2 users) — cost factor 12
- `crypto.randomBytes(32).toString('hex')` for session tokens

### First-run setup
- If no users exist in DB → redirect all routes to `/setup`
- Setup page creates the first account — always archivist role (username + password + confirm)
- This is your account. If you're a solo user, you're done — you're your own archivist
- After setup → redirect to `/login`
- Optionally create a writer account later from the admin panel (for a collaborator)

### Route protection
- `hooks.server.ts` reads cookie → loads session → loads user → `event.locals.user`
- `+layout.server.ts` redirects to `/login` if no user (except `/login` and `/setup`)
- Admin API endpoints (`/api/admin/*`) check `role === 'archivist'`
- Regular API endpoints check user exists (any role)
- **Import is not admin-only** — any authenticated user can import. Import endpoints move to `/api/import/*` (out of admin prefix) with `requireUser`

---

## DB Schema Additions

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'writer' CHECK(role IN ('writer', 'archivist')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
```

---

## Layer 0: Infrastructure

### New files

1. **`src/lib/server/auth.ts`** — Core auth utilities
   - `hashPassword(password)` → bcryptjs hash (cost 12)
   - `verifyPassword(password, hash)` → boolean
   - `hashSessionToken(token)` → SHA-256 hex string (for DB storage)
   - `createSession(db, userId)` → `{ token, expiresAt }` (random token returned to caller, SHA-256 hash stored in DB)
   - `validateSession(db, token)` → `{ user } | null` (hashes token, looks up hash, checks expiry)
   - `extendSession(db, tokenHash, expiresAt)` → void (only called when within 7 days of expiry)
   - `destroySession(db, tokenHash)` → void
   - `destroyUserSessions(db, userId)` → void (invalidate all sessions for a user)
   - `cleanExpiredSessions(db)` → void (called on every login attempt — rare event, good time to housekeep)
   - `SESSION_COOKIE_NAME = 'scriptorium-session'`
   - `SESSION_MAX_AGE = 30 * 24 * 60 * 60` (30 days in seconds)
   - `SESSION_EXTEND_THRESHOLD = 7 * 24 * 60 * 60` (only extend when within 7 days of expiry)

2. **`src/lib/types.ts`** — Add auth types
   ```typescript
   export interface User {
     id: string;
     username: string;
     role: 'writer' | 'archivist';
     created_at: string;
     updated_at: string;
   }
   // Note: password_hash never leaves the server
   ```

3. **`src/app.d.ts`** — Extend Locals
   ```typescript
   interface Locals {
     db: Database.Database;
     user: User | null;
   }
   ```

### Existing file changes

4. **`src/lib/server/db.ts`** — Add `users`, `sessions`, `audit_log` tables to SCHEMA
5. **`tests/helpers.ts`** — Add same tables to test schema, add `seedUser()` helper

---

## Layer 1: Auth Middleware (hooks)

6. **`src/hooks.server.ts`** — Extend handle function
   - Read `scriptorium-session` cookie from request
   - If cookie exists → `validateSession(db, token)` (hashes token, looks up hash)
   - If valid → set `event.locals.user = user`, extend session only if within 7 days of expiry
   - If invalid/expired → clear cookie, set `event.locals.user = null`
   - If no cookie → set `event.locals.user = null`
   - Always attach `db` to locals (existing behavior)

7. **`src/routes/+layout.server.ts`** — New server load function
   - Check `event.locals.user`
   - If no user AND not on `/login` or `/setup` → redirect to `/login`
   - If no users exist in DB at all → redirect to `/setup`
   - Return `{ user }` to layout for role-aware UI

8. **`src/routes/+layout.svelte`** — Update to show username/role in header, add logout button

---

## Layer 2: Auth Pages

9. **`src/routes/setup/+page.svelte`** — First-run setup
   - Form: username, password, confirm password
   - Validates: username not empty, password >= 8 chars, passwords match
   - POST to `/api/auth/setup`
   - Only accessible when zero users exist
   - Creates an archivist account (the first user is always the archivist)
   - Solo users: this is your only account — you're writer + archivist in one
   - On success → redirect to `/login`

10. **`src/routes/setup/+page.server.ts`** — Guard: redirect to `/login` if users exist

11. **`src/routes/login/+page.svelte`** — Login form
    - Form: username, password
    - POST to `/api/auth/login`
    - Error display for invalid credentials
    - On success → redirect to `/` (library)

12. **`src/routes/login/+page.server.ts`** — Guard: redirect to `/` if already logged in

---

## Layer 3: Auth API Endpoints

13. **`src/routes/api/auth/setup/+server.ts`** — POST
    - Only works when zero users exist (otherwise 403)
    - Creates archivist user with hashed password
    - Returns success

14. **`src/routes/api/auth/login/+server.ts`** — POST
    - Validates username/password against DB
    - Creates session, sets httpOnly cookie
    - Returns `{ user: { id, username, role } }`
    - Rate limiting: simple in-memory counter (5 attempts per minute per IP)

15. **`src/routes/api/auth/logout/+server.ts`** — POST
    - Destroys session in DB
    - Clears cookie
    - Returns success

16. **`src/routes/api/auth/me/+server.ts`** — GET
    - Returns current user or 401

---

## Layer 4: Route Protection

17. **API auth guard helper** — `src/lib/server/auth.ts`
    - `requireUser(locals)` → throws 401 if no user
    - `requireArchivist(locals)` → throws 403 if not archivist
    - Used at top of each API endpoint

18. **Protect all existing API routes** — Add `requireUser(locals)` to:
    - `/api/novels/*`
    - `/api/documents/*`
    - `/api/search`
    - `/api/import/*` (scan, batch, single) — import is a writer action, not admin-only
    - All existing endpoints

19. **Protect admin-only routes** — Add `requireArchivist(locals)` to:
    - `/api/admin/users/*` (user management)
    - `/api/admin/trash/*` (purge is destructive, archivist-only)
    - `/api/admin/storage/*`, `/api/admin/audit/*`
    - Future admin endpoints

---

## Layer 5: Admin Panel

20. **`src/routes/admin/+page.svelte`** — Admin dashboard
    - User management: list users, optionally create a writer account (for a collaborator), change passwords
    - Storage metrics: snapshot count, disk usage, novel count
    - Audit log: recent actions with user, action, timestamp
    - Trash browser: list soft-deleted items across all novels

21. **`src/routes/admin/+page.server.ts`** — Guard: require archivist role

22. **`src/routes/api/admin/users/+server.ts`** — GET (list) + POST (create)
    - Only archivist can manage users
    - POST: creates new user (username, password, role)
    - Allow multiple archivists (no artificial limit — trust the admin)

23. **`src/routes/api/admin/users/[userId]/+server.ts`** — PATCH (update) + DELETE
    - Change password, change role
    - On password or role change → `destroyUserSessions(db, userId)` (invalidate all sessions)
    - Cannot delete yourself
    - Cannot demote the last archivist (check inside transaction to prevent race condition)

24. **`src/routes/api/admin/trash/+server.ts`** — GET
    - List all soft-deleted novels, folders, documents across entire library
    - Include: item type, title, novel title, deleted_at, deleted by (audit log)

25. **`src/routes/api/admin/trash/[type]/[id]/restore/+server.ts`** — POST
    - Restore soft-deleted item (set `deleted_at = NULL`)
    - Re-index in FTS5 if document
    - Audit log entry

26. **`src/routes/api/admin/trash/[type]/[id]/purge/+server.ts`** — DELETE
    - Permanent delete (actual DB DELETE + file removal)
    - Requires confirmation token (POST to get token, DELETE with token)
    - Audit log entry

27. **`src/routes/api/admin/storage/+server.ts`** — GET
    - Snapshot count per novel
    - Total disk usage (content files + snapshots)
    - Novel count, document count

28. **`src/routes/api/admin/audit/+server.ts`** — GET
    - Paginated audit log
    - Filter by user, action type, date range

---

## Layer 6: Audit Logging

29. **`src/lib/server/audit.ts`** — `logAction(db, userId, action, entityType?, entityId?, details?)`
    - Insert into audit_log table
    - Actions: `user.login`, `user.logout`, `user.create`, `novel.create`, `novel.delete`, `document.update`, `trash.restore`, `trash.purge`, `import.single`, `import.batch`, `compile.export`

30. **Wire audit logging into existing endpoints** — Add `logAction()` calls to:
    - Novel create/delete
    - Document save — log on document close/switch only (one entry per editing session per document, not on every autosave tick)
    - Import (single + batch)
    - Compile/export
    - Trash restore/purge
    - User management (including session invalidation on password/role change)

31. **`scripts/reset-password.js`** — CLI account recovery tool
    - Usage: `node scripts/reset-password.js <username>`
    - Prompts for new password interactively
    - Hashes with bcryptjs, updates DB directly
    - Destroys all sessions for the user
    - Essential for self-hosted app with no email recovery

---

## Tests

32. **`tests/auth.test.ts`** — Red-green tests:
    - Password hashing: hash + verify roundtrip, wrong password fails
    - Session token hashing: raw token not stored in DB, SHA-256 hash stored instead
    - Session management: create, validate, expire, destroy
    - Sliding expiry: only extends when within 7-day threshold, not on every request
    - Session invalidation: `destroyUserSessions` removes all sessions for a user
    - Clean expired sessions (triggered on login)
    - requireUser/requireArchivist guard functions
    - Setup: only works with zero users, creates archivist
    - Login: valid credentials, invalid password, nonexistent user, rate limiting
    - Route protection source-scan: all API files include requireUser or requireArchivist
    - Import endpoints use requireUser (not requireArchivist) — writers can import
    - Import endpoints live under `/api/import/`, not `/api/admin/import/`
    - Audit log: logAction creates entry, entries have correct shape
    - User management: create, update role, prevent last-archivist deletion
    - Password/role change invalidates sessions (source-scan for destroyUserSessions)
    - Last-archivist check is inside a transaction

---

## Implementation Order

1. Write failing tests (Layer 6 tests) — RED
2. Layer 0: Infrastructure (auth.ts, types, schema, test helpers)
3. Layer 1: Auth middleware (hooks, layout server load)
4. Layer 2: Auth pages (setup, login)
5. Layer 3: Auth API endpoints
6. Layer 4: Route protection on existing endpoints
7. Confirm core auth tests pass — GREEN
8. Layer 5: Admin panel (UI + API endpoints)
9. Layer 6: Audit logging
10. Full test pass, build check
11. Manual testing (setup flow, login, role gating, admin panel)
12. Commit and push

---

## File Summary

| Action | File |
|--------|------|
| Create | `src/lib/server/auth.ts` |
| Create | `src/lib/server/audit.ts` |
| Create | `src/routes/setup/+page.svelte` |
| Create | `src/routes/setup/+page.server.ts` |
| Create | `src/routes/login/+page.svelte` |
| Create | `src/routes/login/+page.server.ts` |
| Create | `src/routes/admin/+page.svelte` |
| Create | `src/routes/admin/+page.server.ts` |
| Create | `src/routes/+layout.server.ts` |
| Create | `src/routes/api/auth/setup/+server.ts` |
| Create | `src/routes/api/auth/login/+server.ts` |
| Create | `src/routes/api/auth/logout/+server.ts` |
| Create | `src/routes/api/auth/me/+server.ts` |
| Create | `src/routes/api/admin/users/+server.ts` |
| Create | `src/routes/api/admin/users/[userId]/+server.ts` |
| Create | `src/routes/api/admin/trash/+server.ts` |
| Create | `src/routes/api/admin/trash/[type]/[id]/restore/+server.ts` |
| Create | `src/routes/api/admin/trash/[type]/[id]/purge/+server.ts` |
| Create | `src/routes/api/admin/storage/+server.ts` |
| Create | `src/routes/api/admin/audit/+server.ts` |
| Create | `scripts/reset-password.js` |
| Create | `tests/auth.test.ts` |
| Edit | `src/lib/server/db.ts` (add users, sessions, audit_log tables) |
| Edit | `src/lib/types.ts` (add User type) |
| Edit | `src/app.d.ts` (extend Locals with user) |
| Edit | `src/hooks.server.ts` (session middleware) |
| Edit | `src/routes/+layout.svelte` (user display, logout button) |
| Edit | `tests/helpers.ts` (add auth tables, seedUser helper) |
| Move | `src/routes/api/admin/import/*` → `src/routes/api/import/*` (import is not admin-only) |
| Edit | `src/routes/+page.svelte` (update import API URLs from `/api/admin/import` to `/api/import`) |
| Edit | All existing `/api/*` endpoints (add requireUser/requireArchivist) |

### Dependencies to add
- `bcryptjs` — pure JS bcrypt (no native compilation needed)

---

## Review Findings Adopted

These changes were adopted from Codex and Gemini design review:

1. **Session tokens hashed in DB** (Codex #3) — store SHA-256, not plaintext. Defense against DB-copy replay
2. **Sliding expiry optimized** (Codex #2) — only extend when within 7 days of expiry, not every request. Prevents WAL thrash from autosave
3. **Session invalidation on password/role change** (Codex #4, Gemini #1) — `destroyUserSessions()` on any credential change
4. **Import moved to `/api/import/`** (Codex #7) — out of admin prefix since writers can import
5. **Account recovery CLI** (Gemini #2) — `scripts/reset-password.js` for fatal lockout scenarios
6. **Session cleanup trigger** (Gemini #5) — clean expired sessions on every login attempt
7. **Last-archivist check in transaction** (Gemini #6) — prevents race condition
8. **Document audit debounce clarified** (Gemini #8) — log on document close/switch only, not autosave

Dismissed: CSRF (SvelteKit handles via Origin header), bcryptjs cost on Pi (acceptable for rare logins), per-username rate limiting (over-engineering for small user count), audit log dead IDs (intended behavior)

---

## Key Decisions

1. **Username not email** — simpler for self-hosted, no password recovery via email (CLI tool instead)
2. **Shared library** — roles gate actions, not data. No per-user novel filtering
3. **Solo-friendly** — setup creates your archivist account. You *can* create a writer for a collaborator, but don't have to. One person is both writer and archivist in the common case
4. **Import is not admin-only** — any logged-in user can import .scriv projects. Writers write; importing is part of writing
5. **bcryptjs over bcrypt** — pure JS, no native deps, fine for small user count
6. **Sliding 30-day sessions** — long-lived for convenience, httpOnly for security, extend only near expiry
7. **Session tokens hashed** — SHA-256 in DB, defense-in-depth against DB copy
8. **Rate limiting in-memory** — simple counter, resets on server restart (fine for small user count)
9. **Audit log from day one** — captures who did what, invaluable for debugging. Document saves logged per editing session, not per autosave
10. **Purge requires confirmation token** — two-step delete prevents accidental permanent data loss

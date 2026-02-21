# Scriptorium Security Model

Scriptorium is a self-hosted, single-instance application. There is no cloud component, no email service, and no third-party auth provider. Everything lives on your machine.

## User Accounts

### Storage

User records live in the `users` table in the SQLite database (`data/scriptorium.db`):

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT (UUID) | Primary key |
| `username` | TEXT | Unique, case-sensitive |
| `password_hash` | TEXT | bcrypt hash (see below) |
| `role` | TEXT | `'writer'` or `'archivist'` |
| `created_at` | TEXT (ISO 8601) | |
| `updated_at` | TEXT (ISO 8601) | |

Plaintext passwords are **never** stored or logged. They exist in server memory only momentarily during login (for verification) and account creation/password change (for hashing), then are discarded. In production, the `secure` cookie flag ensures these requests travel over HTTPS.

### Roles

- **Archivist** — full access including user management, trash operations, and the admin panel.
- **Writer** — can create, edit, import, and export novels. Cannot access admin features.

The first account created during setup is always an archivist. The system enforces that at least one archivist must exist at all times (last-archivist protection, checked inside a transaction to prevent race conditions).

### First-Run Setup

When the database has zero users, the app redirects to `/setup`. The setup endpoint (`POST /api/auth/setup`) only works when the user count is exactly zero — it refuses all requests once any user exists.

## Password Handling

### Hashing

Passwords are hashed with **bcryptjs** (pure-JS bcrypt implementation, no native compilation needed) at **cost factor 12**.

```
bcrypt.hash(password, 12) → "$2a$12$..."
```

Verification uses constant-time comparison via `bcrypt.compare()`.

### Minimum Length

All password entry points (setup, admin user creation, admin password change, CLI reset) enforce a minimum of **8 characters**.

### Where Hashing Happens

| Operation | Location |
|-----------|----------|
| First-run setup | `src/routes/api/auth/setup/+server.ts` |
| Admin creates user | `src/routes/api/admin/users/+server.ts` |
| Admin changes password | `src/routes/api/admin/users/[userId]/+server.ts` |
| CLI password reset | `scripts/reset-password.js` |

## Session Management

### How Sessions Work

1. On login, a **32-byte random token** is generated with `crypto.randomBytes(32)`.
2. The raw token is sent to the browser as an **httpOnly cookie** (`scriptorium-session`).
3. The token is **SHA-256 hashed** before storing in the database. The raw token never touches the database.

This means that even if someone copies the database file, they cannot extract valid session tokens.

### Session Table

| Column | Type | Notes |
|--------|------|-------|
| `token_hash` | TEXT | Primary key (SHA-256 hex digest) |
| `user_id` | TEXT | FK → users |
| `expires_at` | TEXT (ISO 8601) | |
| `created_at` | TEXT (ISO 8601) | |

### Cookie Configuration

| Property | Value | Notes |
|----------|-------|-------|
| `httpOnly` | `true` | Not accessible to JavaScript |
| `sameSite` | `lax` | CSRF protection (SvelteKit also provides its own) |
| `secure` | `true` (except localhost) | HTTPS-only when not on localhost/127.0.0.1 |
| `maxAge` | 30 days | Browser-side expiry |
| `path` | `/` | Available site-wide |

### Expiry and Sliding Window

Sessions last **30 days**. To avoid unnecessary database writes from autosave requests, the session is only extended when it has **fewer than 7 days remaining**. When extended, it resets to a fresh 30 days.

### Session Invalidation

All of a user's sessions are destroyed when:

- Their **password is changed** (by admin or CLI reset)
- Their **role is changed** (by admin)
- Their **account is deleted** (by admin)
- They use **"Log out everywhere"** (`POST /api/auth/logout-all`) — destroys all sessions across all devices
- They **log out** normally — destroys only the current session

Expired sessions are cleaned up as housekeeping during login.

## Login Protection

### Rate Limiting

Login attempts are rate-limited to **5 attempts per minute per IP address**. This uses an in-memory map (resets on server restart). After exceeding the limit, the client receives HTTP 429.

### Error Messages

Login failures return a generic `"Invalid credentials"` message for both unknown usernames and wrong passwords, preventing username enumeration.

## Route Protection

Every API endpoint is guarded by one of two functions:

- `requireUser(locals)` — throws 401 if no session. Used on all data endpoints.
- `requireArchivist(locals)` — throws 403 if not an archivist. Used on admin endpoints.

The auth middleware in `hooks.server.ts` validates the session cookie on every request and attaches the user to `event.locals.user`. The layout server load function handles redirects:

- No users exist → redirect to `/setup`
- No valid session → redirect to `/login`
- Logged in but on `/login` → redirect to `/`

## Password Reset

Since Scriptorium is self-hosted with no email service, password recovery is handled via a **CLI script** that requires server access:

```bash
node scripts/reset-password.js <username>
```

The script:

1. Finds the user in the database (shows available usernames if not found)
2. Prompts for a new password (minimum 8 characters) and confirmation
3. In a single transaction: updates the password hash and deletes all sessions for that user
4. Respects the `DATA_ROOT` environment variable for non-default data locations

This is intentionally a server-side operation — if you have shell access to the machine, you can reset any password.

## Audit Trail

Significant actions are logged to the `audit_log` table:

| Action | When |
|--------|------|
| `user.login` | Successful login |
| `user.logout` | Logout (single session) |
| `user.logout_all` | Logout everywhere (all sessions) |
| `user.create` | Admin creates a user |
| `novel.create` | Novel created |
| `novel.delete` | Novel soft-deleted |
| `import.single` | Scrivener project imported |
| `trash.restore` | Item restored from trash |

Each log entry records the user ID, action, entity type/ID, optional details, and timestamp. The audit log is viewable from the admin panel with filtering by user and action type.

Document saves are **not** individually logged to avoid flooding the audit trail — the editor autosaves frequently.

## Data Storage Summary

| What | Where | Format |
|------|-------|--------|
| User accounts | `data/scriptorium.db` → `users` table | SQLite |
| Password hashes | `users.password_hash` | bcrypt ($2a$12) |
| Session tokens (hashed) | `data/scriptorium.db` → `sessions` table | SHA-256 hex |
| Session cookie | Browser | Raw 32-byte hex token |
| Audit log | `data/scriptorium.db` → `audit_log` table | SQLite |
| Document content | `data/{novelId}/docs/{docId}.html` | HTML files on disk |
| Snapshots | `data/{novelId}/snapshots/{docId}/{timestamp}.html` | HTML files on disk |
| Database | `data/scriptorium.db` | SQLite with WAL mode |

## What We Don't Have (and why)

- **Email recovery** — no email service in a self-hosted app. Use the CLI reset script instead.
- **OAuth / SSO** — unnecessary complexity for a personal writing tool. May revisit if multi-user demand grows.
- **CSRF tokens** — SvelteKit handles CSRF protection natively by checking the `Origin` header against the `Host` header on mutation requests.
- **Password complexity rules beyond length** — an 8-character minimum is enforced. We don't mandate uppercase/symbols; passphrase-style passwords are welcome.
- **Account lockout** — rate limiting per IP handles brute force. No permanent lockout that could be used for denial-of-service against legitimate users.

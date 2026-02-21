import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, seedUser } from './helpers.js';
import fs from 'fs';
import path from 'path';

// We'll import these once they exist (RED phase — these will fail)
import {
	hashPassword,
	verifyPassword,
	hashSessionToken,
	createSession,
	validateSession,
	extendSession,
	destroySession,
	destroyUserSessions,
	cleanExpiredSessions,
	requireUser,
	requireArchivist,
	SESSION_MAX_AGE,
	SESSION_EXTEND_THRESHOLD
} from '$lib/server/auth.js';

import { logAction } from '$lib/server/audit.js';

let db: Database.Database;

beforeEach(() => {
	db = createTestDb();
});

// ─── Password Hashing ────────────────────────────────────────────

describe('password hashing', () => {
	it('hash + verify roundtrip succeeds', async () => {
		const hash = await hashPassword('correct-horse-battery');
		const result = await verifyPassword('correct-horse-battery', hash);
		expect(result).toBe(true);
	});

	it('wrong password fails verification', async () => {
		const hash = await hashPassword('correct-horse-battery');
		const result = await verifyPassword('wrong-password', hash);
		expect(result).toBe(false);
	});

	it('produces a bcrypt hash (starts with $2)', async () => {
		const hash = await hashPassword('test-password');
		expect(hash).toMatch(/^\$2[aby]\$/);
	});
});

// ─── Session Token Hashing ───────────────────────────────────────

describe('session token hashing', () => {
	it('produces a hex string', () => {
		const hash = hashSessionToken('some-raw-token');
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('same input produces same hash', () => {
		const h1 = hashSessionToken('token-abc');
		const h2 = hashSessionToken('token-abc');
		expect(h1).toBe(h2);
	});

	it('different inputs produce different hashes', () => {
		const h1 = hashSessionToken('token-1');
		const h2 = hashSessionToken('token-2');
		expect(h1).not.toBe(h2);
	});
});

// ─── Session Management ─────────────────────────────────────────

describe('session management', () => {
	let userId: string;

	beforeEach(() => {
		const user = seedUser(db, 'archivist');
		userId = user.id;
	});

	it('createSession returns a raw token and expiresAt', async () => {
		const session = await createSession(db, userId);
		expect(session).toHaveProperty('token');
		expect(session).toHaveProperty('expiresAt');
		expect(typeof session.token).toBe('string');
		expect(session.token.length).toBeGreaterThanOrEqual(32);
	});

	it('raw token is NOT stored in DB — only its hash', async () => {
		const session = await createSession(db, userId);
		const rows = db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
		expect(rows).toHaveLength(1);
		// The stored hash should NOT equal the raw token
		expect(rows[0].token_hash).not.toBe(session.token);
		// The stored hash should equal the SHA-256 of the raw token
		expect(rows[0].token_hash).toBe(hashSessionToken(session.token));
	});

	it('validateSession returns user for valid token', async () => {
		const session = await createSession(db, userId);
		const result = await validateSession(db, session.token);
		expect(result).not.toBeNull();
		expect(result!.user.id).toBe(userId);
		expect(result!.user.username).toBeDefined();
		expect(result!.user.role).toBeDefined();
		// password_hash must never be returned
		expect((result!.user as any).password_hash).toBeUndefined();
	});

	it('validateSession returns null for invalid token', async () => {
		const result = await validateSession(db, 'nonexistent-token');
		expect(result).toBeNull();
	});

	it('validateSession returns null for expired session', async () => {
		const session = await createSession(db, userId);
		// Manually expire the session
		const tokenHash = hashSessionToken(session.token);
		db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
			.run(new Date(Date.now() - 1000).toISOString(), tokenHash);
		const result = await validateSession(db, session.token);
		expect(result).toBeNull();
	});

	it('destroySession removes the session', async () => {
		const session = await createSession(db, userId);
		const tokenHash = hashSessionToken(session.token);
		destroySession(db, tokenHash);
		const result = await validateSession(db, session.token);
		expect(result).toBeNull();
	});

	it('destroyUserSessions removes all sessions for a user', async () => {
		// Create multiple sessions
		await createSession(db, userId);
		await createSession(db, userId);
		await createSession(db, userId);

		const countBefore = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE user_id = ?').get(userId) as { c: number };
		expect(countBefore.c).toBe(3);

		destroyUserSessions(db, userId);

		const countAfter = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE user_id = ?').get(userId) as { c: number };
		expect(countAfter.c).toBe(0);
	});

	it('cleanExpiredSessions removes only expired sessions', async () => {
		// Create a valid session
		const valid = await createSession(db, userId);
		// Create another and manually expire it
		const expired = await createSession(db, userId);
		const expiredHash = hashSessionToken(expired.token);
		db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
			.run(new Date(Date.now() - 1000).toISOString(), expiredHash);

		cleanExpiredSessions(db);

		const rows = db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0].token_hash).toBe(hashSessionToken(valid.token));
	});
});

// ─── Sliding Expiry ─────────────────────────────────────────────

describe('sliding expiry', () => {
	let userId: string;

	beforeEach(() => {
		const user = seedUser(db, 'archivist');
		userId = user.id;
	});

	it('SESSION_EXTEND_THRESHOLD is 7 days in seconds', () => {
		expect(SESSION_EXTEND_THRESHOLD).toBe(7 * 24 * 60 * 60);
	});

	it('SESSION_MAX_AGE is 30 days in seconds', () => {
		expect(SESSION_MAX_AGE).toBe(30 * 24 * 60 * 60);
	});

	it('does NOT extend session when more than 7 days from expiry', async () => {
		const session = await createSession(db, userId);
		const tokenHash = hashSessionToken(session.token);

		// Session was just created → ~30 days from expiry → should NOT extend
		const rowBefore = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as { expires_at: string };

		extendSession(db, tokenHash, new Date(rowBefore.expires_at));

		const rowAfter = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as { expires_at: string };
		expect(rowAfter.expires_at).toBe(rowBefore.expires_at); // unchanged
	});

	it('DOES extend session when within 7 days of expiry', async () => {
		const session = await createSession(db, userId);
		const tokenHash = hashSessionToken(session.token);

		// Manually set expiry to 3 days from now (within threshold)
		const threeDaysFromNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
		db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
			.run(threeDaysFromNow.toISOString(), tokenHash);

		extendSession(db, tokenHash, threeDaysFromNow);

		const rowAfter = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as { expires_at: string };
		const newExpiry = new Date(rowAfter.expires_at);
		// New expiry should be ~30 days from now, much later than 3 days
		expect(newExpiry.getTime()).toBeGreaterThan(threeDaysFromNow.getTime());
	});
});

// ─── Guard Functions ─────────────────────────────────────────────

describe('guard functions', () => {
	it('requireUser throws 401 when no user', () => {
		expect(() => requireUser({ user: null } as any)).toThrow();
	});

	it('requireUser passes when user exists', () => {
		const user = { id: 'u1', username: 'test', role: 'writer' as const };
		expect(() => requireUser({ user } as any)).not.toThrow();
	});

	it('requireArchivist throws 403 when user is writer', () => {
		const user = { id: 'u1', username: 'test', role: 'writer' as const };
		expect(() => requireArchivist({ user } as any)).toThrow();
	});

	it('requireArchivist passes when user is archivist', () => {
		const user = { id: 'u1', username: 'test', role: 'archivist' as const };
		expect(() => requireArchivist({ user } as any)).not.toThrow();
	});

	it('requireArchivist throws 401 when no user at all', () => {
		expect(() => requireArchivist({ user: null } as any)).toThrow();
	});
});

// ─── Audit Logging ──────────────────────────────────────────────

describe('audit logging', () => {
	let userId: string;

	beforeEach(() => {
		const user = seedUser(db, 'archivist');
		userId = user.id;
	});

	it('logAction creates an entry with correct shape', () => {
		logAction(db, userId, 'user.login');
		const rows = db.prepare('SELECT * FROM audit_log').all() as any[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			user_id: userId,
			action: 'user.login'
		});
		expect(rows[0].id).toBeDefined();
		expect(rows[0].created_at).toBeDefined();
	});

	it('logAction stores entity details', () => {
		logAction(db, userId, 'novel.create', 'novel', 'novel-1', 'Created "My Novel"');
		const row = db.prepare('SELECT * FROM audit_log').get() as any;
		expect(row.entity_type).toBe('novel');
		expect(row.entity_id).toBe('novel-1');
		expect(row.details).toBe('Created "My Novel"');
	});
});

// ─── User Management ────────────────────────────────────────────

describe('user management', () => {
	it('seedUser creates a user with correct role', () => {
		const user = seedUser(db, 'archivist');
		const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as any;
		expect(row.role).toBe('archivist');
		expect(row.username).toBeDefined();
		expect(row.password_hash).toBeDefined();
	});

	it('seedUser creates writer role', () => {
		const user = seedUser(db, 'writer');
		const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as any;
		expect(row.role).toBe('writer');
	});

	it('users table enforces unique username', () => {
		seedUser(db, 'archivist', 'same-name');
		expect(() => seedUser(db, 'writer', 'same-name')).toThrow();
	});

	it('users table enforces role constraint', () => {
		const now = new Date().toISOString();
		expect(() => {
			db.prepare(
				`INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			).run('bad-id', 'baduser', 'hash', 'superadmin', now, now);
		}).toThrow();
	});
});

// ─── Source-scan: Route Protection ──────────────────────────────

describe('route protection (source scan)', () => {
	const apiDir = path.resolve('src/routes/api');

	function getServerFiles(dir: string): string[] {
		const results: string[] = [];
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...getServerFiles(fullPath));
			} else if (entry.name === '+server.ts') {
				results.push(fullPath);
			}
		}
		return results;
	}

	it('every API endpoint imports requireUser or requireArchivist', () => {
		const files = getServerFiles(apiDir);
		// Exclude auth endpoints (login, setup, logout, me) — they handle auth themselves
		const nonAuthFiles = files.filter(f => !f.includes('/api/auth/'));
		expect(nonAuthFiles.length).toBeGreaterThan(0);

		const missing: string[] = [];
		for (const file of nonAuthFiles) {
			const source = fs.readFileSync(file, 'utf-8');
			if (!source.includes('requireUser') && !source.includes('requireArchivist')) {
				missing.push(path.relative(apiDir, file));
			}
		}
		expect(missing, `These API files lack auth guards: ${missing.join(', ')}`).toEqual([]);
	});

	it('import endpoints use requireUser, not requireArchivist', () => {
		const importDir = path.resolve('src/routes/api/import');
		expect(fs.existsSync(importDir), 'Import endpoints should be at /api/import/, not /api/admin/import/').toBe(true);

		const files = getServerFiles(importDir);
		expect(files.length).toBeGreaterThan(0);

		for (const file of files) {
			const source = fs.readFileSync(file, 'utf-8');
			expect(source, `${path.relative(importDir, file)} should use requireUser`).toContain('requireUser');
			expect(source, `${path.relative(importDir, file)} should NOT use requireArchivist`).not.toContain('requireArchivist');
		}
	});

	it('admin endpoints use requireArchivist', () => {
		const adminDir = path.resolve('src/routes/api/admin');
		if (!fs.existsSync(adminDir)) return; // Admin endpoints built later

		const files = getServerFiles(adminDir);
		for (const file of files) {
			const source = fs.readFileSync(file, 'utf-8');
			expect(source, `${path.relative(adminDir, file)} should use requireArchivist`).toContain('requireArchivist');
		}
	});
});

// ─── Source-scan: Session Security ──────────────────────────────

describe('session security (source scan)', () => {
	it('auth.ts uses SHA-256 for session token hashing', () => {
		const source = fs.readFileSync(path.resolve('src/lib/server/auth.ts'), 'utf-8');
		expect(source).toContain('sha256');
	});

	it('auth.ts has destroyUserSessions function', () => {
		const source = fs.readFileSync(path.resolve('src/lib/server/auth.ts'), 'utf-8');
		expect(source).toContain('destroyUserSessions');
	});

	it('user update endpoint calls destroyUserSessions on password/role change', () => {
		const file = path.resolve('src/routes/api/admin/users/[userId]/+server.ts');
		if (!fs.existsSync(file)) return; // Built in Layer 5
		const source = fs.readFileSync(file, 'utf-8');
		expect(source).toContain('destroyUserSessions');
	});

	it('last-archivist check uses a transaction', () => {
		const file = path.resolve('src/routes/api/admin/users/[userId]/+server.ts');
		if (!fs.existsSync(file)) return; // Built in Layer 5
		const source = fs.readFileSync(file, 'utf-8');
		// Should use db.transaction or .transaction(
		expect(source).toMatch(/\.transaction\s*\(/);
	});
});

// ─── Source-scan: Audit Debounce ─────────────────────────────────

describe('audit debounce (source scan)', () => {
	it('document save endpoint does NOT call logAction on every save', () => {
		const file = path.resolve('src/routes/api/documents/[id]/+server.ts');
		const source = fs.readFileSync(file, 'utf-8');
		// The autosave PUT endpoint should NOT have logAction
		// Audit logging for document changes happens on close/switch, not autosave
		// So the documents PUT handler should NOT import or call logAction
		expect(source).not.toContain('logAction');
	});
});

// ─── Schema Validation ──────────────────────────────────────────

describe('schema', () => {
	it('users table exists with correct columns', () => {
		const info = db.prepare("PRAGMA table_info('users')").all() as { name: string }[];
		const cols = info.map(c => c.name);
		expect(cols).toContain('id');
		expect(cols).toContain('username');
		expect(cols).toContain('password_hash');
		expect(cols).toContain('role');
		expect(cols).toContain('created_at');
		expect(cols).toContain('updated_at');
	});

	it('sessions table uses token_hash as primary key', () => {
		const info = db.prepare("PRAGMA table_info('sessions')").all() as { name: string; pk: number }[];
		const pkCol = info.find(c => c.pk === 1);
		expect(pkCol?.name).toBe('token_hash');
	});

	it('audit_log table exists with correct columns', () => {
		const info = db.prepare("PRAGMA table_info('audit_log')").all() as { name: string }[];
		const cols = info.map(c => c.name);
		expect(cols).toContain('id');
		expect(cols).toContain('user_id');
		expect(cols).toContain('action');
		expect(cols).toContain('entity_type');
		expect(cols).toContain('entity_id');
		expect(cols).toContain('details');
		expect(cols).toContain('created_at');
	});
});

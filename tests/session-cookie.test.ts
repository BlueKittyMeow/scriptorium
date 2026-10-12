import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers.js';
import type Database from 'better-sqlite3';
import { createSession, hashSessionToken, SESSION_COOKIE_NAME } from '$lib/server/auth.js';

let db: Database.Database;
vi.mock('$lib/server/db.js', () => ({ getDb: () => db }));
import { handle } from '../src/hooks.server.js';

beforeEach(() => { db = createTestDb(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T12:00:00Z')); });
afterEach(() => { db.close(); vi.useRealTimers(); });

async function request(token?: string, hostname = 'scriptorium.example') {
	const cookies = { get: vi.fn(() => token), set: vi.fn(), delete: vi.fn() };
	const event = { cookies, url: new URL(`https://${hostname}/api/novels`), locals: {} } as any;
	await handle({ event, resolve: async () => new Response('ok') } as any);
	return { cookies, event };
}

describe('browser and database session expiry stay aligned', () => {
	it('renews both sides when an active login nears expiry', async () => {
		const user = seedUser(db);
		const { token } = await createSession(db, user.id);
		vi.advanceTimersByTime(27 * 86400000);
		const { cookies, event } = await request(token);
		const row = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hashSessionToken(token)) as any;
		const [name, value, options] = cookies.set.mock.calls[0];
		expect(event.locals.user.id).toBe(user.id);
		expect(name).toBe(SESSION_COOKIE_NAME);
		expect(value).toBe(token);
		expect(options.expires.toISOString()).toBe(row.expires_at);
		expect(options.maxAge).toBe(30 * 86400);
		expect(options).toMatchObject({ path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
	});
	it('repairs an old browser cookie without extending a fresh database expiry again', async () => {
		const { token, expiresAt } = await createSession(db, seedUser(db).id);
		vi.advanceTimersByTime(86400000);
		const { cookies } = await request(token);
		expect(cookies.set.mock.calls[0][2].expires.toISOString()).toBe(expiresAt);
		expect(cookies.set.mock.calls[0][2].maxAge).toBe(29 * 86400);
		expect((db.prepare('SELECT expires_at FROM sessions').get() as any).expires_at).toBe(expiresAt);
	});
	it('clears an expired login instead of reviving it', async () => {
		const { token } = await createSession(db, seedUser(db).id);
		vi.advanceTimersByTime(31 * 86400000);
		const { cookies, event } = await request(token);
		expect(cookies.set).not.toHaveBeenCalled();
		expect(cookies.delete).toHaveBeenCalledWith(SESSION_COOKIE_NAME, { path: '/' });
		expect(event.locals.user).toBeNull();
	});
	it('does not create a session for an anonymous request', async () => {
		const { cookies, event } = await request();
		expect(cookies.set).not.toHaveBeenCalled();
		expect(event.locals.user).toBeNull();
	});
	it('allows development cookies only on actual loopback hostnames', async () => {
		const { token } = await createSession(db, seedUser(db).id);
		expect((await request(token, 'localhost')).cookies.set.mock.calls[0][2].secure).toBe(false);
		expect((await request(token, 'localhost.attacker.example')).cookies.set.mock.calls[0][2].secure).toBe(true);
	});
});

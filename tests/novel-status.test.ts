import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import { createTestDb, seedUser } from './helpers.js';

/**
 * Novel status is display-only today (novels.status is written at create
 * time but nothing lets a user change it afterward). This covers:
 *  - PUT /api/novels/:id validates the `status` field against the
 *    vocabulary spec.md defines for Novel (draft/revision/complete/
 *    abandoned), 400ing on anything else, following the P1-5/P1-6
 *    explicit-validation style.
 *  - POST /api/novels (create) applies the same validation, defaulting to
 *    'draft' when status is omitted.
 *  - The library card UI has a reachable, touch-safe control to change it
 *    (source-grep, per house style for client-only UI wiring).
 */

let db: Database.Database;
let userId: string;
const novelId = 'novel-1';
const now = new Date().toISOString();
const locals = () => ({ user: { id: userId, role: 'writer' }, db });

function put(id: string, body: unknown) {
	return import('../src/routes/api/novels/[id]/+server.ts').then(({ PUT }) =>
		PUT({
			params: { id },
			request: new Request(`http://test/novels/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
			locals: locals()
		} as any)
	);
}

function post(body: unknown) {
	return import('../src/routes/api/novels/+server.ts').then(({ POST }) =>
		POST({
			request: new Request('http://test/novels', { method: 'POST', body: JSON.stringify(body) }),
			locals: locals()
		} as any)
	);
}

beforeEach(() => {
	db = createTestDb();
	userId = seedUser(db, 'writer').id;
	db.prepare('INSERT INTO novels (id, title, status, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
		.run(novelId, 'Test Novel', 'draft', userId, now, now);
});

describe('PUT /api/novels/:id — status validation', () => {
	it('accepts each vocabulary status and persists it lowercased', async () => {
		for (const status of ['draft', 'revision', 'complete', 'abandoned']) {
			const res = await put(novelId, { status });
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.status).toBe(status);
		}
	});

	it('lowercases a mixed-case status', async () => {
		const res = await put(novelId, { status: 'Complete' });
		const body = await res.json();
		expect(body.status).toBe('complete');
	});

	it('rejects an unrecognized status with 400', async () => {
		await expect(put(novelId, { status: 'finished' })).rejects.toMatchObject({ status: 400 });
	});

	it('rejects a non-string status with 400', async () => {
		await expect(put(novelId, { status: 123 })).rejects.toMatchObject({ status: 400 });
	});

	it('leaves status untouched when omitted from the payload', async () => {
		await put(novelId, { title: 'Renamed' });
		const row = db.prepare('SELECT status FROM novels WHERE id = ?').get(novelId) as any;
		expect(row.status).toBe('draft');
	});

	it('does not persist a bad status before rejecting (400 happens before the write)', async () => {
		await expect(put(novelId, { status: 'bogus' })).rejects.toMatchObject({ status: 400 });
		const row = db.prepare('SELECT status FROM novels WHERE id = ?').get(novelId) as any;
		expect(row.status).toBe('draft');
	});
});

describe('POST /api/novels — status validation on create', () => {
	it('defaults to draft when status is omitted', async () => {
		const res = await post({ title: 'New Novel' });
		const body = await res.json();
		expect(body.status).toBe('draft');
	});

	it('accepts a valid non-default status at creation', async () => {
		const res = await post({ title: 'Old Draft', status: 'revision' });
		const body = await res.json();
		expect(body.status).toBe('revision');
	});

	it('rejects an unrecognized status at creation with 400', async () => {
		await expect(post({ title: 'Bad Novel', status: 'finished' })).rejects.toMatchObject({ status: 400 });
	});
});

describe('library card: status control (source-grep)', () => {
	const SOURCE = fs.readFileSync('src/routes/+page.svelte', 'utf-8');

	it('renders status as a clickable control, not a static span', () => {
		expect(SOURCE).toContain('class="status-btn"');
		expect(SOURCE).toMatch(/onclick=\{\(e\) => cycleNovelStatus\(e, novel\.id, novel\.status\)\}/);
	});

	it('prevents the card <a> from navigating when the status control is clicked', () => {
		const fnStart = SOURCE.indexOf('async function cycleNovelStatus');
		expect(fnStart).toBeGreaterThan(-1);
		const fnBody = SOURCE.slice(fnStart, fnStart + 400);
		expect(fnBody).toContain('e.preventDefault();');
	});

	it('cycles through the same status vocabulary the server enforces', () => {
		expect(SOURCE).toMatch(
			/const NOVEL_STATUSES = \[\s*'draft',\s*'revision',\s*'complete',\s*'abandoned'\s*\];/
		);
	});

	it('sends the update via PUT /api/novels/:id, same endpoint rename uses', () => {
		const fnStart = SOURCE.indexOf('async function cycleNovelStatus');
		const fnEnd = SOURCE.indexOf('</script>');
		const fnBody = SOURCE.slice(fnStart, fnEnd);
		expect(fnBody).toContain('method: \'PUT\'');
		expect(fnBody).toMatch(/fetch\(`\/api\/novels\/\$\{novelId\}`/);
	});

	it('is always visible (not hover-only), so it already works on touch per the rename-pencil fix', () => {
		const styleMatch = SOURCE.match(/<style>([\s\S]*?)<\/style>/);
		expect(styleMatch).toBeTruthy();
		const styleBlock = styleMatch![1];
		const statusBtnRules = styleBlock.match(/\.status-btn\s*\{[^}]*\}/g) || [];
		expect(statusBtnRules.length).toBeGreaterThan(0);
		for (const rule of statusBtnRules) {
			expect(rule).not.toMatch(/opacity:\s*0\b/);
		}
	});
});

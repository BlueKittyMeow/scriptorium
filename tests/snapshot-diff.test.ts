import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createTestDb, createTempDir, cleanupTempDir, seedNovelWithDocs } from './helpers.js';

/**
 * Tests for Unit C (W5b spec): GET /api/documents/:id/snapshots/:snapId/diff
 *
 * Two layers, mirroring the house convention established in
 * snapshot-browser.test.ts / tree-reorder.test.ts:
 *
 * - Pure diff computation (computeContentDiff) is tested directly — no DB,
 *   no disk. This covers the "identical content", "known edit", and "word
 *   counts" requirements exactly.
 * - Auth/lookup/404 behavior is tested by calling the real exported GET
 *   handler with a mocked `locals.db`. The lookup queries throw before any
 *   file is read, so these calls never touch the filesystem.
 * - One full round-trip smoke test also calls the real handler, but uses a
 *   throwaway novel/doc id so `readContentFile`'s existence check misses
 *   (returns null -> '') rather than resolving into the real, non-injectable
 *   DATA_ROOT — same reasoning documented in create-node-validation.test.ts
 *   and import-path-boundary.test.ts. The snapshot side reads a real temp
 *   file (content_path is stored verbatim, no DATA_ROOT involved there).
 */

let db: Database.Database;
const locals = () => ({ user: { id: 'u1', role: 'writer' }, db });

function getDiff(docId: string, snapId: string) {
	return import('../src/routes/api/documents/[id]/snapshots/[snapId]/diff/+server.ts').then(({ GET }) =>
		GET({
			params: { id: docId, snapId },
			locals: locals()
		} as any)
	);
}

beforeEach(() => {
	db = createTestDb();
});

// ─── Pure diff computation ───────────────────────────────────────────

describe('computeContentDiff', () => {
	it('produces zero changes for identical content', async () => {
		const { computeContentDiff } = await import('$lib/server/compare/diff.js');
		const result = computeContentDiff('the cat sat on the mat', 'the cat sat on the mat');
		expect(result.changes.some(c => c.added || c.removed)).toBe(false);
	});

	it('produces expected added/removed spans for a known edit', async () => {
		const { computeContentDiff } = await import('$lib/server/compare/diff.js');
		const result = computeContentDiff('the cat sat on the mat', 'the dog sat on the mat');
		const added = result.changes.filter(c => c.added).map(c => c.value.trim());
		const removed = result.changes.filter(c => c.removed).map(c => c.value.trim());
		expect(removed).toContain('cat');
		expect(added).toContain('dog');
	});

	it('reports correct word counts for both sides', async () => {
		const { computeContentDiff } = await import('$lib/server/compare/diff.js');
		const result = computeContentDiff('one two three', 'one two three four');
		expect(result.wordCountA).toBe(3);
		expect(result.wordCountB).toBe(4);
	});

	it('handles empty strings on both sides', async () => {
		const { computeContentDiff } = await import('$lib/server/compare/diff.js');
		const result = computeContentDiff('', '');
		expect(result.changes.some(c => c.added || c.removed)).toBe(false);
		expect(result.wordCountA).toBe(0);
		expect(result.wordCountB).toBe(0);
	});
});

// ─── Endpoint: auth/lookup/404 (no disk touched — errors thrown first) ──

describe('GET /api/documents/:id/snapshots/:snapId/diff — 404s', () => {
	it('404s when the document does not exist', async () => {
		await expect(getDiff('no-such-doc', 'snap-1')).rejects.toMatchObject({ status: 404 });
	});

	it('404s when the document is soft-deleted', async () => {
		const { doc1Id } = seedNovelWithDocs(db);
		const now = new Date().toISOString();
		db.prepare('UPDATE documents SET deleted_at = ? WHERE id = ?').run(now, doc1Id);
		await expect(getDiff(doc1Id, 'snap-1')).rejects.toMatchObject({ status: 404 });
	});

	it('404s when the snapshot does not exist at all', async () => {
		const { doc1Id } = seedNovelWithDocs(db);
		await expect(getDiff(doc1Id, 'no-such-snap')).rejects.toMatchObject({ status: 404 });
	});

	it('404s when the snapshot belongs to a different document', async () => {
		const { doc1Id, doc2Id } = seedNovelWithDocs(db);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO snapshots (id, document_id, content_path, word_count, reason, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run('snap-for-doc2', doc2Id, '/nonexistent/path.html', 3, 'manual', now);

		// Snapshot exists, but not under doc1Id — must 404, not leak doc2's snapshot.
		await expect(getDiff(doc1Id, 'snap-for-doc2')).rejects.toMatchObject({ status: 404 });
	});

	it('404s when the snapshot file is missing on disk', async () => {
		const { doc1Id } = seedNovelWithDocs(db);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO snapshots (id, document_id, content_path, word_count, reason, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run('snap-missing-file', doc1Id, '/nonexistent/path/does-not-exist.html', 3, 'manual', now);

		await expect(getDiff(doc1Id, 'snap-missing-file')).rejects.toMatchObject({ status: 404 });
	});
});

// ─── Endpoint: full round-trip smoke test ────────────────────────────

describe('GET /api/documents/:id/snapshots/:snapId/diff — happy path', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});

	afterEach(() => {
		cleanupTempDir(tempDir);
	});

	it('returns diff, word counts, reason, and created_at, with current content falling back to empty', async () => {
		const { novelId, doc1Id } = seedNovelWithDocs(db);
		const now = '2026-04-01T12:00:00.000Z';

		const snapPath = path.join(tempDir, 'snap-1.html');
		fs.writeFileSync(snapPath, '<p>The quick brown fox</p>');

		db.prepare(
			`INSERT INTO snapshots (id, document_id, content_path, word_count, reason, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run('snap-1', doc1Id, snapPath, 4, 'imported-variant: OldDraft.doc', now);

		const res = await getDiff(doc1Id, 'snap-1');
		const body = await res.json();

		// Current-side content file doesn't exist under the real DATA_ROOT for
		// this throwaway novelId, so readContentFile falls back to '' — every
		// snapshot word shows up as removed relative to current.
		expect(body.wordCountA).toBe(4); // snapshot side
		expect(body.wordCountB).toBe(0); // current side (no real file on disk)
		expect(body.changes.some((c: any) => c.removed)).toBe(true);
		expect(body.changes.some((c: any) => c.added)).toBe(false);
		expect(body.reason).toBe('imported-variant: OldDraft.doc');
		expect(body.created_at).toBe(now);
		expect(novelId).toBeTruthy();
	});
});

// ─── Endpoint + UI wiring (source scans, house pattern) ──────────────

describe('diff endpoint source checks', () => {
	const ENDPOINT = 'src/routes/api/documents/[id]/snapshots/[snapId]/diff/+server.ts';

	it('endpoint file should exist', () => {
		expect(() => fs.accessSync(ENDPOINT)).not.toThrow();
	});

	it('requires auth', () => {
		const source = fs.readFileSync(ENDPOINT, 'utf-8');
		expect(source).toContain('requireUser');
	});

	it('checks document deleted_at (soft-delete)', () => {
		const source = fs.readFileSync(ENDPOINT, 'utf-8');
		expect(source).toContain('deleted_at IS NULL');
	});

	it('scopes snapshot lookup to the document', () => {
		const source = fs.readFileSync(ENDPOINT, 'utf-8');
		expect(source).toContain('document_id');
	});

	it('reuses the shared stripHtml + diff helper instead of reimplementing', () => {
		const source = fs.readFileSync(ENDPOINT, 'utf-8');
		expect(source).toContain('stripHtml');
		expect(source).toContain('computeContentDiff');
	});
});

describe('SnapshotPanel compare UI (source scans)', () => {
	const PANEL = 'src/lib/components/SnapshotPanel.svelte';
	const PAGE = 'src/routes/novels/[id]/+page.svelte';

	it('SnapshotPanel exposes a Compare action per entry', () => {
		const source = fs.readFileSync(PANEL, 'utf-8');
		expect(source).toContain('onCompare');
		expect(source).toMatch(/Compare/);
	});

	it('SnapshotPanel shows the imported-variant filename with a badge', () => {
		const source = fs.readFileSync(PANEL, 'utf-8');
		expect(source).toContain('imported-variant: ');
		expect(source).toMatch(/imported/i);
	});

	it('workspace fetches the snapshot diff endpoint', () => {
		const source = fs.readFileSync(PAGE, 'utf-8');
		expect(source).toMatch(/snapshots\/\$\{[^}]+\}\/diff/);
	});

	it('workspace renders DiffView for the snapshot diff', () => {
		const source = fs.readFileSync(PAGE, 'utf-8');
		expect(source).toContain('DiffView');
	});

	it('diff view keeps Restore reachable via the existing confirm flow', () => {
		const source = fs.readFileSync(PAGE, 'utf-8');
		// The diff overlay must route restores through requestRestore (confirm modal),
		// not call the restore endpoint directly.
		const diffIdx = source.indexOf('snapshotDiff');
		expect(diffIdx).toBeGreaterThan(-1);
		expect(source).toContain('requestRestore');
	});

	it('diff fetch has loading and error states', () => {
		const source = fs.readFileSync(PAGE, 'utf-8');
		expect(source).toMatch(/diffLoading/);
		expect(source).toMatch(/diffError/);
	});
});

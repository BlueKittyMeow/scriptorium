import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createTestDb, seedUser } from './helpers.js';

/**
 * Unit B (W5b spec): POST /api/import/bundle + the underlying importer in
 * src/lib/server/import/bundle.ts.
 *
 * The importer (validateBundleManifest, importBundle) is pure w.r.t. SvelteKit
 * — it takes a db handle and a directory — so it's exercised directly here,
 * the same way importScriv is in import.test.ts / batch-import.test.ts. It
 * writes content/snapshot files to the real (non-injectable) DATA_ROOT, so
 * every novel this suite creates is torn down in afterEach.
 *
 * The route handler itself, plus the batch import_source one-liner and the
 * db.ts guarded ALTER, are covered by source-greps in the house style.
 */

const DATA_ROOT = process.env.DATA_ROOT || './data';
const FIXTURE = path.resolve('test-data/sample-bundle');

let db: Database.Database;
let tmpDir: string;
let createdIds: string[];
let owner: string;

beforeEach(() => {
	db = createTestDb();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-bundle-test-'));
	createdIds = [];
	// novels.owner_id has a FK to users(id); every real import needs a live user.
	owner = seedUser(db, 'archivist', 'Archie').id;
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	for (const id of createdIds) {
		fs.rmSync(path.join(DATA_ROOT, id), { recursive: true, force: true });
	}
});

/** Remember every novel a test creates so its on-disk data dir gets cleaned. */
function track<T extends { novel_id: string }>(reports: T[]): T[] {
	for (const r of reports) if (r.novel_id) createdIds.push(r.novel_id);
	return reports;
}

/** Write a throwaway bundle dir (bundle.json + referenced content files). */
function writeBundle(manifest: unknown, files: Record<string, string> = {}): string {
	const dir = fs.mkdtempSync(path.join(tmpDir, 'bundle-'));
	fs.writeFileSync(path.join(dir, 'bundle.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
	for (const [rel, content] of Object.entries(files)) {
		const p = path.join(dir, rel);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, content);
	}
	return dir;
}

/** Assert a synchronous call throws a SvelteKit 400. */
function expect400(fn: () => unknown): void {
	let status: number | undefined;
	try {
		fn();
	} catch (e: any) {
		status = e?.status;
	}
	expect(status).toBe(400);
}

const HTML = (word: string) => `<html><body><p>a ${word} b</p></body></html>`;

// ─── Bundle-level validation → 400 whole request ─────────────────────

describe('bundle validation (400s)', () => {
	it('400s when bundle.json is missing', async () => {
		const { importBundle } = await import('$lib/server/import/bundle.js');
		const dir = fs.mkdtempSync(path.join(tmpDir, 'nobundle-'));
		expect400(() => importBundle(db, dir, 'u1'));
	});

	it('400s when bundle.json is not valid JSON', async () => {
		const { importBundle } = await import('$lib/server/import/bundle.js');
		const dir = writeBundle('{ not valid json');
		expect400(() => importBundle(db, dir, 'u1'));
	});

	it('400s on an empty works array', async () => {
		const { importBundle } = await import('$lib/server/import/bundle.js');
		const dir = writeBundle({ version: 1, works: [] });
		expect400(() => importBundle(db, dir, 'u1'));
	});

	it('400s when a work is missing its key', async () => {
		const { importBundle } = await import('$lib/server/import/bundle.js');
		const dir = writeBundle(
			{ version: 1, works: [{ title: 'Untitled', documents: [{ key: 'd1', title: 'D', folder: null, order: 1, html: 'c/d1.html' }] }] },
			{ 'c/d1.html': HTML('one') }
		);
		expect400(() => importBundle(db, dir, 'u1'));
	});

	it('400s on duplicate work keys', async () => {
		const { importBundle } = await import('$lib/server/import/bundle.js');
		const work = (k: string) => ({ key: k, title: 'W', documents: [] as unknown[] });
		const dir = writeBundle({ version: 1, works: [work('dup'), work('dup')] });
		expect400(() => importBundle(db, dir, 'u1'));
	});

	it('400s on duplicate document keys within a work', async () => {
		const { importBundle } = await import('$lib/server/import/bundle.js');
		const dir = writeBundle(
			{
				version: 1,
				works: [{
					key: 'w', title: 'W', documents: [
						{ key: 'd1', title: 'A', folder: null, order: 1, html: 'c/a.html' },
						{ key: 'd1', title: 'B', folder: null, order: 2, html: 'c/b.html' }
					]
				}]
			},
			{ 'c/a.html': HTML('a'), 'c/b.html': HTML('b') }
		);
		expect400(() => importBundle(db, dir, 'u1'));
	});

	it('400s when an html path escapes the bundle directory', async () => {
		const { importBundle } = await import('$lib/server/import/bundle.js');
		const dir = writeBundle({
			version: 1,
			works: [{ key: 'w', title: 'W', documents: [{ key: 'd1', title: 'D', folder: null, order: 1, html: '../../etc/passwd' }] }]
		});
		expect400(() => importBundle(db, dir, 'u1'));
	});

	it('400s when an html path is absolute', async () => {
		const { importBundle } = await import('$lib/server/import/bundle.js');
		const dir = writeBundle({
			version: 1,
			works: [{ key: 'w', title: 'W', documents: [{ key: 'd1', title: 'D', folder: null, order: 1, html: '/etc/passwd' }] }]
		});
		expect400(() => importBundle(db, dir, 'u1'));
	});

	it('400s when a referenced html file does not exist', async () => {
		const { importBundle } = await import('$lib/server/import/bundle.js');
		const dir = writeBundle({
			version: 1,
			works: [{ key: 'w', title: 'W', documents: [{ key: 'd1', title: 'D', folder: null, order: 1, html: 'c/missing.html' }] }]
		});
		expect400(() => importBundle(db, dir, 'u1'));
	});

	it('400s on a non-ISO-8601 variant timestamp', async () => {
		const { importBundle } = await import('$lib/server/import/bundle.js');
		const dir = writeBundle(
			{
				version: 1,
				works: [{
					key: 'w', title: 'W', documents: [{
						key: 'd1', title: 'D', folder: null, order: 1, html: 'c/d1.html',
						variants: [{ html: 'c/v1.html', label: 'v1.doc', timestamp: 'not-a-date' }]
					}]
				}]
			},
			{ 'c/d1.html': HTML('one'), 'c/v1.html': HTML('two') }
		);
		expect400(() => importBundle(db, dir, 'u1'));
	});
});

// ─── Successful import ───────────────────────────────────────────────

describe('successful bundle import', () => {
	it('creates novel, folder, docs, FTS, and a variant snapshot honoring the source timestamp', async () => {
		const { importBundle } = await import('$lib/server/import/bundle.js');

		const results = track(importBundle(db, FIXTURE, owner));
		expect(results).toHaveLength(1);
		const r = results[0];
		expect(r.skipped).toBe(false);
		expect(r.errors).toEqual([]);
		expect(r.novel_id).toBeTruthy();
		expect(r.docs_imported).toBe(2);
		expect(r.folders_created).toBe(1);
		expect(r.variants_imported).toBe(1);
		expect(r.total_word_count).toBeGreaterThan(0);

		// Novel row: owner + import_source tagged
		const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(r.novel_id) as any;
		expect(novel.title).toBe('The Glass Almanac');
		expect(novel.owner_id).toBe(owner);
		expect(novel.import_source).toBe('bundle:work-alpha');

		// One folder
		const folders = db.prepare('SELECT * FROM folders WHERE novel_id = ?').all(r.novel_id) as any[];
		expect(folders).toHaveLength(1);
		expect(folders[0].title).toBe('Part One');

		// Two documents, in order, parented to the folder, synopsis from source_note
		const docs = db.prepare('SELECT * FROM documents WHERE novel_id = ? ORDER BY sort_order').all(r.novel_id) as any[];
		expect(docs.map((d) => d.title)).toEqual(['Opening', 'The Second Movement']);
		expect(docs[0].parent_id).toBe(folders[0].id);
		expect(docs[0].synopsis).toContain('opening.doc');
		expect(docs[0].word_count).toBeGreaterThan(0);

		// FTS is searchable on imported content
		const hit = db.prepare('SELECT doc_id FROM documents_fts WHERE documents_fts MATCH ?').get('lighthouse') as any;
		expect(hit.doc_id).toBe(docs[0].id);

		// Content files written to disk
		const contentFile = path.join(DATA_ROOT, r.novel_id, 'docs', `${docs[0].id}.html`);
		expect(fs.existsSync(contentFile)).toBe(true);
		expect(fs.readFileSync(contentFile, 'utf8')).toContain('lighthouse');

		// The variant became a snapshot of doc 2, created_at = the source timestamp (not "now")
		const d2 = docs[1];
		const snaps = db.prepare('SELECT * FROM snapshots WHERE document_id = ?').all(d2.id) as any[];
		expect(snaps).toHaveLength(1);
		expect(snaps[0].reason).toBe('imported-variant: SecondMovementMay20.doc');
		expect(snaps[0].created_at).toBe('2014-05-20T00:00:00Z');
		expect(fs.existsSync(snaps[0].content_path)).toBe(true);

		// last_snapshot_at reflects the historical variant timestamp, not import time
		expect(d2.last_snapshot_at).toBe('2014-05-20T00:00:00Z');
	});
});

// ─── Idempotency ─────────────────────────────────────────────────────

describe('idempotency', () => {
	it('skips a work whose novel was already imported', async () => {
		const { importBundle } = await import('$lib/server/import/bundle.js');
		track(importBundle(db, FIXTURE, owner));

		const second = importBundle(db, FIXTURE, owner);
		expect(second).toHaveLength(1);
		expect(second[0].skipped).toBe(true);
		expect(second[0].docs_imported).toBe(0);

		// Still only one novel for this work key
		const novels = db.prepare("SELECT id FROM novels WHERE import_source = 'bundle:work-alpha'").all();
		expect(novels).toHaveLength(1);
	});

	it('re-imports after the prior import was soft-deleted', async () => {
		const { importBundle } = await import('$lib/server/import/bundle.js');
		const first = track(importBundle(db, FIXTURE, owner));
		db.prepare('UPDATE novels SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), first[0].novel_id);

		const second = track(importBundle(db, FIXTURE, owner));
		expect(second[0].skipped).toBe(false);
		expect(second[0].novel_id).not.toBe(first[0].novel_id);
	});
});

// ─── Dry run ─────────────────────────────────────────────────────────

describe('dry run', () => {
	it('reports counts but writes nothing', async () => {
		const { importBundle } = await import('$lib/server/import/bundle.js');
		const results = importBundle(db, FIXTURE, 'u1', { dryRun: true });

		expect(results[0].docs_imported).toBe(2);
		expect(results[0].folders_created).toBe(1);
		expect(results[0].variants_imported).toBe(1);
		expect(results[0].novel_id).toBe('');

		expect(db.prepare('SELECT COUNT(*) c FROM novels').get()).toMatchObject({ c: 0 });
		expect(db.prepare('SELECT COUNT(*) c FROM documents').get()).toMatchObject({ c: 0 });
		expect(db.prepare('SELECT COUNT(*) c FROM snapshots').get()).toMatchObject({ c: 0 });
	});
});

// ─── Per-work error isolation + rollback file cleanup ────────────────

describe('per-work error isolation', () => {
	it('imports good works and reports the bad one without aborting the run', async () => {
		const { importBundle } = await import('$lib/server/import/bundle.js');
		const dir = writeBundle(
			{
				version: 1,
				works: [
					{ key: 'good', title: 'Good', documents: [{ key: 'g1', title: 'G', folder: null, order: 1, html: 'c/g.html' }] },
					{ key: 'bad', title: 'Bad', documents: [{ key: 'b1', title: 'B', folder: 'ghost', order: 1, html: 'c/b.html' }] }
				]
			},
			{ 'c/g.html': HTML('good'), 'c/b.html': HTML('bad') }
		);

		const results = track(importBundle(db, dir, owner));
		expect(results).toHaveLength(2);
		expect(results[0].skipped).toBe(false);
		expect(results[0].novel_id).toBeTruthy();
		expect(results[1].errors.length).toBeGreaterThan(0);
		expect(results[1].novel_id).toBe('');

		// Only the good novel persisted
		const novels = db.prepare('SELECT title FROM novels').all() as any[];
		expect(novels.map((n) => n.title)).toEqual(['Good']);
	});

	it('removes content files written before a mid-work rollback', async () => {
		const { importBundle } = await import('$lib/server/import/bundle.js');
		// doc1 (root) writes a content file carrying a unique marker, then doc2
		// references a missing folder and throws — the whole work rolls back and
		// its content files must be gone. (We scan only dirs that appeared during
		// this call for the marker, so unrelated parallel test files writing to
		// the shared DATA_ROOT don't confuse the assertion.)
		const MARKER = 'ROLLBACK_MARKER_a1b2c3';
		const dir = writeBundle(
			{
				version: 1,
				works: [{
					key: 'partial', title: 'Partial', documents: [
						{ key: 'p1', title: 'P1', folder: null, order: 1, html: 'c/p1.html' },
						{ key: 'p2', title: 'P2', folder: 'ghost', order: 2, html: 'c/p2.html' }
					]
				}]
			},
			{ 'c/p1.html': HTML(MARKER), 'c/p2.html': HTML('two') }
		);

		const before = new Set(fs.existsSync(DATA_ROOT) ? fs.readdirSync(DATA_ROOT) : []);
		const results = track(importBundle(db, dir, owner));
		expect(results[0].errors.length).toBeGreaterThan(0);
		expect(results[0].novel_id).toBe('');

		// No newly-appeared novel dir may still hold the rolled-back content.
		const after = fs.existsSync(DATA_ROOT) ? fs.readdirSync(DATA_ROOT) : [];
		for (const d of after.filter((x) => !before.has(x))) {
			const docsDir = path.join(DATA_ROOT, d, 'docs');
			if (!fs.existsSync(docsDir)) continue;
			for (const f of fs.readdirSync(docsDir)) {
				expect(fs.readFileSync(path.join(docsDir, f), 'utf8')).not.toContain(MARKER);
			}
		}

		expect(db.prepare('SELECT COUNT(*) c FROM novels').get()).toMatchObject({ c: 0 });
	});
});

// ─── Source-greps: endpoint, batch import_source, db migration ───────

describe('bundle endpoint (source scans)', () => {
	const ENDPOINT = 'src/routes/api/import/bundle/+server.ts';

	it('endpoint file exists', () => {
		expect(() => fs.accessSync(ENDPOINT)).not.toThrow();
	});

	it('requires auth and resolves the owner via the shared helper', () => {
		const source = fs.readFileSync(ENDPOINT, 'utf8');
		expect(source).toContain('requireUser');
		expect(source).toContain('resolveOwnerId');
	});

	it('enforces the home-directory boundary via resolveImportPath', () => {
		const source = fs.readFileSync(ENDPOINT, 'utf8');
		expect(source).toContain('resolveImportPath');
	});

	it('threads dry_run through to the importer', () => {
		const source = fs.readFileSync(ENDPOINT, 'utf8');
		expect(source).toContain('dry_run');
	});

	it('resolveOwnerId lives in a shared module reused by batch import', () => {
		const batch = fs.readFileSync('src/routes/api/import/batch/+server.ts', 'utf8');
		expect(batch).toContain('resolveOwnerId');
		// Batch no longer defines it locally — it imports it.
		expect(batch).toMatch(/import\s*\{[^}]*resolveOwnerId[^}]*\}\s*from/);
	});
});

describe('batch import sets import_source', () => {
	it('tags scriv imports with scriv:<basename>', () => {
		const source = fs.readFileSync('src/routes/api/import/batch/+server.ts', 'utf8');
		expect(source).toContain('import_source');
		expect(source).toMatch(/scriv:/);
	});
});

describe('db.ts import_source migration', () => {
	it('declares import_source in the base schema and a guarded ALTER', () => {
		const source = fs.readFileSync('src/lib/server/db.ts', 'utf8');
		expect(source).toContain('import_source');
		expect(source).toMatch(/ALTER TABLE novels ADD COLUMN import_source/);
	});
});

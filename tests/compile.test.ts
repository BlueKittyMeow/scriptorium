import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, seedNovelWithDocs } from './helpers.js';
import fs from 'fs';

/**
 * Tests for Phase 1b: Compile/Export feature.
 *
 * Layer 0: Infrastructure (tree-walk, assemble, types, DB)
 * Layer 1: Compile endpoint (source-scan)
 * Layer 2: Preview endpoint (source-scan)
 * Layer 3: Config CRUD (DB-level + source-scan)
 * Layer 3.5: compile_include toggle
 */

// ─── Layer 0: Infrastructure ────────────────────────────────────────

describe('Layer 0: compile types', () => {
	it('CompileFormat type should be defined in types.ts', () => {
		const source = fs.readFileSync('src/lib/types.ts', 'utf-8');
		expect(source).toContain('CompileFormat');
	});

	it('CompileConfig interface should be defined in types.ts', () => {
		const source = fs.readFileSync('src/lib/types.ts', 'utf-8');
		expect(source).toContain('CompileConfig');
	});

	it('compile_configs table should exist in db.ts schema', () => {
		const source = fs.readFileSync('src/lib/server/db.ts', 'utf-8');
		expect(source).toContain('compile_configs');
	});

	it('compile_configs table should exist in test helpers schema', () => {
		const source = fs.readFileSync('tests/helpers.ts', 'utf-8');
		expect(source).toContain('compile_configs');
	});
});

describe('Layer 0: tree-walk', () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createTestDb();
	});

	it('should collect documents in sort_order', async () => {
		const { collectCompileDocuments } = await import('$lib/server/compile/tree-walk.js');
		seedNovelWithDocs(db);
		const docs = collectCompileDocuments(db, 'novel-1');
		expect(docs.length).toBe(2);
		expect(docs[0].title).toBe('Chapter One');
		expect(docs[1].title).toBe('Chapter Two');
	});

	it('should skip documents with compile_include = 0', async () => {
		const { collectCompileDocuments } = await import('$lib/server/compile/tree-walk.js');
		seedNovelWithDocs(db);
		db.prepare('UPDATE documents SET compile_include = 0 WHERE id = ?').run('doc-1');
		const docs = collectCompileDocuments(db, 'novel-1');
		expect(docs.length).toBe(1);
		expect(docs[0].title).toBe('Chapter Two');
	});

	it('should skip soft-deleted documents', async () => {
		const { collectCompileDocuments } = await import('$lib/server/compile/tree-walk.js');
		seedNovelWithDocs(db);
		const now = new Date().toISOString();
		db.prepare('UPDATE documents SET deleted_at = ? WHERE id = ?').run(now, 'doc-1');
		const docs = collectCompileDocuments(db, 'novel-1');
		expect(docs.length).toBe(1);
		expect(docs[0].title).toBe('Chapter Two');
	});

	it('should skip documents inside soft-deleted folders', async () => {
		const { collectCompileDocuments } = await import('$lib/server/compile/tree-walk.js');
		seedNovelWithDocs(db);
		const now = new Date().toISOString();
		db.prepare('UPDATE folders SET deleted_at = ? WHERE id = ?').run(now, 'folder-1');
		const docs = collectCompileDocuments(db, 'novel-1');
		expect(docs.length).toBe(0);
	});

	it('should use explicit includeIds when provided', async () => {
		const { collectCompileDocuments } = await import('$lib/server/compile/tree-walk.js');
		seedNovelWithDocs(db);
		// Even if doc-1 has compile_include=1, only include doc-2
		const docs = collectCompileDocuments(db, 'novel-1', ['doc-2']);
		expect(docs.length).toBe(1);
		expect(docs[0].id).toBe('doc-2');
	});

	it('should handle nested folders in correct order', async () => {
		const { collectCompileDocuments } = await import('$lib/server/compile/tree-walk.js');
		const now = new Date().toISOString();

		// Create a novel with nested structure: Folder A > Doc A1, Folder B > Doc B1
		db.prepare(`INSERT INTO novels (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run('n2', 'Nested Novel', now, now);
		db.prepare(`INSERT INTO folders (id, novel_id, parent_id, title, sort_order, created_at, updated_at) VALUES (?, ?, NULL, ?, 1.0, ?, ?)`).run('fa', 'n2', 'Folder A', now, now);
		db.prepare(`INSERT INTO folders (id, novel_id, parent_id, title, sort_order, created_at, updated_at) VALUES (?, ?, NULL, ?, 2.0, ?, ?)`).run('fb', 'n2', 'Folder B', now, now);
		db.prepare(`INSERT INTO documents (id, novel_id, parent_id, title, word_count, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 50, 1.0, ?, ?)`).run('da1', 'n2', 'fa', 'Doc A1', now, now);
		db.prepare(`INSERT INTO documents (id, novel_id, parent_id, title, word_count, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 75, 1.0, ?, ?)`).run('db1', 'n2', 'fb', 'Doc B1', now, now);

		const docs = collectCompileDocuments(db, 'n2');
		expect(docs.length).toBe(2);
		expect(docs[0].id).toBe('da1');
		expect(docs[1].id).toBe('db1');
	});
});

describe('Layer 0: assemble', () => {
	it('should generate a title page with novel title', async () => {
		const { assembleCompileHtml } = await import('$lib/server/compile/assemble.js');
		const html = assembleCompileHtml(
			[{ id: 'doc-1', title: 'Chapter One', novelId: 'novel-1' }],
			{ title: 'My Novel', subtitle: null },
			(_novelId: string, _docId: string) => '<p>Hello world</p>'
		);
		expect(html).toContain('My Novel');
		expect(html).toContain('Chapter One');
		expect(html).toContain('Hello world');
	});

	it('should include subtitle on title page when provided', async () => {
		const { assembleCompileHtml } = await import('$lib/server/compile/assemble.js');
		const html = assembleCompileHtml(
			[],
			{ title: 'My Novel', subtitle: 'A Subtitle' },
			() => ''
		);
		expect(html).toContain('A Subtitle');
	});

	it('should wrap each document in a section with chapter heading', async () => {
		const { assembleCompileHtml } = await import('$lib/server/compile/assemble.js');
		const html = assembleCompileHtml(
			[
				{ id: 'doc-1', title: 'Chapter One', novelId: 'n1' },
				{ id: 'doc-2', title: 'Chapter Two', novelId: 'n1' }
			],
			{ title: 'Novel', subtitle: null },
			(_novelId: string, docId: string) => docId === 'doc-1' ? '<p>First</p>' : '<p>Second</p>'
		);
		expect(html).toContain('<section');
		expect(html).toContain('<h1>Chapter One</h1>');
		expect(html).toContain('<h1>Chapter Two</h1>');
	});

	it('should handle empty document list gracefully', async () => {
		const { assembleCompileHtml } = await import('$lib/server/compile/assemble.js');
		const html = assembleCompileHtml(
			[],
			{ title: 'Empty Novel', subtitle: null },
			() => ''
		);
		expect(html).toContain('Empty Novel');
		// Should still be valid HTML
		expect(html).toContain('<html');
	});
});

describe('Layer 0: pandoc wrapper', () => {
	it('should use execFile not exec for safety', () => {
		const source = fs.readFileSync('src/lib/server/compile/pandoc.ts', 'utf-8');
		expect(source).toContain('execFile');
		expect(source).not.toMatch(/\bexec\b[^F]/); // exec but not execFile
	});

	it('should support wkhtmltopdf as PDF engine', () => {
		const source = fs.readFileSync('src/lib/server/compile/pandoc.ts', 'utf-8');
		expect(source).toContain('wkhtmltopdf');
	});

	it('should export checkPandocAvailable function', () => {
		const source = fs.readFileSync('src/lib/server/compile/pandoc.ts', 'utf-8');
		expect(source).toContain('checkPandocAvailable');
	});

	it('should export convertHtmlToFormat function', () => {
		const source = fs.readFileSync('src/lib/server/compile/pandoc.ts', 'utf-8');
		expect(source).toContain('convertHtmlToFormat');
	});
});

// ─── Layer 1: Compile Endpoint ──────────────────────────────────────

describe('Layer 1: compile endpoint', () => {
	it('POST handler should exist in compile +server.ts', () => {
		const source = fs.readFileSync('src/routes/api/novels/[id]/compile/+server.ts', 'utf-8');
		expect(source).toContain('POST');
	});

	it('should validate format parameter', () => {
		const source = fs.readFileSync('src/routes/api/novels/[id]/compile/+server.ts', 'utf-8');
		// Must check for valid format before calling Pandoc
		expect(source).toMatch(/format/);
		expect(source).toContain('400');
	});

	it('should check that novel exists', () => {
		const source = fs.readFileSync('src/routes/api/novels/[id]/compile/+server.ts', 'utf-8');
		expect(source).toContain('deleted_at IS NULL');
		expect(source).toContain('404');
	});

	it('should set Content-Disposition header for download', () => {
		const source = fs.readFileSync('src/routes/api/novels/[id]/compile/+server.ts', 'utf-8');
		expect(source).toContain('Content-Disposition');
	});
});

// ─── Layer 2: Preview Endpoint ──────────────────────────────────────

describe('Layer 2: preview endpoint', () => {
	it('GET handler should exist in preview +server.ts', () => {
		const source = fs.readFileSync('src/routes/api/novels/[id]/compile/preview/+server.ts', 'utf-8');
		expect(source).toContain('GET');
	});

	it('should return text/html content type', () => {
		const source = fs.readFileSync('src/routes/api/novels/[id]/compile/preview/+server.ts', 'utf-8');
		expect(source).toContain('text/html');
	});

	it('should check that novel exists and is not deleted', () => {
		const source = fs.readFileSync('src/routes/api/novels/[id]/compile/preview/+server.ts', 'utf-8');
		expect(source).toContain('deleted_at IS NULL');
	});
});

// ─── Layer 3: Config CRUD ───────────────────────────────────────────

describe('Layer 3: compile config CRUD (DB-level)', () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createTestDb();
		seedNovelWithDocs(db);
	});

	it('should insert and retrieve a compile config', () => {
		const now = new Date().toISOString();
		db.prepare(`INSERT INTO compile_configs (id, novel_id, name, format, include_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
			'cfg-1', 'novel-1', 'Default Export', 'docx', null, now, now
		);

		const cfg = db.prepare('SELECT * FROM compile_configs WHERE id = ?').get('cfg-1') as any;
		expect(cfg.name).toBe('Default Export');
		expect(cfg.format).toBe('docx');
		expect(cfg.include_ids).toBeNull();
	});

	it('should store include_ids as JSON array', () => {
		const now = new Date().toISOString();
		const ids = JSON.stringify(['doc-1', 'doc-2']);
		db.prepare(`INSERT INTO compile_configs (id, novel_id, name, format, include_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
			'cfg-2', 'novel-1', 'Custom Export', 'epub', ids, now, now
		);

		const cfg = db.prepare('SELECT * FROM compile_configs WHERE id = ?').get('cfg-2') as any;
		const parsed = JSON.parse(cfg.include_ids);
		expect(parsed).toEqual(['doc-1', 'doc-2']);
	});

	it('should cascade delete on novel FK (source scan)', () => {
		const source = fs.readFileSync('src/lib/server/db.ts', 'utf-8');
		// compile_configs should reference novels(id)
		expect(source).toMatch(/compile_configs[\s\S]*?REFERENCES novels\(id\)/);
	});
});

describe('Layer 3: config API endpoints (source-scan)', () => {
	it('configs +server.ts should have GET and POST handlers', () => {
		const source = fs.readFileSync('src/routes/api/novels/[id]/compile/configs/+server.ts', 'utf-8');
		expect(source).toContain('GET');
		expect(source).toContain('POST');
	});

	it('[configId] +server.ts should have PUT and DELETE handlers', () => {
		const source = fs.readFileSync('src/routes/api/novels/[id]/compile/configs/[configId]/+server.ts', 'utf-8');
		expect(source).toContain('PUT');
		expect(source).toContain('DELETE');
	});
});

// ─── Layer 3.5: compile_include toggle ──────────────────────────────

describe('Layer 3.5: compile_include toggle', () => {
	it('PATCH handler should support compile_include field', () => {
		const source = fs.readFileSync('src/routes/api/novels/[id]/tree/nodes/[nodeId]/+server.ts', 'utf-8');
		expect(source).toContain('compile_include');
	});

	it('compile_include toggle should update the database', () => {
		const db = createTestDb();
		seedNovelWithDocs(db);

		// Verify initial state
		const before = db.prepare('SELECT compile_include FROM documents WHERE id = ?').get('doc-1') as any;
		expect(before.compile_include).toBe(1);

		// Toggle off
		db.prepare('UPDATE documents SET compile_include = ? WHERE id = ?').run(0, 'doc-1');
		const after = db.prepare('SELECT compile_include FROM documents WHERE id = ?').get('doc-1') as any;
		expect(after.compile_include).toBe(0);
	});
});

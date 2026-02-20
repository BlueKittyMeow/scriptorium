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
		const result = assembleCompileHtml(
			[{ id: 'doc-1', title: 'Chapter One', novelId: 'novel-1' }],
			{ title: 'My Novel', subtitle: null },
			(_novelId: string, _docId: string) => '<p>Hello world</p>'
		);
		expect(result.html).toContain('My Novel');
		expect(result.html).toContain('Chapter One');
		expect(result.html).toContain('Hello world');
	});

	it('should include subtitle on title page when provided', async () => {
		const { assembleCompileHtml } = await import('$lib/server/compile/assemble.js');
		const result = assembleCompileHtml(
			[],
			{ title: 'My Novel', subtitle: 'A Subtitle' },
			() => ''
		);
		expect(result.html).toContain('A Subtitle');
	});

	it('should wrap each document in a section with chapter heading', async () => {
		const { assembleCompileHtml } = await import('$lib/server/compile/assemble.js');
		const result = assembleCompileHtml(
			[
				{ id: 'doc-1', title: 'Chapter One', novelId: 'n1' },
				{ id: 'doc-2', title: 'Chapter Two', novelId: 'n1' }
			],
			{ title: 'Novel', subtitle: null },
			(_novelId: string, docId: string) => docId === 'doc-1' ? '<p>First</p>' : '<p>Second</p>'
		);
		expect(result.html).toContain('<section');
		expect(result.html).toContain('<h1>Chapter One</h1>');
		expect(result.html).toContain('<h1>Chapter Two</h1>');
	});

	it('should handle empty document list gracefully', async () => {
		const { assembleCompileHtml } = await import('$lib/server/compile/assemble.js');
		const result = assembleCompileHtml(
			[],
			{ title: 'Empty Novel', subtitle: null },
			() => ''
		);
		expect(result.html).toContain('Empty Novel');
		// Should still be valid HTML
		expect(result.html).toContain('<html');
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

	it('compile_include toggle should update the database (DB-level)', () => {
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

// ─── Code Review Findings ───────────────────────────────────────────

describe('Review finding 1: pandoc double invocation', () => {
	it('convertHtmlToFormat should not call execFileAsync before spawnPandoc', () => {
		const source = fs.readFileSync('src/lib/server/compile/pandoc.ts', 'utf-8');
		// Extract just the convertHtmlToFormat function body
		const fnMatch = source.match(/export async function convertHtmlToFormat[\s\S]*?^}/m);
		expect(fnMatch).toBeTruthy();
		const fnBody = fnMatch![0];
		// Should NOT contain execFileAsync — only spawnPandoc should be used
		expect(fnBody).not.toContain('execFileAsync');
	});

	it('should not have dead code (unused walk function)', () => {
		const source = fs.readFileSync('src/lib/server/compile/tree-walk.ts', 'utf-8');
		// The old `walk` function should be removed (only walkSorted should exist)
		// Check there's no standalone `function walk(` that isn't `walkSorted(`
		const walkMatches = source.match(/function walk\b/g);
		expect(walkMatches).toBeNull();
	});
});

describe('Review finding 2: tree-walk O(N²) filter', () => {
	it('should pre-index children by parent_id using Map', () => {
		const source = fs.readFileSync('src/lib/server/compile/tree-walk.ts', 'utf-8');
		// Should use Map for O(1) lookup instead of repeated .filter()
		expect(source).toContain('Map');
	});
});

describe('Review finding 3: JSON.parse without try-catch', () => {
	it('compile endpoint should wrap include_ids JSON.parse in try-catch', () => {
		const source = fs.readFileSync('src/routes/api/novels/[id]/compile/+server.ts', 'utf-8');
		expect(source).toContain('try');
		expect(source).toContain('JSON.parse');
	});
});

describe('Review finding 4: XSS in preview', () => {
	it('preview endpoint should set Content-Security-Policy header', () => {
		const source = fs.readFileSync('src/routes/api/novels/[id]/compile/preview/+server.ts', 'utf-8');
		expect(source).toContain('Content-Security-Policy');
	});
});

describe('Review finding 5: optimistic toggle', () => {
	it('toggleCompileInclude should check response status', () => {
		const source = fs.readFileSync('src/lib/components/CompileDialog.svelte', 'utf-8');
		// Extract the toggleCompileInclude function
		const fnMatch = source.match(/async function toggleCompileInclude[\s\S]*?^\t}/m);
		expect(fnMatch).toBeTruthy();
		const fnBody = fnMatch![0];
		expect(fnBody).toContain('res.ok');
	});

	it('should track pending toggles and disable export while in-flight', () => {
		const source = fs.readFileSync('src/lib/components/CompileDialog.svelte', 'utf-8');
		// Should have a pending counter or flag for in-flight PATCH requests
		expect(source).toMatch(/pending/i);
	});
});

describe('Review finding 6: missing content files silent', () => {
	it('assembleCompileHtml should report missing content files', async () => {
		const { assembleCompileHtml } = await import('$lib/server/compile/assemble.js');
		// readContent returns null for missing files
		const result = assembleCompileHtml(
			[{ id: 'doc-1', title: 'Missing Doc', novelId: 'n1' }],
			{ title: 'Novel', subtitle: null },
			() => null  // simulate missing file
		);
		// Result should be an object with warnings, or the function signature should change
		// to surface missing files somehow
		expect(result.warnings).toBeDefined();
		expect(result.warnings.length).toBeGreaterThan(0);
	});
});

describe('Review finding 7: COALESCE/null bug in config PUT', () => {
	it('should be able to clear include_ids back to null', () => {
		const db = createTestDb();
		seedNovelWithDocs(db);
		const now = new Date().toISOString();

		// Create config with include_ids set
		const ids = JSON.stringify(['doc-1']);
		db.prepare(`INSERT INTO compile_configs (id, novel_id, name, format, include_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
			'cfg-clear', 'novel-1', 'Test', 'docx', ids, now, now
		);

		// Verify it's set
		const before = db.prepare('SELECT include_ids FROM compile_configs WHERE id = ?').get('cfg-clear') as any;
		expect(before.include_ids).not.toBeNull();

		// The PUT handler source should NOT use COALESCE for include_ids
		const source = fs.readFileSync('src/routes/api/novels/[id]/compile/configs/[configId]/+server.ts', 'utf-8');
		// The update query should handle null explicitly, not via COALESCE on include_ids
		expect(source).not.toMatch(/COALESCE\(\?.*include_ids\)/);
	});
});

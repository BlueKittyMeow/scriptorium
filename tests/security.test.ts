import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers';

/**
 * Security findings from code review
 *
 * #2:  Path traversal in files.ts — IDs used directly in path.join
 * #4:  XSS via {@html result.snippet} — unsanitized snippet output
 * #7:  Documents GET/PUT ignores deleted_at — trashed docs accessible
 * #8:  Snapshot endpoints ignore deleted_at — snapshots of trashed docs accessible
 * #11: Path traversal in scriv importer — scrivId used in path.join
 */

describe('path traversal prevention (#2, #11)', () => {
	it('should export a validatePathSegment function', async () => {
		const mod = await import('$lib/server/validate');
		expect(mod.validatePathSegment).toBeTypeOf('function');
	});

	it('validatePathSegment should reject ".."', async () => {
		const { validatePathSegment } = await import('$lib/server/validate');
		expect(() => validatePathSegment('..')).toThrow();
	});

	it('validatePathSegment should reject segments containing "/"', async () => {
		const { validatePathSegment } = await import('$lib/server/validate');
		expect(() => validatePathSegment('foo/bar')).toThrow();
	});

	it('validatePathSegment should reject segments containing "\\"', async () => {
		const { validatePathSegment } = await import('$lib/server/validate');
		expect(() => validatePathSegment('foo\\bar')).toThrow();
	});

	it('validatePathSegment should reject "../etc"', async () => {
		const { validatePathSegment } = await import('$lib/server/validate');
		expect(() => validatePathSegment('../etc')).toThrow();
	});

	it('validatePathSegment should reject empty string', async () => {
		const { validatePathSegment } = await import('$lib/server/validate');
		expect(() => validatePathSegment('')).toThrow();
	});

	it('validatePathSegment should allow normal UUIDs', async () => {
		const { validatePathSegment } = await import('$lib/server/validate');
		expect(() => validatePathSegment('abc-123-def')).not.toThrow();
		expect(() => validatePathSegment('550e8400-e29b-41d4-a716-446655440000')).not.toThrow();
	});

	it('files.ts should use validatePathSegment', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/lib/server/files.ts', 'utf-8');
		expect(source).toContain('validatePathSegment');
	});

	it('scriv importer should use validatePathSegment', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/lib/server/import/scriv.ts', 'utf-8');
		expect(source).toContain('validatePathSegment');
	});
});

describe('XSS prevention in search snippets (#4)', () => {
	it('should export a sanitizeSnippet function', async () => {
		const mod = await import('$lib/server/validate');
		expect(mod.sanitizeSnippet).toBeTypeOf('function');
	});

	it('sanitizeSnippet should preserve <mark> tags', async () => {
		const { sanitizeSnippet } = await import('$lib/server/validate');
		expect(sanitizeSnippet('<mark>hello</mark> world')).toContain('<mark>hello</mark>');
	});

	it('sanitizeSnippet should strip <script> tags and encode content', async () => {
		const { sanitizeSnippet } = await import('$lib/server/validate');
		const result = sanitizeSnippet('<mark>hi</mark> <script>alert(1)</script> bye');
		expect(result).not.toContain('<script>');
		expect(result).toContain('<mark>hi</mark>');
	});

	it('sanitizeSnippet should escape <img> with event handlers', async () => {
		const { sanitizeSnippet } = await import('$lib/server/validate');
		const result = sanitizeSnippet('hello <img src=x onerror=alert(1)> world');
		// The <img> tag should be escaped so it renders as text, not live HTML
		expect(result).not.toContain('<img');
		expect(result).toContain('&lt;img');
	});

	it('search endpoint should use sanitizeSnippet', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/api/search/+server.ts', 'utf-8');
		expect(source).toContain('sanitizeSnippet');
	});
});

describe('deleted document access prevention (#7)', () => {
	it('documents GET should filter by deleted_at IS NULL', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/api/documents/[id]/+server.ts', 'utf-8');
		const getSection = source.split('export const PUT')[0];
		expect(getSection).toContain('deleted_at IS NULL');
	});

	it('documents PUT should filter by deleted_at IS NULL', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/api/documents/[id]/+server.ts', 'utf-8');
		const putSection = source.split('export const PUT')[1];
		expect(putSection).toContain('deleted_at IS NULL');
	});

	it('correct query excludes soft-deleted documents', () => {
		const db = createTestDb();
		const now = new Date().toISOString();

		db.prepare('INSERT INTO novels (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('n1', 'Test', 'draft', now, now);
		db.prepare('INSERT INTO documents (id, novel_id, title, sort_order, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('d1', 'n1', 'Deleted Doc', 1, now, now, now);

		// The correct query should exclude soft-deleted documents
		const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get('d1');
		expect(doc).toBeUndefined();
	});
});

describe('snapshot endpoint deleted_at filtering (#8)', () => {
	it('snapshot GET handler should check deleted_at IS NULL on parent document', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/api/documents/[id]/snapshots/+server.ts', 'utf-8');
		const getSection = source.split('export const POST')[0];
		expect(getSection).toContain('deleted_at IS NULL');
	});

	it('snapshot POST handler should check deleted_at IS NULL on parent document', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/api/documents/[id]/snapshots/+server.ts', 'utf-8');
		const postSection = source.split('export const POST')[1];
		expect(postSection).toContain('deleted_at IS NULL');
	});
});

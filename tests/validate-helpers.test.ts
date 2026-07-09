import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from './helpers.js';
import {
	assertValidParentFolder,
	chainContainsNode,
	normalizeOptionalString,
	assertValidDocumentContent
} from '$lib/server/validate.js';

/**
 * P1-5 / P2-5: shared tree-integrity validators (assertValidParentFolder,
 * chainContainsNode), and P2-4: document PUT payload validators
 * (normalizeOptionalString, assertValidDocumentContent).
 */

let db: Database.Database;
const novelId = 'novel-1';
const now = new Date().toISOString();

function seedFolder(id: string, parentId: string | null, deleted = false) {
	db.prepare(
		`INSERT INTO folders (id, novel_id, parent_id, title, folder_type, sort_order, created_at, updated_at, deleted_at)
		 VALUES (?, ?, ?, ?, NULL, 1.0, ?, ?, ?)`
	).run(id, novelId, parentId, `Folder ${id}`, now, now, deleted ? now : null);
}

function seedDocument(id: string, parentId: string | null) {
	db.prepare(
		`INSERT INTO documents (id, novel_id, parent_id, title, sort_order, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 1.0, ?, ?)`
	).run(id, novelId, parentId, `Doc ${id}`, now, now);
}

beforeEach(() => {
	db = createTestDb();
	db.prepare('INSERT INTO novels (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
		.run(novelId, 'Test Novel', 'draft', now, now);
});

describe('assertValidParentFolder (P1-5 / P2-5)', () => {
	it('is a no-op when parentId is null/undefined/empty', () => {
		expect(() => assertValidParentFolder(db, novelId, null)).not.toThrow();
		expect(() => assertValidParentFolder(db, novelId, undefined)).not.toThrow();
		expect(() => assertValidParentFolder(db, novelId, '')).not.toThrow();
	});

	it('does not throw for an existing, non-deleted folder in the novel', () => {
		seedFolder('f1', null);
		expect(() => assertValidParentFolder(db, novelId, 'f1')).not.toThrow();
	});

	it('throws 400 for a nonexistent parent id', () => {
		expect(() => assertValidParentFolder(db, novelId, 'bogus-id')).toThrow();
		try {
			assertValidParentFolder(db, novelId, 'bogus-id');
		} catch (e: any) {
			expect(e.status).toBe(400);
		}
	});

	it('throws 400 when the parent id refers to a document, not a folder', () => {
		seedDocument('d1', null);
		expect(() => assertValidParentFolder(db, novelId, 'd1')).toThrow();
	});

	it('throws 400 when the parent folder is soft-deleted', () => {
		seedFolder('f-trashed', null, true);
		expect(() => assertValidParentFolder(db, novelId, 'f-trashed')).toThrow();
	});

	it('throws 400 when the parent folder belongs to a different novel', () => {
		db.prepare('INSERT INTO novels (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
			.run('novel-2', 'Other Novel', 'draft', now, now);
		db.prepare(
			`INSERT INTO folders (id, novel_id, parent_id, title, folder_type, sort_order, created_at, updated_at)
			 VALUES (?, ?, NULL, ?, NULL, 1.0, ?, ?)`
		).run('f-other', 'novel-2', 'Other Folder', now, now);

		expect(() => assertValidParentFolder(db, novelId, 'f-other')).toThrow();
	});
});

describe('chainContainsNode (P1-5 cycle prevention)', () => {
	it('returns false when there is no relationship between the nodes', () => {
		seedFolder('a', null);
		seedFolder('b', null);
		expect(chainContainsNode(db, novelId, 'b', 'a')).toBe(false);
	});

	it('detects a direct cycle: moving A to be its own parent', () => {
		seedFolder('a', null);
		expect(chainContainsNode(db, novelId, 'a', 'a')).toBe(true);
	});

	it('detects a cycle when B is nested inside A and A is moved into B', () => {
		// A -> B (B's parent is A)
		seedFolder('a', null);
		seedFolder('b', 'a');
		// Attempting to move A under B should be rejected: walking up from B
		// (the proposed new parent) reaches A.
		expect(chainContainsNode(db, novelId, 'b', 'a')).toBe(true);
	});

	it('allows moving a folder under an unrelated folder', () => {
		seedFolder('a', null);
		seedFolder('b', null);
		seedFolder('c', null);
		expect(chainContainsNode(db, novelId, 'c', 'a')).toBe(false);
	});

	it('terminates even if the folder table already contains a corrupt cycle', () => {
		seedFolder('x', 'y');
		seedFolder('y', 'x');
		expect(() => chainContainsNode(db, novelId, 'x', 'z')).not.toThrow();
	});
});

describe('normalizeOptionalString (P2-4)', () => {
	it('returns null for an empty string (does not blank existing value)', () => {
		expect(normalizeOptionalString('')).toBeNull();
	});

	it('returns null for a whitespace-only string', () => {
		expect(normalizeOptionalString('   ')).toBeNull();
	});

	it('returns null for undefined', () => {
		expect(normalizeOptionalString(undefined)).toBeNull();
	});

	it('returns null for non-string values', () => {
		expect(normalizeOptionalString(42)).toBeNull();
		expect(normalizeOptionalString(null)).toBeNull();
	});

	it('returns the trimmed value for a real string', () => {
		expect(normalizeOptionalString('  New Title  ')).toBe('New Title');
	});
});

describe('assertValidDocumentContent (P2-4)', () => {
	it('returns empty string when content is omitted', () => {
		expect(assertValidDocumentContent(undefined)).toBe('');
	});

	it('returns the string unchanged when valid', () => {
		expect(assertValidDocumentContent('<p>hello</p>')).toBe('<p>hello</p>');
	});

	it('throws 400 for non-string content', () => {
		expect(() => assertValidDocumentContent(12345)).toThrow();
		try {
			assertValidDocumentContent(12345);
		} catch (e: any) {
			expect(e.status).toBe(400);
		}
	});

	it('throws 413 for content over 10MB', () => {
		const huge = 'a'.repeat(10 * 1024 * 1024 + 1);
		expect(() => assertValidDocumentContent(huge)).toThrow();
		try {
			assertValidDocumentContent(huge);
		} catch (e: any) {
			expect(e.status).toBe(413);
		}
	});

	it('accepts content right at the 10MB boundary', () => {
		const atLimit = 'a'.repeat(10 * 1024 * 1024);
		expect(() => assertValidDocumentContent(atLimit)).not.toThrow();
	});
});

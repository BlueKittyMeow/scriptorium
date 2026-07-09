import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createTestDb, createTempDir, cleanupTempDir, seedNovelWithDocs, seedUser } from './helpers.js';
import {
	purgeDocument,
	purgeFolderRecursive,
	reindexDocFts,
	hasBrokenAncestorChain,
	softDeleteNovel
} from '$lib/server/tree-ops.js';

// stripHtml equivalent to src/lib/server/files.ts (avoids importing files.js,
// which pulls in $env via db.js — same approach as tests/tree-restore.test.ts).
const stripHtml = (html: string) =>
	html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Read the on-disk route source for wiring assertions.
const ROUTES = new URL('../src/routes/', import.meta.url).pathname;
const readSrc = (rel: string) => fs.readFileSync(path.join(ROUTES, rel), 'utf-8');

let db: Database.Database;

beforeEach(() => {
	db = createTestDb();
});

// ---------------------------------------------------------------------------
// P0-2 — Purging a novel from admin trash always threw (missing .all() bind)
// ---------------------------------------------------------------------------
describe('P0-2: purge novel cascade', () => {
	it('purges all docs/snapshots/FTS for the target novel and nothing else', () => {
		const tempDir = createTempDir();
		try {
			const { novelId, folderId, doc1Id, doc2Id } = seedNovelWithDocs(db);
			// A second, untouched novel to prove isolation.
			const now = new Date().toISOString();
			db.prepare(`INSERT INTO novels (id, title, status, created_at, updated_at) VALUES ('novel-2','Other','draft',?,?)`).run(now, now);
			db.prepare(`INSERT INTO documents (id, novel_id, parent_id, title, sort_order, created_at, updated_at) VALUES ('other-doc','novel-2',NULL,'Keep',1.0,?,?)`).run(now, now);
			db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?,?,?)').run('other-doc', 'Keep', 'keep me');

			// Snapshots for novel-1 docs.
			db.prepare(`INSERT INTO snapshots (id, document_id, content_path, reason, created_at) VALUES ('snap-1',?, 'x', 'manual', ?)`).run(doc1Id, now);

			// Soft-delete the novel.
			softDeleteNovel(db, novelId, now);

			// Replicate the purge route's novel-branch transaction body.
			db.transaction(() => {
				const docs = db.prepare('SELECT id, novel_id FROM documents WHERE novel_id = ?').all(novelId) as { id: string; novel_id: string }[];
				for (const doc of docs) purgeDocument(db, tempDir, doc);
				db.prepare('DELETE FROM folders WHERE novel_id = ?').run(novelId);
				db.prepare('DELETE FROM compile_configs WHERE novel_id = ?').run(novelId);
				db.prepare('DELETE FROM novels WHERE id = ?').run(novelId);
			})();

			expect(db.prepare('SELECT COUNT(*) c FROM novels WHERE id = ?').get(novelId)).toEqual({ c: 0 });
			expect(db.prepare('SELECT COUNT(*) c FROM documents WHERE novel_id = ?').get(novelId)).toEqual({ c: 0 });
			expect(db.prepare('SELECT COUNT(*) c FROM folders WHERE novel_id = ?').get(novelId)).toEqual({ c: 0 });
			expect(db.prepare('SELECT COUNT(*) c FROM snapshots').get()).toEqual({ c: 0 });
			expect(db.prepare('SELECT COUNT(*) c FROM documents_fts WHERE doc_id IN (?,?)').get(doc1Id, doc2Id)).toEqual({ c: 0 });
			// Other novel untouched.
			expect(db.prepare('SELECT COUNT(*) c FROM documents WHERE novel_id = ?').get('novel-2')).toEqual({ c: 1 });
			expect(db.prepare('SELECT COUNT(*) c FROM documents_fts WHERE doc_id = ?').get('other-doc')).toEqual({ c: 1 });
			expect(folderId).toBeTruthy();
		} finally {
			cleanupTempDir(tempDir);
		}
	});

	it('route wiring: documents SELECT is bound with the novel id (not a bare .all())', () => {
		const src = readSrc('api/admin/trash/[type]/[id]/purge/+server.ts');
		// The regression: SELECT ... FROM documents WHERE novel_id = ? called with no bind arg.
		expect(src).toMatch(/SELECT id, novel_id FROM documents WHERE novel_id = \?'\)\.all\(id\)/);
		expect(src).not.toMatch(/FROM documents WHERE novel_id = \?'\)\.all\(\)/);
	});
});

// ---------------------------------------------------------------------------
// P0-3 — Deleting a user with audit_log rows failed the FK constraint
// ---------------------------------------------------------------------------
describe('P0-3: delete user with audit history', () => {
	it('naive delete throws FK; NULL-then-delete succeeds and preserves audit rows', () => {
		const archivist = seedUser(db, 'archivist');
		const writer = seedUser(db, 'writer');
		const now = new Date().toISOString();

		// Writer has an audit row (e.g. a login) and a session.
		db.prepare(`INSERT INTO audit_log (id, user_id, action, created_at) VALUES (?,?,?,?)`).run(crypto.randomUUID(), writer.id, 'user.login', now);
		db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ('tok',?,?,?)`).run(writer.id, now, now);

		// Demonstrate the bug: deleting the user directly violates the FK.
		expect(() => db.prepare('DELETE FROM users WHERE id = ?').run(writer.id)).toThrow(/FOREIGN KEY/i);

		// The fix (delete route transaction body).
		db.transaction(() => {
			db.prepare(`INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, details, created_at) VALUES (?,?,?,?,?,?,?)`)
				.run(crypto.randomUUID(), archivist.id, 'user.delete', 'user', writer.id, `Deleted "${writer.username}"`, now);
			db.prepare('UPDATE audit_log SET user_id = NULL WHERE user_id = ?').run(writer.id);
			db.prepare('DELETE FROM sessions WHERE user_id = ?').run(writer.id);
			db.prepare('DELETE FROM users WHERE id = ?').run(writer.id);
		})();

		expect(db.prepare('SELECT COUNT(*) c FROM users WHERE id = ?').get(writer.id)).toEqual({ c: 0 });
		// The login row survives, detached.
		const login = db.prepare("SELECT user_id FROM audit_log WHERE action = 'user.login'").get() as { user_id: string | null };
		expect(login.user_id).toBeNull();
		// The deletion is attributed to the acting archivist and names the user.
		const del = db.prepare("SELECT user_id, details FROM audit_log WHERE action = 'user.delete'").get() as { user_id: string; details: string };
		expect(del.user_id).toBe(archivist.id);
		expect(del.details).toContain(writer.username);
	});

	it('route wiring: DELETE nulls audit rows and logs user.delete before removing the user', () => {
		const src = readSrc('api/admin/users/[userId]/+server.ts');
		expect(src).toMatch(/UPDATE audit_log SET user_id = NULL WHERE user_id = \?/);
		expect(src).toMatch(/logAction\([^)]*'user\.delete'/);
	});
});

// ---------------------------------------------------------------------------
// P1-1 — Restoring a novel from trash must cascade-restore its children
// ---------------------------------------------------------------------------
describe('P1-1: timestamp-matched novel restore cascade', () => {
	it('restores children trashed by the novel deletion, leaves earlier-trashed items alone', () => {
		const { novelId, folderId, doc1Id, doc2Id } = seedNovelWithDocs(db);

		// doc-1 individually trashed earlier (t1).
		const t1 = '2026-01-01T00:00:00.000Z';
		db.prepare('UPDATE documents SET deleted_at = ? WHERE id = ?').run(t1, doc1Id);
		db.prepare('DELETE FROM documents_fts WHERE doc_id = ?').run(doc1Id);

		// Novel soft-deleted later (t2) — cascades to folder + doc-2 only.
		const t2 = '2026-02-02T00:00:00.000Z';
		softDeleteNovel(db, novelId, t2);
		// sanity: doc-1 kept its own t1, doc-2 + folder got t2.
		expect((db.prepare('SELECT deleted_at FROM documents WHERE id = ?').get(doc1Id) as any).deleted_at).toBe(t1);
		expect((db.prepare('SELECT deleted_at FROM documents WHERE id = ?').get(doc2Id) as any).deleted_at).toBe(t2);

		// Replicate the restore route's novel-branch transaction body.
		const now = new Date().toISOString();
		const novelDeletedAt = (db.prepare('SELECT deleted_at FROM novels WHERE id = ?').get(novelId) as any).deleted_at;
		db.transaction(() => {
			db.prepare('UPDATE novels SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, novelId);
			db.prepare('UPDATE folders SET deleted_at = NULL, updated_at = ? WHERE novel_id = ? AND deleted_at = ?').run(now, novelId, novelDeletedAt);
			const restoredDocs = db.prepare('SELECT id, title, novel_id FROM documents WHERE novel_id = ? AND deleted_at = ?').all(novelId, novelDeletedAt) as any[];
			db.prepare('UPDATE documents SET deleted_at = NULL, updated_at = ? WHERE novel_id = ? AND deleted_at = ?').run(now, novelId, novelDeletedAt);
			for (const doc of restoredDocs) reindexDocFts(db, doc, () => '<p>body</p>', stripHtml);
		})();

		// Folder + doc-2 restored & indexed; doc-1 still trashed.
		expect((db.prepare('SELECT deleted_at FROM folders WHERE id = ?').get(folderId) as any).deleted_at).toBeNull();
		expect((db.prepare('SELECT deleted_at FROM documents WHERE id = ?').get(doc2Id) as any).deleted_at).toBeNull();
		expect((db.prepare('SELECT deleted_at FROM documents WHERE id = ?').get(doc1Id) as any).deleted_at).toBe(t1);
		expect(db.prepare('SELECT COUNT(*) c FROM documents_fts WHERE doc_id = ?').get(doc2Id)).toEqual({ c: 1 });
		expect(db.prepare('SELECT COUNT(*) c FROM documents_fts WHERE doc_id = ?').get(doc1Id)).toEqual({ c: 0 });
	});

	it('route wiring: novel restore matches on the novel deleted_at timestamp', () => {
		const src = readSrc('api/admin/trash/[type]/[id]/restore/+server.ts');
		expect(src).toMatch(/UPDATE folders SET deleted_at = NULL[^;]*novel_id = \? AND deleted_at = \?/);
		expect(src).toMatch(/UPDATE documents SET deleted_at = NULL[^;]*novel_id = \? AND deleted_at = \?/);
		expect(src).toMatch(/reindexDocFts/);
	});
});

// ---------------------------------------------------------------------------
// P1-2 — Admin doc restore: DATA_ROOT-aware, strips HTML, delete-first FTS
// ---------------------------------------------------------------------------
describe('P1-2: admin document restore FTS re-index', () => {
	it('indexes stripped text and keeps exactly one FTS row across restore cycles', () => {
		const { doc1Id } = seedNovelWithDocs(db);
		const doc = { id: doc1Id, title: 'Chapter One', novel_id: 'novel-1' };
		const read = () => '<p>hello world</p>';

		// Two restore cycles.
		reindexDocFts(db, doc, read, stripHtml);
		reindexDocFts(db, doc, read, stripHtml);

		const rows = db.prepare('SELECT content FROM documents_fts WHERE doc_id = ?').all(doc1Id) as { content: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0].content).toBe('hello world'); // stripped, not raw <p>…</p>
	});

	it('route wiring: uses reindexDocFts + readContentFile, no hardcoded data/ path', () => {
		const src = readSrc('api/admin/trash/[type]/[id]/restore/+server.ts');
		expect(src).toMatch(/reindexDocFts/);
		expect(src).toMatch(/readContentFile/);
		expect(src).toMatch(/stripHtml/);
		expect(src).not.toMatch(/`data\/\$\{/); // the old hardcoded relative path
	});
});

// ---------------------------------------------------------------------------
// P1-3 — Restored item under a still-deleted ancestor must re-root
// ---------------------------------------------------------------------------
describe('P1-3: re-root when ancestor still trashed', () => {
	it('hasBrokenAncestorChain detects deleted/missing ancestors', () => {
		const { novelId, folderId, doc1Id } = seedNovelWithDocs(db);
		// Intact chain: doc-1 under live folder-1.
		expect(hasBrokenAncestorChain(db, folderId)).toBe(false);
		expect(hasBrokenAncestorChain(db, null)).toBe(false);
		// Trash the folder → chain broken.
		db.prepare('UPDATE folders SET deleted_at = ? WHERE id = ?').run('2026-03-03T00:00:00.000Z', folderId);
		expect(hasBrokenAncestorChain(db, folderId)).toBe(true);
		// Missing ancestor → broken.
		expect(hasBrokenAncestorChain(db, 'no-such-folder')).toBe(true);
		expect(novelId && doc1Id).toBeTruthy();
	});

	it('folder-then-child restore re-roots the child (parent_id NULL, reachable)', () => {
		const { folderId, doc1Id } = seedNovelWithDocs(db);
		const now = new Date().toISOString();

		// Trash folder F (cascades to doc D).
		db.prepare('UPDATE folders SET deleted_at = ? WHERE id = ?').run(now, folderId);
		db.prepare('UPDATE documents SET deleted_at = ? WHERE id = ?').run(now, doc1Id);
		db.prepare('DELETE FROM documents_fts WHERE doc_id = ?').run(doc1Id);

		// Restore D only (replicate document restore branch logic).
		const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(doc1Id) as any;
		db.prepare('UPDATE documents SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, doc1Id);
		reindexDocFts(db, doc, () => '', stripHtml);
		if (hasBrokenAncestorChain(db, doc.parent_id)) {
			db.prepare('UPDATE documents SET parent_id = NULL, updated_at = ? WHERE id = ?').run(now, doc1Id);
		}

		const restored = db.prepare('SELECT parent_id, deleted_at FROM documents WHERE id = ?').get(doc1Id) as any;
		expect(restored.deleted_at).toBeNull();
		expect(restored.parent_id).toBeNull(); // re-rooted, not orphaned under trashed F
	});

	it('route wiring: both restore endpoints re-root via hasBrokenAncestorChain', () => {
		const admin = readSrc('api/admin/trash/[type]/[id]/restore/+server.ts');
		const workspace = readSrc('api/novels/[id]/tree/nodes/[nodeId]/+server.ts');
		for (const src of [admin, workspace]) {
			expect(src).toMatch(/hasBrokenAncestorChain/);
			expect(src).toMatch(/SET parent_id = NULL/);
		}
	});
});

// ---------------------------------------------------------------------------
// P1-4 — Purging a folder must recurse and clean up files/rows
// ---------------------------------------------------------------------------
describe('P1-4: recursive folder purge', () => {
	let tempDir: string;
	beforeEach(() => { tempDir = createTempDir(); });
	afterEach(() => { cleanupTempDir(tempDir); });

	it('purges folder → subfolder → doc, removing all rows and files', () => {
		const now = new Date().toISOString();
		const novelId = 'novel-1';
		const folderId = 'f-top';
		const subId = 'f-sub';
		const docId = 'd-1';
		const snapId = 's-1';

		db.prepare(`INSERT INTO novels (id, title, status, created_at, updated_at) VALUES (?,?, 'draft', ?, ?)`).run(novelId, 'N', now, now);
		db.prepare(`INSERT INTO folders (id, novel_id, parent_id, title, sort_order, created_at, updated_at, deleted_at) VALUES (?,?,NULL,'Top',1.0,?,?,?)`).run(folderId, novelId, now, now, now);
		db.prepare(`INSERT INTO folders (id, novel_id, parent_id, title, sort_order, created_at, updated_at, deleted_at) VALUES (?,?,?,'Sub',1.0,?,?,?)`).run(subId, novelId, folderId, now, now, now);
		db.prepare(`INSERT INTO documents (id, novel_id, parent_id, title, sort_order, created_at, updated_at, deleted_at) VALUES (?,?,?,'Doc',1.0,?,?,?)`).run(docId, novelId, subId, now, now, now);
		db.prepare(`INSERT INTO snapshots (id, document_id, content_path, reason, created_at) VALUES (?,?, 'p', 'manual', ?)`).run(snapId, docId, now);
		db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?,?,?)').run(docId, 'Doc', 'text');

		// Write the real files the purge should remove.
		const docFile = path.join(tempDir, novelId, 'docs', `${docId}.html`);
		fs.mkdirSync(path.dirname(docFile), { recursive: true });
		fs.writeFileSync(docFile, '<p>x</p>');
		const snapFile = path.join(tempDir, novelId, 'snapshots', docId, `${snapId}.html`);
		fs.mkdirSync(path.dirname(snapFile), { recursive: true });
		fs.writeFileSync(snapFile, '<p>old</p>');

		db.transaction(() => purgeFolderRecursive(db, tempDir, folderId))();

		expect(db.prepare('SELECT COUNT(*) c FROM folders WHERE id IN (?,?)').get(folderId, subId)).toEqual({ c: 0 });
		expect(db.prepare('SELECT COUNT(*) c FROM documents WHERE id = ?').get(docId)).toEqual({ c: 0 });
		expect(db.prepare('SELECT COUNT(*) c FROM snapshots WHERE document_id = ?').get(docId)).toEqual({ c: 0 });
		expect(db.prepare('SELECT COUNT(*) c FROM documents_fts WHERE doc_id = ?').get(docId)).toEqual({ c: 0 });
		expect(fs.existsSync(docFile)).toBe(false);
		expect(fs.existsSync(path.join(tempDir, novelId, 'snapshots', docId))).toBe(false);
	});

	it('route wiring: folder purge uses purgeFolderRecursive', () => {
		const src = readSrc('api/admin/trash/[type]/[id]/purge/+server.ts');
		expect(src).toMatch(/purgeFolderRecursive/);
		expect(src).toMatch(/purgeDocument/);
	});
});

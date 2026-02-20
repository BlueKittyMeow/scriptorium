import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, seedNovelWithDocs, createTempDir, cleanupTempDir } from './helpers.js';
import fs from 'fs';
import path from 'path';

/**
 * Tests for the Phase 1a Snapshot Browser feature.
 *
 * Layer 0: Bug fixes to existing snapshot infrastructure
 * Layer 1: Restore endpoint
 * Layers 2-4: UI components (source scanning)
 */

// ─── Layer 0: Existing Bug Fixes ─────────────────────────────────────

describe('Layer 0: existing snapshot bug fixes', () => {
	it('0a: snapshot content endpoint should check document deleted_at', async () => {
		const source = fs.readFileSync('src/routes/api/documents/[id]/snapshots/[snapId]/+server.ts', 'utf-8');
		// Must verify the parent document is not soft-deleted before returning snapshot content
		expect(source).toContain('deleted_at IS NULL');
	});

	it('0b: manual snapshot POST should wrap DB ops in a transaction', async () => {
		const source = fs.readFileSync('src/routes/api/documents/[id]/snapshots/+server.ts', 'utf-8');
		// The POST handler does INSERT + UPDATE — must be transactional
		expect(source).toContain('.transaction(');
	});

	it('0c: snapshot list should have secondary sort key for deterministic ordering', async () => {
		const source = fs.readFileSync('src/routes/api/documents/[id]/snapshots/+server.ts', 'utf-8');
		// ORDER BY created_at DESC alone is non-deterministic on timestamp collision
		expect(source).toContain('id DESC');
	});

	it('0d: snapshot filenames should use UUID, not timestamp', async () => {
		const source = fs.readFileSync('src/lib/server/files.ts', 'utf-8');
		// snapshotPath parameter should not be named "timestamp"
		expect(source).not.toMatch(/function snapshotPath\([^)]*timestamp/);
	});

	it('0d: autosave snapshot should pass UUID not timestamp to writeSnapshotFile', async () => {
		const source = fs.readFileSync('src/routes/api/documents/[id]/+server.ts', 'utf-8');
		// Should NOT use now.replace(/[:.]/g, '-') for snapshot filenames
		expect(source).not.toContain("now.replace(/[:.]/g, '-')");
	});

	it('0d: manual snapshot should pass UUID not timestamp to writeSnapshotFile', async () => {
		const source = fs.readFileSync('src/routes/api/documents/[id]/snapshots/+server.ts', 'utf-8');
		// Should NOT use now.replace(/[:.]/g, '-') for snapshot filenames
		expect(source).not.toContain("now.replace(/[:.]/g, '-')");
	});

	it('0e: SnapshotSummary type should exist in types.ts', async () => {
		const source = fs.readFileSync('src/lib/types.ts', 'utf-8');
		expect(source).toContain('SnapshotSummary');
	});

	it('0e: SnapshotSummary should NOT include content_path', async () => {
		const source = fs.readFileSync('src/lib/types.ts', 'utf-8');
		// Extract the SnapshotSummary interface body
		const match = source.match(/interface SnapshotSummary\s*\{([^}]+)\}/);
		expect(match).toBeTruthy();
		expect(match![1]).not.toContain('content_path');
	});

	it('0: snapshot list endpoint should support pagination via limit/offset', async () => {
		const source = fs.readFileSync('src/routes/api/documents/[id]/snapshots/+server.ts', 'utf-8');
		expect(source).toContain('LIMIT');
		expect(source).toContain('offset');
	});
});

// ─── Layer 1: Restore Endpoint ───────────────────────────────────────

describe('Layer 1: restore endpoint', () => {
	it('restore endpoint file should exist', () => {
		expect(() => {
			fs.accessSync('src/routes/api/documents/[id]/restore/[snapshotId]/+server.ts');
		}).not.toThrow();
	});

	it('restore should check document deleted_at IS NULL', async () => {
		const source = fs.readFileSync('src/routes/api/documents/[id]/restore/[snapshotId]/+server.ts', 'utf-8');
		expect(source).toContain('deleted_at IS NULL');
	});

	it('restore should validate snapshot belongs to document', async () => {
		const source = fs.readFileSync('src/routes/api/documents/[id]/restore/[snapshotId]/+server.ts', 'utf-8');
		expect(source).toContain('document_id');
	});

	it('restore should use a DB transaction', async () => {
		const source = fs.readFileSync('src/routes/api/documents/[id]/restore/[snapshotId]/+server.ts', 'utf-8');
		expect(source).toContain('.transaction(');
	});

	it('restore should create a pre-restore snapshot', async () => {
		const source = fs.readFileSync('src/routes/api/documents/[id]/restore/[snapshotId]/+server.ts', 'utf-8');
		expect(source).toContain('pre-restore');
	});

	it('restore should update FTS index', async () => {
		const source = fs.readFileSync('src/routes/api/documents/[id]/restore/[snapshotId]/+server.ts', 'utf-8');
		expect(source).toContain('documents_fts');
	});
});

describe('Layer 1: restore transaction logic (DB-level)', () => {
	let db: Database.Database;
	let novelId: string;
	let doc1Id: string;
	let tempDir: string;

	beforeEach(() => {
		db = createTestDb();
		({ novelId, doc1Id } = seedNovelWithDocs(db));
		tempDir = createTempDir();

		// Create document content file
		const docDir = path.join(tempDir, novelId, 'docs');
		fs.mkdirSync(docDir, { recursive: true });
		fs.writeFileSync(path.join(docDir, `${doc1Id}.html`), '<p>Current content with five words</p>');

		// Create a snapshot entry + file
		const snapDir = path.join(tempDir, novelId, 'snapshots', doc1Id);
		fs.mkdirSync(snapDir, { recursive: true });
		fs.writeFileSync(path.join(snapDir, 'snap-1.html'), '<p>Old snapshot content here</p>');

		db.prepare(`
			INSERT INTO snapshots (id, document_id, content_path, word_count, reason, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run('snap-1', doc1Id, path.join(snapDir, 'snap-1.html'), 4, 'autosave', '2026-02-19T10:00:00.000Z');
	});

	it('restore transaction should insert pre-restore snapshot row', () => {
		const now = '2026-02-20T12:00:00.000Z';
		const preRestoreId = 'pre-restore-snap-1';
		const preRestorePath = path.join(tempDir, novelId, 'snapshots', doc1Id, `${preRestoreId}.html`);

		// Write pre-restore file
		fs.writeFileSync(preRestorePath, '<p>Current content with five words</p>');

		// Run the restore transaction
		const doRestore = db.transaction(() => {
			// Insert pre-restore snapshot
			db.prepare(`
				INSERT INTO snapshots (id, document_id, content_path, word_count, reason, created_at)
				VALUES (?, ?, ?, ?, ?, ?)
			`).run(preRestoreId, doc1Id, preRestorePath, 5, 'pre-restore', now);

			// Update document metadata
			db.prepare(`
				UPDATE documents SET word_count = ?, updated_at = ?, last_snapshot_at = ? WHERE id = ?
			`).run(4, now, now, doc1Id);

			// Update FTS
			db.prepare('DELETE FROM documents_fts WHERE doc_id = ?').run(doc1Id);
			db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(
				doc1Id, 'Chapter One', 'Old snapshot content here'
			);
		});
		doRestore();

		// Verify pre-restore snapshot exists
		const preSnap = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(preRestoreId) as any;
		expect(preSnap).toBeTruthy();
		expect(preSnap.reason).toBe('pre-restore');
		expect(preSnap.document_id).toBe(doc1Id);
	});

	it('restore transaction should update document word_count', () => {
		const now = '2026-02-20T12:00:00.000Z';

		const doRestore = db.transaction(() => {
			db.prepare(`
				INSERT INTO snapshots (id, document_id, content_path, word_count, reason, created_at)
				VALUES (?, ?, ?, ?, ?, ?)
			`).run('pre-snap', doc1Id, '/tmp/fake.html', 5, 'pre-restore', now);

			db.prepare(`
				UPDATE documents SET word_count = ?, updated_at = ?, last_snapshot_at = ? WHERE id = ?
			`).run(4, now, now, doc1Id);
		});
		doRestore();

		const doc = db.prepare('SELECT word_count FROM documents WHERE id = ?').get(doc1Id) as any;
		expect(doc.word_count).toBe(4);
	});

	it('restore transaction should update FTS index with restored content', () => {
		const now = '2026-02-20T12:00:00.000Z';

		const doRestore = db.transaction(() => {
			db.prepare(`
				INSERT INTO snapshots (id, document_id, content_path, word_count, reason, created_at)
				VALUES (?, ?, ?, ?, ?, ?)
			`).run('pre-snap', doc1Id, '/tmp/fake.html', 5, 'pre-restore', now);

			db.prepare(`
				UPDATE documents SET word_count = ?, updated_at = ?, last_snapshot_at = ? WHERE id = ?
			`).run(4, now, now, doc1Id);

			db.prepare('DELETE FROM documents_fts WHERE doc_id = ?').run(doc1Id);
			db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(
				doc1Id, 'Chapter One', 'Old snapshot content here'
			);
		});
		doRestore();

		// FTS should now contain the restored content
		const fts = db.prepare("SELECT * FROM documents_fts WHERE doc_id = ? AND content MATCH '\"old snapshot\"'").all(doc1Id);
		expect(fts.length).toBeGreaterThan(0);
	});

	it('should reject restore for soft-deleted documents', () => {
		const now = '2026-02-20T12:00:00.000Z';
		db.prepare('UPDATE documents SET deleted_at = ? WHERE id = ?').run(now, doc1Id);

		const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(doc1Id);
		expect(doc).toBeUndefined();
	});

	it('should reject restore for snapshot belonging to different document', () => {
		const snap = db.prepare('SELECT * FROM snapshots WHERE id = ? AND document_id = ?').get('snap-1', 'wrong-doc-id');
		expect(snap).toBeUndefined();
	});

	afterEach(() => {
		cleanupTempDir(tempDir);
	});
});

// ─── Layers 2-4: UI Components (Source Scanning) ────────────────────

describe('Layer 2: SnapshotPanel component', () => {
	it('SnapshotPanel component file should exist', () => {
		expect(() => {
			fs.accessSync('src/lib/components/SnapshotPanel.svelte');
		}).not.toThrow();
	});

	it('SnapshotPanel should group snapshots (has day grouping logic)', async () => {
		const source = fs.readFileSync('src/lib/components/SnapshotPanel.svelte', 'utf-8');
		expect(source).toContain('Today');
		expect(source).toContain('Yesterday');
	});
});

describe('Layer 2: SnapshotPreview component', () => {
	it('SnapshotPreview component file should exist', () => {
		expect(() => {
			fs.accessSync('src/lib/components/SnapshotPreview.svelte');
		}).not.toThrow();
	});

	it('SnapshotPreview should use TipTap in read-only mode', async () => {
		const source = fs.readFileSync('src/lib/components/SnapshotPreview.svelte', 'utf-8');
		expect(source).toContain('editable: false');
	});
});

describe('Layer 3: editor integration', () => {
	it('Editor should hide with CSS during preview, not be destroyed by {#if}', async () => {
		const source = fs.readFileSync('src/routes/novels/[id]/+page.svelte', 'utf-8');
		// The editor container should use class:hidden to toggle visibility
		expect(source).toContain('class:hidden');
	});

	it('Editor should accept onSnapshotsToggle prop', async () => {
		const source = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');
		expect(source).toContain('onSnapshotsToggle');
	});

	it('Editor should have a snapshots toggle button in footer', async () => {
		const source = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');
		expect(source).toContain('Snapshots');
	});

	it('restore confirmation modal should have aria-modal', async () => {
		const source = fs.readFileSync('src/routes/novels/[id]/+page.svelte', 'utf-8');
		// Should have at least 2 aria-modal: new item modal + restore confirmation
		const count = (source.match(/aria-modal="true"/g) || []).length;
		expect(count).toBeGreaterThanOrEqual(2);
	});
});

describe('Layer 4: manual snapshot', () => {
	it('Editor should accept onManualSnapshot prop', async () => {
		const source = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');
		expect(source).toContain('onManualSnapshot');
	});

	it('Editor should have a manual snapshot button', async () => {
		const source = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');
		// Should have a button that triggers manual snapshot creation
		expect(source).toContain('onManualSnapshot');
		// The button should be in the footer or toolbar area
		expect(source).toMatch(/snapshot/i);
	});
});

// ─── Code Review Findings ────────────────────────────────────────────

describe('Review finding 1: SnapshotPreview keyed re-render', () => {
	it('SnapshotPreview should be wrapped in {#key} to re-mount on snapshot switch', () => {
		const source = fs.readFileSync('src/routes/novels/[id]/+page.svelte', 'utf-8');
		// Without {#key}, switching between snapshots leaves stale TipTap content
		expect(source).toMatch(/{#key[\s\S]*?SnapshotPreview/);
	});
});

describe('Review finding 2: no unused onRestore prop', () => {
	it('SnapshotPanel should not declare an unused onRestore prop', () => {
		const source = fs.readFileSync('src/lib/components/SnapshotPanel.svelte', 'utf-8');
		expect(source).not.toContain('onRestore');
	});

	it('workspace should not pass onRestore to SnapshotPanel', () => {
		const source = fs.readFileSync('src/routes/novels/[id]/+page.svelte', 'utf-8');
		const panelMatch = source.match(/<SnapshotPanel[\s\S]*?\/>/);
		expect(panelMatch).toBeTruthy();
		expect(panelMatch![0]).not.toContain('onRestore');
	});
});

describe('Review finding 3: restore file write ordering', () => {
	it('restore endpoint should write document file AFTER the DB transaction', () => {
		const source = fs.readFileSync('src/routes/api/documents/[id]/restore/[snapshotId]/+server.ts', 'utf-8');
		const doRestoreCallIdx = source.indexOf('doRestore()');
		const writeContentIdx = source.lastIndexOf('writeContentFile');
		// Document file must not be overwritten until transaction succeeds
		expect(doRestoreCallIdx).toBeGreaterThan(-1);
		expect(writeContentIdx).toBeGreaterThan(doRestoreCallIdx);
	});
});

describe('Review finding 4: error handling in snapshot operations', () => {
	it('previewSnapshot should check response status', () => {
		const source = fs.readFileSync('src/routes/novels/[id]/+page.svelte', 'utf-8');
		const start = source.indexOf('async function previewSnapshot');
		const end = source.indexOf('\n\t}', start);
		const funcBody = source.slice(start, end);
		expect(funcBody).toMatch(/!res\.ok/);
	});

	it('handleManualSnapshot should check response status', () => {
		const source = fs.readFileSync('src/routes/novels/[id]/+page.svelte', 'utf-8');
		const start = source.indexOf('async function handleManualSnapshot');
		const end = source.indexOf('\n\t}', start);
		const funcBody = source.slice(start, end);
		expect(funcBody).toMatch(/!res\.ok/);
	});
});

describe('Review finding 5: word count performance', () => {
	it('onTransaction should not call expensive full-document word count', () => {
		const source = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');
		const start = source.indexOf('onTransaction:');
		const end = source.indexOf('}', start);
		const handler = source.slice(start, end);
		// Should not call updateWordCount (which iterates entire document via getText)
		expect(handler).not.toContain('updateWordCount');
	});

	it('Editor should have a selection-only word count update function', () => {
		const source = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');
		expect(source).toContain('updateSelectionWordCount');
	});
});

describe('Review finding 6: indexOf optimization in SnapshotPanel', () => {
	it('SnapshotPanel should not use indexOf for global index lookup', () => {
		const source = fs.readFileSync('src/lib/components/SnapshotPanel.svelte', 'utf-8');
		expect(source).not.toContain('.indexOf(');
	});
});

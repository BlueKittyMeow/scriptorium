import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { v4 as uuid } from 'uuid';
import { readContentFile, writeContentFile, writeSnapshotFile, stripHtml, countWords } from '$lib/server/files.js';

// GET /api/documents/:id — metadata + content
export const GET: RequestHandler = async ({ params, locals }) => {
	const doc = locals.db.prepare('SELECT * FROM documents WHERE id = ?').get(params.id) as any;
	if (!doc) throw error(404, 'Document not found');

	const content = readContentFile(doc.novel_id, doc.id) || '';
	return json({ ...doc, content });
};

// PUT /api/documents/:id — save content
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const body = await request.json();
	const now = new Date().toISOString();

	const doc = locals.db.prepare('SELECT * FROM documents WHERE id = ?').get(params.id) as any;
	if (!doc) throw error(404, 'Document not found');

	const html = body.content ?? '';
	const plainText = stripHtml(html);
	const wordCount = countWords(plainText);

	// 1. Atomic write to disk
	writeContentFile(doc.novel_id, doc.id, html);

	// 2-5. Update DB in transaction
	const updateDoc = locals.db.transaction(() => {
		// Update metadata
		locals.db.prepare(`
			UPDATE documents SET
				word_count = ?,
				title = COALESCE(?, title),
				synopsis = COALESCE(?, synopsis),
				updated_at = ?
			WHERE id = ?
		`).run(wordCount, body.title, body.synopsis, now, params.id);

		// Snapshot if >2 min since last
		const shouldSnapshot = !doc.last_snapshot_at ||
			(new Date(now).getTime() - new Date(doc.last_snapshot_at).getTime()) > 2 * 60 * 1000;

		if (shouldSnapshot && html.trim()) {
			const snapId = uuid();
			const snapPath = writeSnapshotFile(doc.novel_id, doc.id, now.replace(/[:.]/g, '-'), html);

			locals.db.prepare(`
				INSERT INTO snapshots (id, document_id, content_path, word_count, reason, created_at)
				VALUES (?, ?, ?, ?, ?, ?)
			`).run(snapId, doc.id, snapPath, wordCount, 'autosave', now);

			locals.db.prepare('UPDATE documents SET last_snapshot_at = ? WHERE id = ?').run(now, doc.id);
		}

		// Update FTS index (plain text, not HTML)
		locals.db.prepare('DELETE FROM documents_fts WHERE doc_id = ?').run(doc.id);
		locals.db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(
			doc.id,
			body.title || doc.title,
			plainText
		);
	});
	updateDoc();

	const updated = locals.db.prepare('SELECT * FROM documents WHERE id = ?').get(params.id);
	return json(updated);
};

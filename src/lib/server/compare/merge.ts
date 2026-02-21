import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type { MatchedPair, MergeInstruction, MergeReport } from '$lib/types.js';
import { stripHtml, countWords, writeContentFile, ensureNovelDirs } from '../files.js';
import { logAction } from '../audit.js';

/**
 * Execute a merge: create a new novel from matched pairs + user instructions.
 *
 * @param db - Database instance
 * @param title - Title for the merged novel
 * @param pairs - Matched document pairs
 * @param instructions - User's merge choices per pair
 * @param novelATitle - Title of Novel A (for provenance tracking)
 * @param novelBTitle - Title of Novel B (for provenance tracking)
 * @param userId - User performing the merge
 */
export function executeMerge(
	db: Database.Database,
	title: string,
	pairs: MatchedPair[],
	instructions: MergeInstruction[],
	novelATitle: string,
	novelBTitle: string,
	userId: string
): MergeReport {
	const novelId = crypto.randomUUID();
	const now = new Date().toISOString();

	let documentsCreated = 0;
	let foldersCreated = 0;
	let variantFolders = 0;
	let totalWordCount = 0;
	let sortOrder = 1.0;

	const doMerge = db.transaction(() => {
		// Create the merged novel
		db.prepare(
			`INSERT INTO novels (id, title, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)`
		).run(novelId, title, now, now);

		// Ensure data directories exist
		ensureNovelDirs(novelId);

		for (const instruction of instructions) {
			const pair = pairs[instruction.pairIndex];
			if (!pair) continue;

			switch (instruction.choice) {
				case 'a': {
					const doc = pair.docA;
					if (!doc) break;
					const docId = crypto.randomUUID();
					const plaintext = doc.plaintext;
					const wc = countWords(plaintext);

					db.prepare(
						`INSERT INTO documents (id, novel_id, parent_id, title, synopsis, word_count, compile_include, sort_order, created_at, updated_at)
						 VALUES (?, ?, NULL, ?, ?, ?, 1, ?, ?, ?)`
					).run(docId, novelId, doc.title, `From: ${novelATitle}`, wc, sortOrder, now, now);

					writeContentFile(novelId, docId, doc.html);
					db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(docId, doc.title, plaintext);

					documentsCreated++;
					totalWordCount += wc;
					sortOrder += 1.0;
					break;
				}

				case 'b': {
					const doc = pair.docB;
					if (!doc) break;
					const docId = crypto.randomUUID();
					const plaintext = doc.plaintext;
					const wc = countWords(plaintext);

					db.prepare(
						`INSERT INTO documents (id, novel_id, parent_id, title, synopsis, word_count, compile_include, sort_order, created_at, updated_at)
						 VALUES (?, ?, NULL, ?, ?, ?, 1, ?, ?, ?)`
					).run(docId, novelId, doc.title, `From: ${novelBTitle}`, wc, sortOrder, now, now);

					writeContentFile(novelId, docId, doc.html);
					db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(docId, doc.title, plaintext);

					documentsCreated++;
					totalWordCount += wc;
					sortOrder += 1.0;
					break;
				}

				case 'both': {
					// Create a variant folder containing both versions
					const folderId = crypto.randomUUID();
					const folderTitle = pair.docA?.title || pair.docB?.title || 'Variant';

					db.prepare(
						`INSERT INTO folders (id, novel_id, parent_id, title, sort_order, created_at, updated_at)
						 VALUES (?, ?, NULL, ?, ?, ?, ?)`
					).run(folderId, novelId, folderTitle, sortOrder, now, now);

					foldersCreated++;
					variantFolders++;
					sortOrder += 1.0;

					let childSort = 1.0;

					// Doc A variant
					if (pair.docA) {
						const docId = crypto.randomUUID();
						const plaintext = pair.docA.plaintext;
						const wc = countWords(plaintext);
						const variantTitle = `${pair.docA.title} — from ${novelATitle}`;

						db.prepare(
							`INSERT INTO documents (id, novel_id, parent_id, title, synopsis, word_count, compile_include, sort_order, created_at, updated_at)
							 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
						).run(docId, novelId, folderId, variantTitle, `From: ${novelATitle}`, wc, childSort, now, now);

						writeContentFile(novelId, docId, pair.docA.html);
						db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(docId, variantTitle, plaintext);

						documentsCreated++;
						totalWordCount += wc;
						childSort += 1.0;
					}

					// Doc B variant
					if (pair.docB) {
						const docId = crypto.randomUUID();
						const plaintext = pair.docB.plaintext;
						const wc = countWords(plaintext);
						const variantTitle = `${pair.docB.title} — from ${novelBTitle}`;

						db.prepare(
							`INSERT INTO documents (id, novel_id, parent_id, title, synopsis, word_count, compile_include, sort_order, created_at, updated_at)
							 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
						).run(docId, novelId, folderId, variantTitle, `From: ${novelBTitle}`, wc, childSort, now, now);

						writeContentFile(novelId, docId, pair.docB.html);
						db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(docId, variantTitle, plaintext);

						documentsCreated++;
						totalWordCount += wc;
						childSort += 1.0;
					}
					break;
				}

				case 'skip':
					// Omit this pair entirely
					break;
			}
		}

		// Audit log
		logAction(db, userId, 'novel.merge', 'novel', novelId, JSON.stringify({
			sourceA: novelATitle,
			sourceB: novelBTitle,
			documentsCreated,
			foldersCreated,
			variantFolders
		}));
	});

	doMerge();

	return {
		novelId,
		novelTitle: title,
		documentsCreated,
		foldersCreated,
		variantFolders,
		totalWordCount
	};
}

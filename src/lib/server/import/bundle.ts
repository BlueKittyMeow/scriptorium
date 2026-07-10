import { error } from '@sveltejs/kit';
import { readFileSync, existsSync, realpathSync, statSync, rmSync } from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import type { BundleImportReport } from '$lib/types.js';
import { extractBodyContent } from './scriv.js';
import { getDataRoot } from '$lib/server/db.js';
import {
	ensureNovelDirs,
	writeContentFile,
	writeSnapshotFile,
	stripHtml,
	countWords
} from '$lib/server/files.js';

/**
 * W5b Unit B — bundle importer.
 *
 * A bundle is a directory (`bundle.json` + `content/<work>/<doc>.html`) produced
 * by the offline pipeline (Unit A). This module ingests it: one novel per work,
 * folders (two-level max), documents in order, and each near-duplicate variant
 * stored as a snapshot of its document — preservation-first.
 *
 * Two error tiers, deliberately split:
 *  - Structural manifest problems (missing/duplicate keys, html paths that
 *    escape the bundle or don't exist, bad timestamps, empty works, absent or
 *    unparseable bundle.json) throw a 400 for the *whole* request — a malformed
 *    manifest is not something to partially ingest.
 *  - Per-work referential/semantic problems (a document or folder pointing at a
 *    folder key that isn't defined, folder nesting deeper than two levels) roll
 *    back only that work, record its errors, and let the run continue — mirroring
 *    the .scriv batch import's per-item isolation.
 *
 * HTML handling matches importScriv exactly: extract the <body> inner HTML,
 * write it to disk verbatim (no sanitizer — the same as scriv, which trusts its
 * converter's output), and derive word count + FTS text from stripHtml().
 */

interface BundleVariant {
	html: string;
	label: string;
	timestamp: string;
}

interface BundleDocument {
	key: string;
	title: string;
	folder: string | null;
	order: number;
	html: string;
	source_note?: string;
	variants?: BundleVariant[];
}

interface BundleFolder {
	key: string;
	title: string;
	parent: string | null;
}

interface BundleWork {
	key: string;
	title: string;
	folders?: BundleFolder[];
	documents?: BundleDocument[];
}

/** RFC-ish ISO-8601: date, optional time and zone. Pairs with Date.parse. */
function isIso8601(value: unknown): boolean {
	if (typeof value !== 'string') return false;
	if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
		return false;
	}
	return !Number.isNaN(Date.parse(value));
}

/**
 * Resolve a manifest html path against the bundle root, rejecting absolute
 * paths, `../` escapes (via realpath containment), and missing files. Returns
 * the absolute on-disk path to read from.
 */
function resolveHtmlPath(bundleReal: string, rel: unknown, label: string): string {
	if (typeof rel !== 'string' || !rel) {
		throw error(400, `${label} html must be a non-empty string path`);
	}
	if (path.isAbsolute(rel)) {
		throw error(400, `${label} html must be relative to the bundle, not absolute: ${rel}`);
	}
	const abs = path.resolve(bundleReal, rel);
	let real: string;
	try {
		real = realpathSync(abs);
	} catch {
		throw error(400, `${label} references a missing html file: ${rel}`);
	}
	if (real !== bundleReal && !real.startsWith(bundleReal + path.sep)) {
		throw error(400, `${label} html path escapes the bundle directory: ${rel}`);
	}
	if (!statSync(real).isFile()) {
		throw error(400, `${label} html is not a file: ${rel}`);
	}
	return real;
}

/**
 * Validate the whole bundle up front. Throws 400 on any structural problem.
 * Returns the parsed, typed works array (references still validated per-work at
 * import time, see module doc).
 */
export function validateBundleManifest(bundleDir: string): BundleWork[] {
	const bundleReal = realpathSync(bundleDir);
	const manifestPath = path.join(bundleReal, 'bundle.json');
	if (!existsSync(manifestPath)) {
		throw error(400, 'bundle.json not found in the bundle directory');
	}

	let manifest: any;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	} catch {
		throw error(400, 'bundle.json is not valid JSON');
	}

	const works = manifest?.works;
	if (!Array.isArray(works) || works.length === 0) {
		throw error(400, 'bundle.json must contain a non-empty works array');
	}

	const workKeys = new Set<string>();
	for (const work of works as BundleWork[]) {
		if (typeof work?.key !== 'string' || !work.key) {
			throw error(400, 'each work requires a non-empty string key');
		}
		if (workKeys.has(work.key)) {
			throw error(400, `duplicate work key: ${work.key}`);
		}
		workKeys.add(work.key);
		if (typeof work.title !== 'string' || !work.title) {
			throw error(400, `work ${work.key} requires a non-empty title`);
		}

		// keys unique within a work across folders + documents
		const localKeys = new Set<string>();

		const folders = work.folders ?? [];
		if (!Array.isArray(folders)) throw error(400, `work ${work.key}: folders must be an array`);
		for (const f of folders) {
			if (typeof f?.key !== 'string' || !f.key) throw error(400, `work ${work.key}: each folder requires a key`);
			if (localKeys.has(f.key)) throw error(400, `work ${work.key}: duplicate key ${f.key}`);
			localKeys.add(f.key);
			if (typeof f.title !== 'string' || !f.title) throw error(400, `work ${work.key}: folder ${f.key} requires a title`);
			if (f.parent !== null && typeof f.parent !== 'string') {
				throw error(400, `work ${work.key}: folder ${f.key} parent must be a key or null`);
			}
		}

		const documents = work.documents ?? [];
		if (!Array.isArray(documents)) throw error(400, `work ${work.key}: documents must be an array`);
		for (const d of documents) {
			if (typeof d?.key !== 'string' || !d.key) throw error(400, `work ${work.key}: each document requires a key`);
			if (localKeys.has(d.key)) throw error(400, `work ${work.key}: duplicate key ${d.key}`);
			localKeys.add(d.key);
			if (typeof d.title !== 'string' || !d.title) throw error(400, `work ${work.key}: document ${d.key} requires a title`);
			if (d.folder !== null && typeof d.folder !== 'string') {
				throw error(400, `work ${work.key}: document ${d.key} folder must be a key or null`);
			}
			if (typeof d.order !== 'number' || !Number.isFinite(d.order)) {
				throw error(400, `work ${work.key}: document ${d.key} requires a numeric order`);
			}
			resolveHtmlPath(bundleReal, d.html, `work ${work.key} document ${d.key}`);

			const variants = d.variants ?? [];
			if (!Array.isArray(variants)) throw error(400, `work ${work.key}: document ${d.key} variants must be an array`);
			for (const v of variants) {
				if (typeof v?.label !== 'string' || !v.label) {
					throw error(400, `work ${work.key}: document ${d.key} variant requires a label`);
				}
				if (!isIso8601(v.timestamp)) {
					throw error(400, `work ${work.key}: document ${d.key} variant timestamp is not ISO-8601: ${v.timestamp}`);
				}
				resolveHtmlPath(bundleReal, v.html, `work ${work.key} document ${d.key} variant`);
			}
		}
	}

	return works as BundleWork[];
}

/**
 * Import one work in a single transaction. On any failure the transaction rolls
 * back and every content/snapshot file written for the work is removed (scriv
 * import leaves such files behind on its rollback — see importScriv; the bundle
 * importer cleans them up properly by dropping the whole novel data dir).
 */
function importWork(
	db: Database.Database,
	bundleReal: string,
	work: BundleWork,
	ownerId: string,
	dryRun: boolean
): BundleImportReport {
	const report: BundleImportReport = {
		work_key: work.key,
		novel_id: '',
		novel_title: work.title,
		docs_imported: 0,
		folders_created: 0,
		files_skipped: 0,
		variants_imported: 0,
		total_word_count: 0,
		skipped: false,
		errors: [],
		warnings: []
	};

	const importSource = `bundle:${work.key}`;
	const documents = work.documents ?? [];
	const folders = work.folders ?? [];

	// Idempotency: skip if a *live* novel already carries this work's tag. A
	// soft-deleted prior import (the rollback mechanism for a mis-import) does
	// not block a fresh re-import.
	const existing = db
		.prepare('SELECT id FROM novels WHERE import_source = ? AND deleted_at IS NULL')
		.get(importSource) as { id: string } | undefined;
	if (existing) {
		report.skipped = true;
		report.novel_id = existing.id;
		report.warnings.push('already imported — skipped');
		return report;
	}

	if (dryRun) {
		// Full accounting, zero writes (not even content files).
		report.folders_created = folders.length;
		for (const doc of documents) {
			report.docs_imported++;
			const body = extractBodyContent(readFileSync(path.resolve(bundleReal, doc.html), 'utf8'));
			report.total_word_count += countWords(stripHtml(body));
			report.variants_imported += (doc.variants ?? []).length;
		}
		return report;
	}

	const novelId = uuid();
	const novelDir = path.join(getDataRoot(), novelId);
	try {
		const run = db.transaction(() => {
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO novels (id, title, status, owner_id, import_source, created_at, updated_at)
				 VALUES (?, ?, 'draft', ?, ?, ?, ?)`
			).run(novelId, work.title, ownerId, importSource, now, now);
			ensureNovelDirs(novelId);

			// Assign ids to every folder key first so parent refs resolve
			// regardless of declaration order.
			const folderId = new Map<string, string>();
			for (const f of folders) folderId.set(f.key, uuid());

			let folderSort = 1.0;
			for (const f of folders) {
				let parentId: string | null = null;
				if (f.parent) {
					parentId = folderId.get(f.parent) ?? null;
					if (!parentId) throw new Error(`folder ${f.key} references unknown parent ${f.parent}`);
					// Two-level max in v1: a folder's parent must itself be a root.
					const grandparent = folders.find((x) => x.key === f.parent)?.parent;
					if (grandparent) throw new Error(`folder nesting exceeds two levels at ${f.key}`);
				}
				db.prepare(
					`INSERT INTO folders (id, novel_id, parent_id, title, folder_type, sort_order, created_at, updated_at)
					 VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
				).run(folderId.get(f.key), novelId, parentId, f.title, folderSort, now, now);
				report.folders_created++;
				folderSort += 1.0;
			}

			const ordered = [...documents].sort((a, b) => a.order - b.order);
			for (const doc of ordered) {
				let parentId: string | null = null;
				if (doc.folder) {
					parentId = folderId.get(doc.folder) ?? null;
					if (!parentId) throw new Error(`document ${doc.key} references unknown folder ${doc.folder}`);
				}
				const synopsis =
					typeof doc.source_note === 'string' && doc.source_note.trim() ? doc.source_note.trim() : null;

				const body = extractBodyContent(readFileSync(path.resolve(bundleReal, doc.html), 'utf8'));
				const plainText = stripHtml(body);
				const wordCount = countWords(plainText);
				const docId = uuid();

				db.prepare(
					`INSERT INTO documents (id, novel_id, parent_id, title, synopsis, word_count, compile_include, sort_order, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
				).run(docId, novelId, parentId, doc.title, synopsis, wordCount, doc.order, now, now);
				writeContentFile(novelId, docId, body);
				db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(docId, doc.title, plainText);
				report.docs_imported++;

				// Variants ride on snapshots. created_at = the source timestamp,
				// so the timeline stays honest. Given oldest->newest ordering (a
				// pipeline promise), the last one processed is the newest, and
				// last_snapshot_at is set to it — the document's snapshot metadata
				// then agrees with its snapshot rows (all historical), rather than
				// claiming a snapshot happened "now" at import.
				let lastSnapshotAt: string | null = null;
				for (const v of doc.variants ?? []) {
					const snapId = uuid();
					const variantBody = extractBodyContent(readFileSync(path.resolve(bundleReal, v.html), 'utf8'));
					const variantWords = countWords(stripHtml(variantBody));
					const snapPath = writeSnapshotFile(novelId, docId, snapId, variantBody);
					db.prepare(
						`INSERT INTO snapshots (id, document_id, content_path, word_count, reason, created_at)
						 VALUES (?, ?, ?, ?, ?, ?)`
					).run(snapId, docId, snapPath, variantWords, `imported-variant: ${v.label}`, v.timestamp);
					lastSnapshotAt = v.timestamp;
					report.variants_imported++;
				}
				if (lastSnapshotAt) {
					db.prepare('UPDATE documents SET last_snapshot_at = ? WHERE id = ?').run(lastSnapshotAt, docId);
				}
			}
		});
		run();
	} catch (err: any) {
		// DB rolled back automatically; clean the orphaned data dir off disk.
		try {
			rmSync(novelDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
		return {
			...report,
			novel_id: '',
			docs_imported: 0,
			folders_created: 0,
			variants_imported: 0,
			total_word_count: 0,
			errors: [err?.message || 'Bundle work import failed']
		};
	}

	report.novel_id = novelId;
	const row = db
		.prepare('SELECT COALESCE(SUM(word_count), 0) as total FROM documents WHERE novel_id = ?')
		.get(novelId) as { total: number };
	report.total_word_count = row.total;
	return report;
}

/**
 * Import an entire bundle. Validates the manifest (throws 400 on structural
 * problems) then imports each work with per-work error isolation. Returns one
 * report per work, in manifest order.
 */
export function importBundle(
	db: Database.Database,
	bundleDir: string,
	ownerId: string,
	options: { dryRun?: boolean } = {}
): BundleImportReport[] {
	const works = validateBundleManifest(bundleDir);
	const bundleReal = realpathSync(bundleDir);
	const dryRun = options.dryRun === true;
	return works.map((work) => importWork(db, bundleReal, work, ownerId, dryRun));
}

import { readFileSync, existsSync } from 'fs';
import { XMLParser } from 'fast-xml-parser';
import rtfToHTML from '@iarna/rtf-to-html';
import { Readable } from 'stream';
import { v4 as uuid } from 'uuid';
import path from 'path';
import type Database from 'better-sqlite3';
import type { ImportReport } from '$lib/types.js';
import { writeContentFile, stripHtml, countWords } from '$lib/server/files.js';
import { ensureNovelDirs } from '$lib/server/files.js';
import { validatePathSegment } from '$lib/server/validate.js';

function convertRtf(rtfBuffer: Buffer): Promise<string> {
	return new Promise((resolve, reject) => {
		const stream = new Readable();
		stream.push(rtfBuffer);
		stream.push(null);
		(rtfToHTML as any).fromStream(stream, (err: Error | null, html: string) => {
			if (err) reject(err);
			else resolve(html);
		});
	});
}

function extractBodyContent(html: string): string {
	const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
	return bodyMatch ? bodyMatch[1].trim() : html;
}

interface BinderItem {
	'@_ID': string;
	'@_Type': string;
	'@_Created'?: string;
	'@_Modified'?: string;
	Title?: string;
	MetaData?: {
		LabelID?: string;
		StatusID?: string;
		IncludeInCompile?: string;
		FileExtension?: string;
	};
	Children?: {
		BinderItem?: BinderItem | BinderItem[];
	};
}

export async function importScriv(db: Database.Database, scrivPath: string): Promise<ImportReport> {
	const report: ImportReport = {
		novel_id: '',
		novel_title: '',
		docs_imported: 0,
		folders_created: 0,
		files_skipped: 0,
		errors: [],
		warnings: []
	};

	// Find the .scrivx file
	const dirName = path.basename(scrivPath);
	const projectName = dirName.replace(/\.scriv$/, '');

	// Look for .scrivx file
	let scrivxPath = '';
	const possibleScrivx = path.join(scrivPath, `${projectName}.scrivx`);
	if (existsSync(possibleScrivx)) {
		scrivxPath = possibleScrivx;
	} else {
		// Try to find any .scrivx file
		const fs = await import('fs');
		const files = fs.readdirSync(scrivPath);
		const scrivxFile = files.find((f: string) => f.endsWith('.scrivx'));
		if (scrivxFile) {
			scrivxPath = path.join(scrivPath, scrivxFile);
		} else {
			report.errors.push('No .scrivx file found');
			return report;
		}
	}

	// Determine docs directory (handle different Scrivener layouts)
	let docsDir = path.join(scrivPath, 'Files', 'Docs');
	if (!existsSync(docsDir)) {
		docsDir = path.join(scrivPath, 'Files', 'Data');
	}

	// Parse .scrivx XML
	const xml = readFileSync(scrivxPath, 'utf8');
	const parser = new XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: '@_',
		isArray: (name: string) => name === 'BinderItem' || name === 'Label' || name === 'Status'
	});
	const project = parser.parse(xml);

	// Build label/status maps
	const labels: Record<string, string> = {};
	const statuses: Record<string, string> = {};

	try {
		const labelItems = project.ScrivenerProject.LabelSettings.Labels.Label;
		for (const l of labelItems) {
			labels[l['@_ID']] = l['#text'] || '';
		}
	} catch { /* no labels */ }

	try {
		const statusItems = project.ScrivenerProject.StatusSettings.StatusItems.Status;
		for (const s of statusItems) {
			statuses[s['@_ID']] = s['#text'] || '';
		}
	} catch { /* no statuses */ }

	// Create novel
	const novelId = uuid();
	const now = new Date().toISOString();
	report.novel_id = novelId;
	report.novel_title = projectName;

	db.prepare(`
		INSERT INTO novels (id, title, status, created_at, updated_at)
		VALUES (?, ?, 'draft', ?, ?)
	`).run(novelId, projectName, now, now);

	ensureNovelDirs(novelId);

	// Walk binder tree
	const binderItems = project.ScrivenerProject.Binder.BinderItem;
	const items = Array.isArray(binderItems) ? binderItems : [binderItems];

	try {
		let rootSort = 1.0;
		for (const item of items) {
			await walkBinderItem(db, item, novelId, null, docsDir, labels, statuses, report, rootSort);
			rootSort += 1.0;
		}
	} catch (err: any) {
		// Roll back: remove all data for this novel so no partial import remains
		db.prepare('DELETE FROM documents_fts WHERE doc_id IN (SELECT id FROM documents WHERE novel_id = ?)').run(novelId);
		db.prepare('DELETE FROM documents WHERE novel_id = ?').run(novelId);
		db.prepare('DELETE FROM folders WHERE novel_id = ?').run(novelId);
		db.prepare('DELETE FROM novels WHERE id = ?').run(novelId);
		report.errors.push(`Import aborted: ${err.message}`);
		return report;
	}

	return report;
}

async function walkBinderItem(
	db: Database.Database,
	item: BinderItem,
	novelId: string,
	parentId: string | null,
	docsDir: string,
	labels: Record<string, string>,
	statuses: Record<string, string>,
	report: ImportReport,
	sortOrder: number
): Promise<void> {
	const scrivId = item['@_ID'];
	validatePathSegment(scrivId);
	const type = item['@_Type'];
	const title = item.Title || '(untitled)';
	const now = new Date().toISOString();
	const id = uuid();

	const isFolder = type.includes('Folder') || type === 'Root';
	const isTrash = type === 'Trash';

	if (isFolder || isTrash) {
		// Determine folder_type
		let folderType: string | null = null;
		if (isTrash) {
			folderType = 'trash';
		} else if (title.toLowerCase() === 'draft' || title.toLowerCase() === 'manuscript') {
			folderType = 'manuscript';
		} else if (title.toLowerCase() === 'research') {
			folderType = 'research';
		} else if (title.toLowerCase() === 'notes') {
			folderType = 'notes';
		} else if (title.toLowerCase() === 'characters') {
			folderType = 'characters';
		}

		db.prepare(`
			INSERT INTO folders (id, novel_id, parent_id, title, folder_type, sort_order, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(id, novelId, parentId, title, folderType, sortOrder, now, now);

		report.folders_created++;

		// Also try to import folder text content if it exists
		await tryImportContent(db, scrivId, id, novelId, title, docsDir, report);

		// Recurse into children
		if (item.Children?.BinderItem) {
			const children = Array.isArray(item.Children.BinderItem) ? item.Children.BinderItem : [item.Children.BinderItem];
			let childSort = 1.0;
			for (const child of children) {
				await walkBinderItem(db, child, novelId, id, docsDir, labels, statuses, report, childSort);
				childSort += 1.0;
			}
		}
	} else {
		// Document (Text type)
		const meta = item.MetaData || {};
		const compileInclude = meta.IncludeInCompile !== 'No' ? 1 : 0;

		// Try to read synopsis
		let synopsis: string | null = null;
		const synopsisPath = path.join(docsDir, `${scrivId}_synopsis.txt`);
		if (existsSync(synopsisPath)) {
			synopsis = readFileSync(synopsisPath, 'utf8').trim() || null;
		}

		db.prepare(`
			INSERT INTO documents (id, novel_id, parent_id, title, synopsis, compile_include, sort_order, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(id, novelId, parentId, title, synopsis, compileInclude, sortOrder, now, now);

		// Convert RTF content
		const imported = await tryImportContent(db, scrivId, id, novelId, title, docsDir, report);

		if (!imported) {
			// Still add to FTS with title only
			db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(id, title, '');
		}

		// Recurse (Scrivener text items can have children too)
		if (item.Children?.BinderItem) {
			const children = Array.isArray(item.Children.BinderItem) ? item.Children.BinderItem : [item.Children.BinderItem];
			let childSort = 1.0;
			for (const child of children) {
				await walkBinderItem(db, child, novelId, id, docsDir, labels, statuses, report, childSort);
				childSort += 1.0;
			}
		}
	}
}

async function tryImportContent(
	db: Database.Database,
	scrivId: string,
	docId: string,
	novelId: string,
	title: string,
	docsDir: string,
	report: ImportReport
): Promise<boolean> {
	// Validate scrivId to prevent path traversal from crafted .scrivx files
	validatePathSegment(scrivId);

	// Try different RTF locations
	const rtfPaths = [
		path.join(docsDir, `${scrivId}.rtf`),
		path.join(docsDir, scrivId, 'content.rtf')
	];

	let rtfPath: string | null = null;
	for (const p of rtfPaths) {
		if (existsSync(p)) {
			rtfPath = p;
			break;
		}
	}

	if (!rtfPath) {
		// Check for media files
		const mediaExts = ['.png', '.jpg', '.jpeg', '.gif', '.pdf'];
		for (const ext of mediaExts) {
			if (existsSync(path.join(docsDir, `${scrivId}${ext}`))) {
				report.files_skipped++;
				report.warnings.push(`Skipped media file: ${scrivId}${ext} (${title})`);
				return false;
			}
		}
		return false;
	}

	try {
		const rtfBuffer = readFileSync(rtfPath);
		const fullHtml = await convertRtf(rtfBuffer);
		const bodyContent = extractBodyContent(fullHtml);
		const plainText = stripHtml(bodyContent);
		const wordCount = countWords(plainText);

		// Write to disk
		writeContentFile(novelId, docId, bodyContent);

		// Update DB
		db.prepare('UPDATE documents SET word_count = ? WHERE id = ?').run(wordCount, docId);

		// Add to FTS
		db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(docId, title, plainText);

		report.docs_imported++;
		return true;
	} catch (err: any) {
		report.errors.push(`RTF conversion failed for ${title} (${scrivId}): ${err.message}`);
		return false;
	}
}

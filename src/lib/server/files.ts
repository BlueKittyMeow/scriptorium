import fs from 'fs';
import path from 'path';
import { getDataRoot } from './db.js';
import { validatePathSegment } from './validate.js';

/** Strip HTML tags, return plain text (for FTS indexing and word count) */
export function stripHtml(html: string): string {
	return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Count words in plain text */
export function countWords(text: string): number {
	const stripped = typeof text === 'string' && text.includes('<') ? stripHtml(text) : text;
	const words = stripped.trim().split(/\s+/).filter(Boolean);
	return words.length;
}

/** Ensure novel directories exist */
export function ensureNovelDirs(novelId: string): void {
	validatePathSegment(novelId);
	const root = getDataRoot();
	fs.mkdirSync(path.join(root, novelId, 'docs'), { recursive: true });
	fs.mkdirSync(path.join(root, novelId, 'snapshots'), { recursive: true });
}

/** Get path to a document's content file */
export function contentPath(novelId: string, docId: string): string {
	validatePathSegment(novelId);
	validatePathSegment(docId);
	return path.join(getDataRoot(), novelId, 'docs', `${docId}.html`);
}

/** Get path to a snapshot file */
export function snapshotPath(novelId: string, docId: string, timestamp: string): string {
	validatePathSegment(novelId);
	validatePathSegment(docId);
	validatePathSegment(timestamp);
	const dir = path.join(getDataRoot(), novelId, 'snapshots', docId);
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `${timestamp}.html`);
}

/** Atomic write: write to .tmp, fsync, rename, fsync parent dir */
export function writeFileAtomic(filePath: string, content: string): void {
	const tmpPath = filePath + '.tmp';
	const fd = fs.openSync(tmpPath, 'w');
	try {
		fs.writeSync(fd, content);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(tmpPath, filePath);
	// Fsync parent directory to ensure the rename is durable after a crash
	const dirFd = fs.openSync(path.dirname(filePath), 'r');
	try {
		fs.fsyncSync(dirFd);
	} finally {
		fs.closeSync(dirFd);
	}
}

/** Write document content to disk atomically */
export function writeContentFile(novelId: string, docId: string, html: string): void {
	ensureNovelDirs(novelId);
	writeFileAtomic(contentPath(novelId, docId), html);
}

/** Read document content from disk */
export function readContentFile(novelId: string, docId: string): string | null {
	const p = contentPath(novelId, docId);
	if (!fs.existsSync(p)) return null;
	return fs.readFileSync(p, 'utf-8');
}

/** Write snapshot file atomically */
export function writeSnapshotFile(novelId: string, docId: string, timestamp: string, html: string): string {
	const p = snapshotPath(novelId, docId, timestamp);
	writeFileAtomic(p, html);
	return p;
}

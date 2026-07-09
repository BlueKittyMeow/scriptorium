import type Database from 'better-sqlite3';
import { error } from '@sveltejs/kit';

interface FolderRow {
	id: string;
	parent_id: string | null;
}

/**
 * Validate that parentId (if provided) refers to an existing, non-deleted
 * folder within the given novel. No-op when parentId is null/undefined
 * (root-level placement is always allowed). Throws a SvelteKit 400 error
 * otherwise. Shared by the tree reorder (PUT) and create-node (POST)
 * endpoints so both enforce the same "no invisible nodes" guarantee.
 */
export function assertValidParentFolder(
	db: Database.Database,
	novelId: string,
	parentId: string | null | undefined
): void {
	if (!parentId) return;
	const parent = db
		.prepare('SELECT id, parent_id FROM folders WHERE id = ? AND novel_id = ? AND deleted_at IS NULL')
		.get(parentId, novelId) as FolderRow | undefined;
	if (!parent) {
		throw error(400, 'new_parent_id must reference an existing folder in this novel');
	}
}

/**
 * Walk up the folders.parent_id chain starting at startParentId. Returns
 * true if nodeId appears anywhere in that ancestor chain — i.e. moving
 * nodeId to become a descendant of startParentId would create a cycle.
 * Guards against pre-existing corrupt cycles with a visited-set so it
 * always terminates.
 */
export function chainContainsNode(
	db: Database.Database,
	novelId: string,
	startParentId: string,
	nodeId: string
): boolean {
	let currentId: string | null = startParentId;
	const seen = new Set<string>();

	while (currentId) {
		if (currentId === nodeId) return true;
		if (seen.has(currentId)) break;
		seen.add(currentId);

		const row = db
			.prepare('SELECT parent_id FROM folders WHERE id = ? AND novel_id = ?')
			.get(currentId, novelId) as { parent_id: string | null } | undefined;
		currentId = row?.parent_id ?? null;
	}

	return false;
}

/**
 * Normalize an optional string field: return the trimmed value only if it's
 * a non-empty string, otherwise null. Pairs with SQL `COALESCE(?, existing)`
 * patterns so a blank/omitted field doesn't overwrite existing data (e.g.
 * `{ title: "" }` should not blank out a document's title).
 */
export function normalizeOptionalString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export const MAX_DOCUMENT_CONTENT_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Validate the `content` field of a document save payload: must be a
 * string (when present) and within the size cap. Returns the normalized
 * content string (empty string when omitted). Throws 400 for a non-string
 * value, 413 when it exceeds the cap.
 */
export function assertValidDocumentContent(content: unknown): string {
	if (content !== undefined && typeof content !== 'string') {
		throw error(400, 'content must be a string');
	}
	const html = (content as string | undefined) ?? '';
	if (Buffer.byteLength(html, 'utf8') > MAX_DOCUMENT_CONTENT_BYTES) {
		throw error(413, 'content exceeds maximum size of 10MB');
	}
	return html;
}

/** Validate that a string is safe to use as a single path segment (no traversal). */
export function validatePathSegment(segment: string): void {
	if (!segment || segment.includes('/') || segment.includes('\\') || segment.includes('..')) {
		throw new Error(`Invalid path segment: ${segment}`);
	}
}

/** Sanitize FTS5 snippet output — only allow <mark> and </mark> tags. */
export function sanitizeSnippet(snippet: string): string {
	// Replace <mark> and </mark> with placeholders, escape everything else, restore marks
	const MARK_OPEN = '\x00MARK_OPEN\x00';
	const MARK_CLOSE = '\x00MARK_CLOSE\x00';

	let safe = snippet
		.replace(/<mark>/g, MARK_OPEN)
		.replace(/<\/mark>/g, MARK_CLOSE);

	// Escape all remaining HTML
	safe = safe
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');

	// Restore <mark> tags
	safe = safe
		.replace(new RegExp(MARK_OPEN, 'g'), '<mark>')
		.replace(new RegExp(MARK_CLOSE, 'g'), '</mark>');

	return safe;
}

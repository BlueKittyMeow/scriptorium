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

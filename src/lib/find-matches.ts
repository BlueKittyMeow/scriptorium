/**
 * Matching rules for find-in-document (the Find bar in the editor header).
 *
 * Deliberately free of ProseMirror so the rules can be unit-tested on plain
 * strings. The component supplies each text block's flattened text; this
 * module only answers "where in this string does the term appear?".
 */

/** Case-insensitive, non-overlapping substring offsets of `term` in `text`. */
export function findOffsets(text: string, term: string): number[] {
	// An empty or whitespace-only term matches nothing — otherwise every
	// keystroke on the way to a real term would light up the whole document.
	if (term.trim() === '') return [];
	if (term.length > text.length) return [];

	// Plain substring search, never a RegExp: a term like "Mr." or "*" has to
	// be treated literally, not as a pattern.
	//
	// The caller maps each offset we return back to a ProseMirror position by
	// index, so case folding has to preserve length. A few characters don't —
	// Turkish 'İ' lowercases to two code units — and folding those would shift
	// every later offset and highlight the wrong words. In that rare case fall
	// back to a case-sensitive scan: fewer matches beats wrong ones.
	const folded = text.toLowerCase();
	const lengthPreserving = folded.length === text.length;
	const haystack = lengthPreserving ? folded : text;
	const needle = lengthPreserving ? term.toLowerCase() : term;
	const offsets: number[] = [];
	let from = 0;
	while (from <= haystack.length - needle.length) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) break;
		offsets.push(idx);
		// Non-overlapping: "aa" in "aaaa" is two matches, not three.
		from = idx + needle.length;
	}
	return offsets;
}

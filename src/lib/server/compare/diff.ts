import { diffWords } from 'diff';
import type { MatchedPair, PairDiff, DiffChange } from '$lib/types.js';
import { countWords } from '../files.js';

export interface ContentDiff {
	changes: DiffChange[];
	wordCountA: number;
	wordCountB: number;
}

/**
 * Compute a word-level diff between two plaintexts (A = old, B = new),
 * with word counts for both sides. Uses jsdiff's diffWords — HTML must
 * already be stripped. Shared by novel compare and the snapshot diff view.
 */
export function computeContentDiff(textA: string, textB: string): ContentDiff {
	const rawChanges = diffWords(textA, textB);

	const changes: DiffChange[] = rawChanges.map(c => ({
		value: c.value,
		added: c.added || undefined,
		removed: c.removed || undefined
	}));

	return {
		changes,
		wordCountA: countWords(textA),
		wordCountB: countWords(textB)
	};
}

/**
 * Compute a word-level diff between the two documents in a matched pair.
 * Word counts come from the pair's precomputed values (see collect.ts).
 */
export function computePairDiff(pair: MatchedPair, pairIndex: number): PairDiff {
	const { changes } = computeContentDiff(pair.docA?.plaintext ?? '', pair.docB?.plaintext ?? '');

	return {
		pairIndex,
		changes,
		wordCountA: pair.docA?.wordCount ?? 0,
		wordCountB: pair.docB?.wordCount ?? 0
	};
}

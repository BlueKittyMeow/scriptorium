import { diffWords } from 'diff';
import type { MatchedPair, PairDiff, DiffChange } from '$lib/types.js';

/**
 * Compute a word-level diff between the two documents in a matched pair.
 * Uses jsdiff's diffWords on the plaintext (HTML already stripped).
 */
export function computePairDiff(pair: MatchedPair, pairIndex: number): PairDiff {
	const textA = pair.docA?.plaintext ?? '';
	const textB = pair.docB?.plaintext ?? '';

	const rawChanges = diffWords(textA, textB);

	const changes: DiffChange[] = rawChanges.map(c => ({
		value: c.value,
		added: c.added || undefined,
		removed: c.removed || undefined
	}));

	return {
		pairIndex,
		changes,
		wordCountA: pair.docA?.wordCount ?? 0,
		wordCountB: pair.docB?.wordCount ?? 0
	};
}

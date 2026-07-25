import { describe, it, expect } from 'vitest';
import { findOffsets } from '$lib/find-matches';

/**
 * Matching rules for find-in-document. Real unit tests — the helper is kept
 * free of ProseMirror precisely so it can be exercised on plain strings.
 */

describe('findOffsets', () => {
	it('finds a single match', () => {
		expect(findOffsets('the lantern swung', 'lantern')).toEqual([4]);
	});

	it('is case-insensitive in both directions', () => {
		expect(findOffsets('The Lantern', 'lantern')).toEqual([4]);
		expect(findOffsets('the lantern', 'LANTERN')).toEqual([4]);
		expect(findOffsets('LANTERN', 'Lantern')).toEqual([0]);
	});

	it('finds every match, in order', () => {
		expect(findOffsets('sea, sea, sea', 'sea')).toEqual([0, 5, 10]);
	});

	it('matches inside words, not just whole words', () => {
		expect(findOffsets('lantern lit', 'lant')).toEqual([0]);
		expect(findOffsets('unlantern', 'lant')).toEqual([2]);
	});

	it('does not overlap matches', () => {
		// "aaaa" contains three overlapping "aa"s, but stepping past each match
		// gives the two a reader would count.
		expect(findOffsets('aaaa', 'aa')).toEqual([0, 2]);
		expect(findOffsets('aaaaa', 'aa')).toEqual([0, 2]);
	});

	it('returns nothing for an empty term', () => {
		expect(findOffsets('the lantern', '')).toEqual([]);
	});

	it('returns nothing for a whitespace-only term', () => {
		expect(findOffsets('the lantern', ' ')).toEqual([]);
		expect(findOffsets('the lantern', '   ')).toEqual([]);
		expect(findOffsets('the lantern', '\t\n')).toEqual([]);
	});

	it('returns nothing when the term is longer than the text', () => {
		expect(findOffsets('lamp', 'lantern')).toEqual([]);
	});

	it('returns nothing when there is no match', () => {
		expect(findOffsets('the lantern swung', 'candle')).toEqual([]);
	});

	it('returns nothing when the text is empty', () => {
		expect(findOffsets('', 'lantern')).toEqual([]);
	});

	it('treats regex metacharacters literally', () => {
		// A naive `new RegExp(term)` implementation would match everything here.
		expect(findOffsets('Mr. Fell', '.')).toEqual([2]);
		expect(findOffsets('a.b.c', '.')).toEqual([1, 3]);
		expect(findOffsets('anything at all', '.*')).toEqual([]);
		expect(findOffsets('a star * here', '*')).toEqual([7]);
		expect(findOffsets('cost $5 (cheap)', '(cheap)')).toEqual([8]);
		expect(findOffsets('who? me?', '?')).toEqual([3, 7]);
		expect(findOffsets('a+b', '+')).toEqual([1]);
		expect(findOffsets('back\\slash', '\\')).toEqual([4]);
	});

	it('reports true offsets even when a character case-folds to two code units', () => {
		// 'İ'.toLowerCase() is two code units, so folding this text would shift
		// every later offset and highlight the wrong word. The offset must point
		// into the ORIGINAL text: 'İstanbul ' is 9 characters.
		const text = 'İstanbul lantern';
		expect(findOffsets(text, 'lantern')).toEqual([9]);
		expect(text.slice(9, 9 + 'lantern'.length)).toBe('lantern');
	});

	it('keeps a term with internal spaces intact', () => {
		expect(findOffsets('the old lantern', 'old lantern')).toEqual([4]);
		expect(findOffsets('the oldlantern', 'old lantern')).toEqual([]);
	});
});

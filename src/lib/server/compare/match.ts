import type { CompareDocument, MatchedPair } from '$lib/types.js';

/**
 * Normalize a document title for comparison:
 * - lowercase, trim
 * - strip leading "Chapter N" / "Chapter N:" / "Chapter N —" prefixes
 */
export function normalizeTitle(title: string): string {
	let t = title.toLowerCase().trim();
	// Strip "chapter N" with optional separator (: — - –)
	t = t.replace(/^chapter\s+\d+\s*[:—–\-]?\s*/i, '').trim();
	return t;
}

/**
 * Jaccard similarity: |intersection| / |union| of word sets.
 * Returns 1.0 for two empty texts (both vacuously identical).
 * Returns 0.0 when one is empty and the other is not.
 */
export function jaccardSimilarity(textA: string, textB: string): number {
	const wordsA = new Set(textA.toLowerCase().split(/\s+/).filter(Boolean));
	const wordsB = new Set(textB.toLowerCase().split(/\s+/).filter(Boolean));

	if (wordsA.size === 0 && wordsB.size === 0) return 1.0;
	if (wordsA.size === 0 || wordsB.size === 0) return 0.0;

	let intersection = 0;
	for (const w of wordsA) {
		if (wordsB.has(w)) intersection++;
	}

	const union = wordsA.size + wordsB.size - intersection;
	return intersection / union;
}

/**
 * Match documents from two novels using a 4-phase algorithm:
 * 1. Exact title match (after normalization)
 * 2. Fuzzy title match (one contains the other, or high overlap)
 * 3. Content similarity (Jaccard > 0.3 threshold, greedy best-first)
 * 4. Unmatched remainder
 *
 * Results sorted by Novel A's order, unmatched B docs appended at end.
 */
export function matchDocuments(docsA: CompareDocument[], docsB: CompareDocument[]): MatchedPair[] {
	const pairs: MatchedPair[] = [];
	const consumedA = new Set<string>();
	const consumedB = new Set<string>();

	// Phase 1: Exact title match
	for (const a of docsA) {
		if (consumedA.has(a.id)) continue;
		const normA = normalizeTitle(a.title);
		for (const b of docsB) {
			if (consumedB.has(b.id)) continue;
			const normB = normalizeTitle(b.title);
			if (normA === normB && normA !== '') {
				pairs.push({
					docA: a, docB: b,
					method: 'exact_title',
					similarity: jaccardSimilarity(a.plaintext, b.plaintext),
					titleSimilarity: 1.0
				});
				consumedA.add(a.id);
				consumedB.add(b.id);
				break;
			}
		}
	}

	// Phase 2: Fuzzy title match (one contains the other)
	for (const a of docsA) {
		if (consumedA.has(a.id)) continue;
		const normA = normalizeTitle(a.title);
		if (!normA) continue;

		let bestMatch: { doc: CompareDocument; titleSim: number } | null = null;
		for (const b of docsB) {
			if (consumedB.has(b.id)) continue;
			const normB = normalizeTitle(b.title);
			if (!normB) continue;

			// Check containment
			if (normA.includes(normB) || normB.includes(normA)) {
				const titleSim = Math.min(normA.length, normB.length) / Math.max(normA.length, normB.length);
				if (titleSim > 0.7 && (!bestMatch || titleSim > bestMatch.titleSim)) {
					bestMatch = { doc: b, titleSim };
				}
			}
		}
		if (bestMatch) {
			pairs.push({
				docA: a, docB: bestMatch.doc,
				method: 'fuzzy_title',
				similarity: jaccardSimilarity(a.plaintext, bestMatch.doc.plaintext),
				titleSimilarity: bestMatch.titleSim
			});
			consumedA.add(a.id);
			consumedB.add(bestMatch.doc.id);
		}
	}

	// Phase 3: Content similarity (greedy best-first, threshold 0.3)
	const CONTENT_THRESHOLD = 0.3;
	let changed = true;
	while (changed) {
		changed = false;
		let bestPair: { a: CompareDocument; b: CompareDocument; sim: number } | null = null;

		for (const a of docsA) {
			if (consumedA.has(a.id)) continue;
			for (const b of docsB) {
				if (consumedB.has(b.id)) continue;
				const sim = jaccardSimilarity(a.plaintext, b.plaintext);
				if (sim >= CONTENT_THRESHOLD && (!bestPair || sim > bestPair.sim)) {
					bestPair = { a, b, sim };
				}
			}
		}

		if (bestPair) {
			pairs.push({
				docA: bestPair.a, docB: bestPair.b,
				method: 'content_similarity',
				similarity: bestPair.sim,
				titleSimilarity: 0
			});
			consumedA.add(bestPair.a.id);
			consumedB.add(bestPair.b.id);
			changed = true;
		}
	}

	// Phase 4: Build final result with all docs in Novel A's order
	const aOrder = new Map(docsA.map((d, i) => [d.id, i]));

	// Index matched pairs by A doc id for O(1) lookup
	const matchedByAId = new Map<string, MatchedPair>();
	for (const p of pairs) {
		if (p.docA) matchedByAId.set(p.docA.id, p);
	}

	// Walk Novel A in order: emit matched pair or unmatched_a at each position
	const result: MatchedPair[] = [];
	for (const a of docsA) {
		const matched = matchedByAId.get(a.id);
		if (matched) {
			result.push(matched);
		} else if (!consumedA.has(a.id)) {
			result.push({
				docA: a, docB: null,
				method: 'unmatched_a',
				similarity: 0,
				titleSimilarity: 0
			});
		}
	}

	// Unmatched B docs appended at end (in original order)
	for (const b of docsB) {
		if (!consumedB.has(b.id)) {
			result.push({
				docA: null, docB: b,
				method: 'unmatched_b',
				similarity: 0,
				titleSimilarity: 0
			});
		}
	}

	return result;
}

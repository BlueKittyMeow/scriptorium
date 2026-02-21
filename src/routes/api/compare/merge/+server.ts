import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth.js';
import { readContentFile } from '$lib/server/files.js';
import { collectCompareDocuments } from '$lib/server/compare/collect.js';
import { matchDocuments } from '$lib/server/compare/match.js';
import { executeMerge } from '$lib/server/compare/merge.js';
import type { MergeInstruction } from '$lib/types.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals);

	const { novelIdA, novelIdB, mergedTitle, instructions } = await request.json() as {
		novelIdA: string;
		novelIdB: string;
		mergedTitle: string;
		instructions: MergeInstruction[];
	};

	if (!novelIdA || !novelIdB || !mergedTitle || !instructions) {
		throw error(400, 'novelIdA, novelIdB, mergedTitle, and instructions are all required');
	}

	const novelA = locals.db.prepare('SELECT id, title FROM novels WHERE id = ? AND deleted_at IS NULL').get(novelIdA) as { id: string; title: string } | undefined;
	const novelB = locals.db.prepare('SELECT id, title FROM novels WHERE id = ? AND deleted_at IS NULL').get(novelIdB) as { id: string; title: string } | undefined;

	if (!novelA) throw error(404, 'Novel A not found');
	if (!novelB) throw error(404, 'Novel B not found');

	// Recompute matching server-side (don't trust client pair data)
	const docsA = collectCompareDocuments(locals.db, novelIdA, readContentFile);
	const docsB = collectCompareDocuments(locals.db, novelIdB, readContentFile);
	const pairs = matchDocuments(docsA, docsB);

	if (instructions.length !== pairs.length) {
		throw error(400, `Expected ${pairs.length} instructions, got ${instructions.length}`);
	}

	// Validate pairIndex uniqueness and coverage (must be exactly 0..N-1)
	const validChoices = new Set(['a', 'b', 'both', 'skip']);
	const seenIndices = new Set<number>();
	for (const inst of instructions) {
		if (typeof inst.pairIndex !== 'number' || inst.pairIndex < 0 || inst.pairIndex >= pairs.length) {
			throw error(400, `Invalid pairIndex: ${inst.pairIndex}`);
		}
		if (seenIndices.has(inst.pairIndex)) {
			throw error(400, `Duplicate pairIndex: ${inst.pairIndex}`);
		}
		seenIndices.add(inst.pairIndex);
		if (!validChoices.has(inst.choice)) {
			throw error(400, `Invalid choice "${inst.choice}" for pairIndex ${inst.pairIndex}`);
		}
	}

	const report = executeMerge(
		locals.db,
		mergedTitle,
		pairs,
		instructions,
		novelA.title,
		novelB.title,
		user.id
	);

	return json(report);
};

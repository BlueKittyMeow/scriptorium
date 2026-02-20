import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	const novel = locals.db.prepare(`
		SELECT n.*, COALESCE(SUM(d.word_count), 0) as total_word_count
		FROM novels n
		LEFT JOIN documents d ON d.novel_id = n.id AND d.deleted_at IS NULL
		WHERE n.id = ? AND n.deleted_at IS NULL
		GROUP BY n.id
	`).get(params.id) as any;

	if (!novel) throw error(404, 'Novel not found');

	return { novel };
};

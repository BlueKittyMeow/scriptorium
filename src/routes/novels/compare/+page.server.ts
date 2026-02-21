import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	// Fetch all non-deleted novels for the dropdowns
	const novels = locals.db.prepare(
		'SELECT id, title FROM novels WHERE deleted_at IS NULL ORDER BY title'
	).all() as { id: string; title: string }[];

	return { novels };
};

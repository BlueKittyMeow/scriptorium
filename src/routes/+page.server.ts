import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Server-side load for the library. Serving the novels list here (instead of an
// onMount fetch) removes a client round-trip — a real win on high-latency
// cellular connections. The layout guard already redirects unauthenticated
// users; the null check below is defence-in-depth.
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(302, '/login');
	}

	// Same shape as GET /api/novels, including owner fields, so the client
	// refresh (loadNovels) and this initial payload are interchangeable.
	const novels = locals.db.prepare(`
		SELECT n.*, u.username AS owner_username,
		       COALESCE(SUM(d.word_count), 0) as total_word_count
		FROM novels n
		LEFT JOIN users u ON u.id = n.owner_id
		LEFT JOIN documents d ON d.novel_id = n.id AND d.deleted_at IS NULL
		WHERE n.deleted_at IS NULL
		GROUP BY n.id
		ORDER BY n.updated_at DESC
	`).all();

	// Collections travel with the novels so the bookshelf renders on first
	// paint — no client fetch waterfall. Same order as GET /api/collections.
	const collections = locals.db.prepare(`
		SELECT * FROM collections
		ORDER BY COALESCE(parent_id, id), (parent_id IS NOT NULL), sort_order, created_at
	`).all();

	return { novels, collections };
};

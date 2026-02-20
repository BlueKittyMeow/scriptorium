import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { TreeNode } from '$lib/types.js';

// GET /api/novels/:id/tree — full binder tree
export const GET: RequestHandler = async ({ params, locals }) => {
	const novel = locals.db.prepare('SELECT * FROM novels WHERE id = ? AND deleted_at IS NULL').get(params.id);
	if (!novel) throw error(404, 'Novel not found');

	const folders = locals.db.prepare(
		'SELECT * FROM folders WHERE novel_id = ? ORDER BY sort_order'
	).all(params.id) as any[];

	const documents = locals.db.prepare(
		'SELECT * FROM documents WHERE novel_id = ? ORDER BY sort_order'
	).all(params.id) as any[];

	// Build tree: combine folders and documents, nest by parent_id
	function buildTree(parentId: string | null): TreeNode[] {
		const children: TreeNode[] = [];

		for (const f of folders.filter(f => f.parent_id === parentId)) {
			children.push({
				id: f.id,
				type: 'folder',
				title: f.title,
				sort_order: f.sort_order,
				folder_type: f.folder_type,
				deleted_at: f.deleted_at,
				children: buildTree(f.id)
			});
		}

		for (const d of documents.filter(d => d.parent_id === parentId)) {
			children.push({
				id: d.id,
				type: 'document',
				title: d.title,
				sort_order: d.sort_order,
				word_count: d.word_count,
				compile_include: d.compile_include,
				synopsis: d.synopsis,
				deleted_at: d.deleted_at,
				children: []
			});
		}

		children.sort((a, b) => a.sort_order - b.sort_order);
		return children;
	}

	const tree = buildTree(null);
	return json(tree);
};

// PUT /api/novels/:id/tree/reorder — move/reparent a node
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const body = await request.json();
	const { node_id, node_type, new_parent_id, new_sort_order } = body;
	const now = new Date().toISOString();

	const table = node_type === 'folder' ? 'folders' : 'documents';

	locals.db.prepare(`
		UPDATE ${table} SET parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ? AND novel_id = ?
	`).run(new_parent_id || null, new_sort_order, now, node_id, params.id);

	return json({ success: true });
};

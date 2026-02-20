import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { VALID_FORMATS } from '$lib/server/compile/types.js';
import type { CompileFormat } from '$lib/server/compile/types.js';

// PUT /api/novels/:id/compile/configs/:configId — update a config
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const config = locals.db.prepare(
		'SELECT * FROM compile_configs WHERE id = ? AND novel_id = ?'
	).get(params.configId, params.id);
	if (!config) throw error(404, 'Config not found');

	const body = await request.json();
	const now = new Date().toISOString();

	if (body.format && !VALID_FORMATS.includes(body.format as CompileFormat)) {
		throw error(400, `Invalid format. Must be one of: ${VALID_FORMATS.join(', ')}`);
	}

	// Build dynamic SET clause — only update provided fields (allows clearing include_ids to null)
	const sets: string[] = ['updated_at = ?'];
	const values: any[] = [now];

	if (body.name) {
		sets.push('name = ?');
		values.push(body.name);
	}
	if (body.format) {
		sets.push('format = ?');
		values.push(body.format);
	}
	if (body.include_ids !== undefined) {
		sets.push('include_ids = ?');
		values.push(body.include_ids ? JSON.stringify(body.include_ids) : null);
	}

	values.push(params.configId, params.id);
	locals.db.prepare(`UPDATE compile_configs SET ${sets.join(', ')} WHERE id = ? AND novel_id = ?`).run(...values);

	const updated = locals.db.prepare('SELECT * FROM compile_configs WHERE id = ?').get(params.configId);
	return json(updated);
};

// DELETE /api/novels/:id/compile/configs/:configId — delete a config
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const config = locals.db.prepare(
		'SELECT * FROM compile_configs WHERE id = ? AND novel_id = ?'
	).get(params.configId, params.id);
	if (!config) throw error(404, 'Config not found');

	locals.db.prepare('DELETE FROM compile_configs WHERE id = ? AND novel_id = ?').run(params.configId, params.id);

	return json({ success: true });
};

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

	const includeIdsJson = body.include_ids !== undefined
		? (body.include_ids ? JSON.stringify(body.include_ids) : null)
		: undefined;

	locals.db.prepare(`
		UPDATE compile_configs SET
			name = COALESCE(?, name),
			format = COALESCE(?, format),
			include_ids = COALESCE(?, include_ids),
			updated_at = ?
		WHERE id = ? AND novel_id = ?
	`).run(body.name || null, body.format || null, includeIdsJson ?? null, now, params.configId, params.id);

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

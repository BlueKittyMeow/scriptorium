import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { v4 as uuid } from 'uuid';
import { VALID_FORMATS } from '$lib/server/compile/types.js';
import type { CompileFormat } from '$lib/server/compile/types.js';

// GET /api/novels/:id/compile/configs — list all configs for a novel
export const GET: RequestHandler = async ({ params, locals }) => {
	const novel = locals.db.prepare('SELECT id FROM novels WHERE id = ? AND deleted_at IS NULL').get(params.id);
	if (!novel) throw error(404, 'Novel not found');

	const configs = locals.db.prepare(
		'SELECT * FROM compile_configs WHERE novel_id = ? ORDER BY created_at DESC'
	).all(params.id);

	return json(configs);
};

// POST /api/novels/:id/compile/configs — create a new config
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const novel = locals.db.prepare('SELECT id FROM novels WHERE id = ? AND deleted_at IS NULL').get(params.id);
	if (!novel) throw error(404, 'Novel not found');

	const body = await request.json();
	const { name, format, include_ids } = body;

	if (!name || typeof name !== 'string') {
		throw error(400, 'Name is required');
	}

	if (!format || !VALID_FORMATS.includes(format as CompileFormat)) {
		throw error(400, `Invalid format. Must be one of: ${VALID_FORMATS.join(', ')}`);
	}

	const now = new Date().toISOString();
	const id = uuid();
	const includeIdsJson = include_ids ? JSON.stringify(include_ids) : null;

	locals.db.prepare(`
		INSERT INTO compile_configs (id, novel_id, name, format, include_ids, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(id, params.id, name, format, includeIdsJson, now, now);

	const config = locals.db.prepare('SELECT * FROM compile_configs WHERE id = ?').get(id);
	return json(config, { status: 201 });
};

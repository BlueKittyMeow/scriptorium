import { getDb } from '$lib/server/db.js';
import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.db = getDb();
	return resolve(event);
};

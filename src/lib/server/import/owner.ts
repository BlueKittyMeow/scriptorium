/**
 * Resolve the owner_id for an import. Archivist-only assignment: an archivist
 * may hand a novel to any existing user; a writer (or an archivist naming a
 * non-existent user) always owns the import themselves.
 *
 * Shared by the .scriv batch import and the bundle import endpoints so both
 * enforce the same rule. NOTE: this is ownership *tagging* only — no
 * permission enforcement rides on owner_id yet.
 */
export function resolveOwnerId(locals: App.Locals, requested: unknown): string {
	const self = locals.user!.id;
	if (locals.user!.role !== 'archivist') return self;
	if (typeof requested !== 'string' || !requested) return self;
	const exists = locals.db.prepare('SELECT id FROM users WHERE id = ?').get(requested);
	return exists ? requested : self;
}

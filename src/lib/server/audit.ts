import crypto from 'crypto';
import type Database from 'better-sqlite3';

/**
 * Log an action to the audit trail.
 * Called on significant events: login, user management, novel CRUD, import, etc.
 * Document saves are logged on close/switch only — not on every autosave.
 */
export function logAction(
	db: Database.Database,
	userId: string,
	action: string,
	entityType?: string,
	entityId?: string,
	details?: string
): void {
	const id = crypto.randomUUID();
	const createdAt = new Date().toISOString();

	db.prepare(
		`INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, details, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	).run(id, userId, action, entityType ?? null, entityId ?? null, details ?? null, createdAt);
}

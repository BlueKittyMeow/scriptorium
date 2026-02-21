import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { error } from '@sveltejs/kit';
import type { User } from '$lib/types.js';

export const SESSION_COOKIE_NAME = 'scriptorium-session';
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds
export const SESSION_EXTEND_THRESHOLD = 7 * 24 * 60 * 60; // 7 days in seconds
const BCRYPT_COST = 12;

// ─── Password Hashing ────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
	return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
	return bcrypt.compare(password, hash);
}

// ─── Session Token Hashing ───────────────────────────────────────

export function hashSessionToken(token: string): string {
	return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── Session Management ─────────────────────────────────────────

export async function createSession(
	db: Database.Database,
	userId: string
): Promise<{ token: string; expiresAt: string }> {
	const token = crypto.randomBytes(32).toString('hex');
	const tokenHash = hashSessionToken(token);
	const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();
	const createdAt = new Date().toISOString();

	db.prepare(
		'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
	).run(tokenHash, userId, expiresAt, createdAt);

	return { token, expiresAt };
}

export async function validateSession(
	db: Database.Database,
	token: string
): Promise<{ user: User } | null> {
	const tokenHash = hashSessionToken(token);

	const row = db
		.prepare(
			`SELECT s.token_hash, s.expires_at, u.id, u.username, u.role, u.created_at, u.updated_at
		 FROM sessions s
		 JOIN users u ON s.user_id = u.id
		 WHERE s.token_hash = ?`
		)
		.get(tokenHash) as
		| {
				token_hash: string;
				expires_at: string;
				id: string;
				username: string;
				role: 'writer' | 'archivist';
				created_at: string;
				updated_at: string;
		  }
		| undefined;

	if (!row) return null;

	// Check expiry
	if (new Date(row.expires_at) <= new Date()) {
		// Clean up expired session
		db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
		return null;
	}

	return {
		user: {
			id: row.id,
			username: row.username,
			role: row.role,
			created_at: row.created_at,
			updated_at: row.updated_at
		}
	};
}

/**
 * Extend session expiry — but only if within SESSION_EXTEND_THRESHOLD of expiry.
 * This avoids DB thrash from autosave requests.
 */
export function extendSession(
	db: Database.Database,
	tokenHash: string,
	currentExpiry: Date
): void {
	const remainingMs = currentExpiry.getTime() - Date.now();
	const thresholdMs = SESSION_EXTEND_THRESHOLD * 1000;

	if (remainingMs > thresholdMs) {
		// More than 7 days left — don't extend
		return;
	}

	const newExpiry = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();
	db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(newExpiry, tokenHash);
}

export function destroySession(db: Database.Database, tokenHash: string): void {
	db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function destroyUserSessions(db: Database.Database, userId: string): void {
	db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function cleanExpiredSessions(db: Database.Database): void {
	db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

// ─── Route Guards ───────────────────────────────────────────────

export function requireUser(locals: App.Locals): User {
	if (!locals.user) {
		throw error(401, 'Authentication required');
	}
	return locals.user;
}

export function requireArchivist(locals: App.Locals): User {
	const user = requireUser(locals);
	if (user.role !== 'archivist') {
		throw error(403, 'Archivist role required');
	}
	return user;
}

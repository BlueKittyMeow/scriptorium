#!/usr/bin/env node

/**
 * Emergency password reset for Scriptorium.
 * Usage: node scripts/reset-password.js <username>
 *
 * For self-hosted apps with no email recovery, this is the escape hatch
 * when the archivist forgets their password.
 */

import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import readline from 'readline';
import path from 'path';
import fs from 'fs';

const DATA_ROOT = process.env.DATA_ROOT || './data';
const dbPath = path.join(DATA_ROOT, 'scriptorium.db');

if (!fs.existsSync(dbPath)) {
	console.error(`Database not found at ${dbPath}`);
	console.error('Set DATA_ROOT environment variable if your data is elsewhere.');
	process.exit(1);
}

const username = process.argv[2];
if (!username) {
	console.error('Usage: node scripts/reset-password.js <username>');
	process.exit(1);
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const user = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);
if (!user) {
	console.error(`User "${username}" not found.`);
	const users = db.prepare('SELECT username, role FROM users').all();
	if (users.length > 0) {
		console.error('Available users:', users.map(u => `${u.username} (${u.role})`).join(', '));
	}
	process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function question(prompt) {
	return new Promise(resolve => rl.question(prompt, resolve));
}

async function main() {
	console.log(`Resetting password for: ${user.username} (${user.role})`);

	const password = await question('New password (min 8 chars): ');
	if (password.length < 8) {
		console.error('Password must be at least 8 characters.');
		process.exit(1);
	}

	const confirm = await question('Confirm password: ');
	if (password !== confirm) {
		console.error('Passwords do not match.');
		process.exit(1);
	}

	const hash = await bcrypt.hash(password, 12);
	const now = new Date().toISOString();

	db.transaction(() => {
		db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now, user.id);

		// Hash-based session storage — delete by user_id
		db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
	})();

	console.log(`Password reset for "${user.username}". All sessions invalidated.`);
	rl.close();
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});

#!/usr/bin/env node

/**
 * Deploy activity check — step 1 of the deploy protocol in docs/operations.md.
 * Usage: node scripts/activity-check.js [minutes]   (default 10)
 *
 * A restart mid-keystroke is the only real user-facing risk of a deploy, so
 * this answers "is anyone writing right now?" before we restart the service.
 *
 * Exits 0 when quiet and 1 when active, so it can gate the deploy directly:
 *   node scripts/activity-check.js && git pull --ff-only && npm run build \
 *     && sudo systemctl restart scriptorium
 *
 * This exists as a file rather than the `node -e` one-liner the runbook used to
 * carry, for two reasons found the hard way on 2026-08-02:
 *   1. The SQL contains single quotes (datetime('now','-10 minutes')), which
 *      collide with the single quotes wrapping an `ssh host '…'` command — the
 *      inner quotes end the outer string and SQLite gets a syntax error.
 *   2. Node resolves `better-sqlite3` relative to the *script's* directory, not
 *      the cwd, so a copy dropped in /tmp fails with MODULE_NOT_FOUND however
 *      you cd first. Living in the repo, it just works.
 */

import Database from 'better-sqlite3';
import path from 'path';

const DATA_ROOT = process.env.DATA_ROOT || './data';
const dbPath = process.env.DB || path.join(DATA_ROOT, 'scriptorium.db');
const minutes = Number(process.argv[2] ?? 10);

if (!Number.isFinite(minutes) || minutes <= 0) {
	console.error(`Not a positive number of minutes: ${process.argv[2]}`);
	process.exit(2);
}

const db = new Database(dbPath, { readonly: true });

// datetime() on BOTH sides is load-bearing. We store ISO-8601
// ('2026-07-25T04:33:21.893Z'); SQLite's datetime('now') returns
// '2026-07-25 22:22:58'. Compared as raw strings that pits 'T' against ' ',
// and 'T' sorts higher — so every document touched today reads as active. The
// runbook's earlier snippet omitted the wrapper and reported 12 active writers
// when the last write was 18 hours old (caught 2026-07-25).
const { c: active } = db
	.prepare(
		`SELECT COUNT(*) c FROM documents
		 WHERE datetime(updated_at) > datetime('now', ?)`
	)
	.get(`-${minutes} minutes`);

const { m: lastWrite } = db.prepare('SELECT MAX(datetime(updated_at)) m FROM documents').get();
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

console.log(
	active ? 'ACTIVE — wait' : 'quiet — safe to restart',
	`| docs written in the last ${minutes}m: ${active}`,
	`| last write (UTC): ${lastWrite ?? 'never'}`,
	`| now (UTC): ${now}`
);

process.exit(active ? 1 : 0);

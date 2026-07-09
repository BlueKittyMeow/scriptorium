import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from './helpers.js';
import path from 'path';

/**
 * P1-10 part 1: Scrivener front matter (Title Page, Copyright, Dedication,
 * Blank Page, etc. under a folder titled "Front Matter") imports as ordinary
 * chapters today, with raw <$PROJECTTITLE>-style placeholders becoming
 * chapter one of the compiled output.
 *
 * Fix: docs under a folder titled "Front Matter" (case-insensitive, any
 * depth) import with compile_include = 0, and the import report gets a
 * warning: "Front matter excluded from compile — review in the binder".
 *
 * test-data/ (Talamus.scriv, Scrivener 2 format) has a real "Front Matter"
 * folder containing nested subfolders (Manuscript Format, Paperback Novel,
 * E-Book) whose Text children are "Title Page" / "Copyright" / "Dedication" /
 * "Blank Page" docs — a good real-world multi-depth fixture.
 */

let db: Database.Database;

beforeEach(() => {
	db = createTestDb();
});

describe('P1-10 part 1: front matter excluded from compile', () => {
	it('marks docs nested under "Front Matter" (any depth) as compile_include = 0', async () => {
		const { importScriv } = await import('$lib/server/import/scriv.js');
		const scrivDir = path.resolve('test-data');

		const report = await importScriv(db, scrivDir);
		expect(report.errors).toHaveLength(0);

		// Title Page / Copyright / Dedication / Blank Page all live two levels
		// deep under the "Front Matter" folder (Front Matter > {Manuscript
		// Format,Paperback Novel,E-Book} > doc).
		const frontMatterTitles = ['Title Page', 'Copyright', 'Dedication', 'Blank Page'];
		const rows = db
			.prepare(
				`SELECT title, compile_include FROM documents WHERE novel_id = ? AND title IN (${frontMatterTitles.map(() => '?').join(',')})`
			)
			.all(report.novel_id, ...frontMatterTitles) as any[];

		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.compile_include).toBe(0);
		}
	});

	it('leaves docs outside "Front Matter" with their normal compile_include value', async () => {
		const { importScriv } = await import('$lib/server/import/scriv.js');
		const scrivDir = path.resolve('test-data');

		const report = await importScriv(db, scrivDir);

		// "Scene" (under Manuscript > Chapter) has IncludeInCompile=Yes and is
		// not under Front Matter, so it should keep compile_include = 1.
		const scene = db.prepare('SELECT compile_include FROM documents WHERE novel_id = ? AND title = ?').get(report.novel_id, 'Scene') as any;
		expect(scene).toBeTruthy();
		expect(scene.compile_include).toBe(1);
	});

	it('adds a single front-matter warning to the import report', async () => {
		const { importScriv } = await import('$lib/server/import/scriv.js');
		const scrivDir = path.resolve('test-data');

		const report = await importScriv(db, scrivDir);

		const warning = 'Front matter excluded from compile — review in the binder';
		const matches = report.warnings.filter((w) => w === warning);
		expect(matches.length).toBe(1);
	});
});

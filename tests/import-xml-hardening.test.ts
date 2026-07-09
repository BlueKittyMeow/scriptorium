import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from './helpers.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * P1-9 [verified]: fast-xml-parser's default parseTagValue coerces tag text
 * to JS primitives (numbers/booleans). This mangles or crashes import for
 * binder items whose Title happens to look like a number or boolean:
 *
 *   <Title>42</Title>    -> number 42 -> folder branch calls .toLowerCase()
 *                           on a number and throws, aborting the whole import
 *   <Title>3.10</Title>  -> number 3.1 (silent, incorrect rename)
 *   <Title>true</Title>  -> boolean true, collapses via `||` fallback
 *   <Title></Title>      -> empty string, should become '(untitled)'
 *
 * Fix: parseTagValue: false on the XMLParser, plus defensive String()
 * coercion at every point a title (or label/status #text) is read.
 */

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
	db = createTestDb();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriv-xml-coerce-'));
});

function buildFixture(): string {
	const scrivDir = path.join(tmpDir, 'Coerce.scriv');
	fs.mkdirSync(path.join(scrivDir, 'Files', 'Docs'), { recursive: true });

	const scrivx = `<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject>
  <Binder>
    <BinderItem ID="1" Type="Folder" Created="" Modified="">
      <Title>42</Title>
    </BinderItem>
    <BinderItem ID="2" Type="Text" Created="" Modified="">
      <Title>3.10</Title>
    </BinderItem>
    <BinderItem ID="3" Type="Text" Created="" Modified="">
      <Title>true</Title>
    </BinderItem>
    <BinderItem ID="4" Type="Text" Created="" Modified="">
      <Title></Title>
    </BinderItem>
  </Binder>
</ScrivenerProject>`;

	fs.writeFileSync(path.join(scrivDir, 'Coerce.scrivx'), scrivx);
	return scrivDir;
}

describe('P1-9: XML tag value coercion hardening', () => {
	it('imports a numeric-looking folder title verbatim without aborting', async () => {
		const scrivDir = buildFixture();
		const { importScriv } = await import('$lib/server/import/scriv.js');

		const report = await importScriv(db, scrivDir);

		// Should not have aborted (no "Import aborted" error)
		expect(report.errors.some((e) => e.includes('Import aborted'))).toBe(false);

		const folder = db.prepare('SELECT title FROM folders WHERE novel_id = ?').get(report.novel_id) as any;
		expect(folder).toBeTruthy();
		expect(folder.title).toBe('42');
	});

	it('imports a decimal-looking document title verbatim (not silently renamed)', async () => {
		const scrivDir = buildFixture();
		const { importScriv } = await import('$lib/server/import/scriv.js');

		const report = await importScriv(db, scrivDir);

		const doc = db.prepare('SELECT title FROM documents WHERE novel_id = ? AND title = ?').get(report.novel_id, '3.10') as any;
		expect(doc).toBeTruthy();
		expect(doc.title).toBe('3.10');
	});

	it('imports a boolean-looking document title verbatim', async () => {
		const scrivDir = buildFixture();
		const { importScriv } = await import('$lib/server/import/scriv.js');

		const report = await importScriv(db, scrivDir);

		const doc = db.prepare('SELECT title FROM documents WHERE novel_id = ? AND title = ?').get(report.novel_id, 'true') as any;
		expect(doc).toBeTruthy();
		expect(doc.title).toBe('true');
	});

	it('falls back to (untitled) for an empty title, without mangling others', async () => {
		const scrivDir = buildFixture();
		const { importScriv } = await import('$lib/server/import/scriv.js');

		const report = await importScriv(db, scrivDir);

		const doc = db.prepare('SELECT title FROM documents WHERE novel_id = ? AND title = ?').get(report.novel_id, '(untitled)') as any;
		expect(doc).toBeTruthy();

		// All four binder items should have imported: 1 folder + 3 documents
		const folders = db.prepare('SELECT COUNT(*) as c FROM folders WHERE novel_id = ?').get(report.novel_id) as any;
		const documents = db.prepare('SELECT COUNT(*) as c FROM documents WHERE novel_id = ?').get(report.novel_id) as any;
		expect(folders.c).toBe(1);
		expect(documents.c).toBe(3);
	});
});

describe('P1-9: extractBodyContent regex hardening', () => {
	it('matches a <body> tag that carries attributes', () => {
		const source = fs.readFileSync('src/lib/server/import/scriv.ts', 'utf-8');
		expect(source).toContain('/<body[^>]*>([\\s\\S]*)<\\/body>/');
	});
});

describe('P1-9: XMLParser configuration', () => {
	it('disables parseTagValue so numeric/boolean-looking text stays a string', () => {
		const source = fs.readFileSync('src/lib/server/import/scriv.ts', 'utf-8');
		expect(source).toMatch(/parseTagValue:\s*false/);
	});
});

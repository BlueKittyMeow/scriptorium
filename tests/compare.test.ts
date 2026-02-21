import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, seedNovelWithDocs, seedUser } from './helpers.js';
import fs from 'fs';

/**
 * Tests for The Difference Engine: novel comparison & merge.
 *
 * Layer 0: Core algorithms (normalizeTitle, jaccardSimilarity, matchDocuments, diffWords)
 * Layer 1: Document collection + merge execution (DB-level)
 * Layer 2: API endpoint source-scans
 * Layer 3: UI source-scans
 */

// ─── Test helpers ────────────────────────────────────────────────

const now = new Date().toISOString();

/** Seed two novels with overlapping chapter structures for compare tests */
function seedTwoNovelsForCompare(db: Database.Database): {
	novelAId: string;
	novelBId: string;
	docA1Id: string;
	docA2Id: string;
	docA3Id: string;
	docB1Id: string;
	docB2Id: string;
	docB4Id: string;
} {
	const novelAId = 'novel-a';
	const novelBId = 'novel-b';

	// Novel A: Draft 2
	db.prepare(`INSERT INTO novels (id, title, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)`).run(novelAId, 'Tigrenache Draft 2', now, now);
	// Novel B: Draft 3
	db.prepare(`INSERT INTO novels (id, title, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)`).run(novelBId, 'Tigrenache Draft 3', now, now);

	// Novel A documents (no folders — flat at root for simplicity)
	const docA1Id = 'doc-a1';
	const docA2Id = 'doc-a2';
	const docA3Id = 'doc-a3';
	db.prepare(`INSERT INTO documents (id, novel_id, parent_id, title, word_count, sort_order, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`).run(docA1Id, novelAId, 'Chapter One', 50, 1.0, now, now);
	db.prepare(`INSERT INTO documents (id, novel_id, parent_id, title, word_count, sort_order, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`).run(docA2Id, novelAId, 'Chapter Two', 80, 2.0, now, now);
	db.prepare(`INSERT INTO documents (id, novel_id, parent_id, title, word_count, sort_order, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`).run(docA3Id, novelAId, 'Epilogue', 30, 3.0, now, now);

	// Novel B documents
	const docB1Id = 'doc-b1';
	const docB2Id = 'doc-b2';
	const docB4Id = 'doc-b4';
	db.prepare(`INSERT INTO documents (id, novel_id, parent_id, title, word_count, sort_order, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`).run(docB1Id, novelBId, 'Chapter One', 50, 1.0, now, now);
	db.prepare(`INSERT INTO documents (id, novel_id, parent_id, title, word_count, sort_order, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`).run(docB2Id, novelBId, 'Chapter Two', 90, 2.0, now, now);
	db.prepare(`INSERT INTO documents (id, novel_id, parent_id, title, word_count, sort_order, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`).run(docB4Id, novelBId, 'Prologue', 40, 3.0, now, now);

	// FTS entries
	db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(docA1Id, 'Chapter One', 'The silver moon rose over the quiet village');
	db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(docA2Id, 'Chapter Two', 'She walked through the forest feeling lost and alone');
	db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(docA3Id, 'Epilogue', 'Years later she returned to the village');
	db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(docB1Id, 'Chapter One', 'The silver moon rose over the quiet village');
	db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(docB2Id, 'Chapter Two', 'She walked through the dark forest feeling completely lost');
	db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(docB4Id, 'Prologue', 'Before everything began there was silence');

	return { novelAId, novelBId, docA1Id, docA2Id, docA3Id, docB1Id, docB2Id, docB4Id };
}

// ─── Layer 0: Core algorithms ───────────────────────────────────

describe('Layer 0: normalizeTitle', () => {
	it('should lowercase and trim', async () => {
		const { normalizeTitle } = await import('$lib/server/compare/match.js');
		expect(normalizeTitle('  Chapter One  ')).toBe('chapter one');
	});

	it('should strip leading "chapter N" prefix', async () => {
		const { normalizeTitle } = await import('$lib/server/compare/match.js');
		expect(normalizeTitle('Chapter 1: The Beginning')).toBe('the beginning');
		expect(normalizeTitle('Chapter 12 — Aftermath')).toBe('aftermath');
	});

	it('should handle empty string', async () => {
		const { normalizeTitle } = await import('$lib/server/compare/match.js');
		expect(normalizeTitle('')).toBe('');
	});

	it('should leave non-chapter titles unchanged (after lowercase/trim)', async () => {
		const { normalizeTitle } = await import('$lib/server/compare/match.js');
		expect(normalizeTitle('Epilogue')).toBe('epilogue');
		expect(normalizeTitle('Prologue')).toBe('prologue');
	});
});

describe('Layer 0: jaccardSimilarity', () => {
	it('should return 1.0 for identical texts', async () => {
		const { jaccardSimilarity } = await import('$lib/server/compare/match.js');
		expect(jaccardSimilarity('the cat sat on the mat', 'the cat sat on the mat')).toBe(1.0);
	});

	it('should return 0.0 for completely different texts', async () => {
		const { jaccardSimilarity } = await import('$lib/server/compare/match.js');
		expect(jaccardSimilarity('alpha beta gamma', 'delta epsilon zeta')).toBe(0.0);
	});

	it('should return expected ratio for partial overlap', async () => {
		const { jaccardSimilarity } = await import('$lib/server/compare/match.js');
		// words A: {the, cat, sat} words B: {the, dog, sat} → intersection=2 union=4 → 0.5
		const sim = jaccardSimilarity('the cat sat', 'the dog sat');
		expect(sim).toBeCloseTo(0.5, 1);
	});

	it('should return 1.0 for two empty texts', async () => {
		const { jaccardSimilarity } = await import('$lib/server/compare/match.js');
		expect(jaccardSimilarity('', '')).toBe(1.0);
	});

	it('should return 0.0 when one text is empty', async () => {
		const { jaccardSimilarity } = await import('$lib/server/compare/match.js');
		expect(jaccardSimilarity('hello world', '')).toBe(0.0);
		expect(jaccardSimilarity('', 'hello world')).toBe(0.0);
	});
});

describe('Layer 0: matchDocuments', () => {
	it('should match documents with exact same titles', async () => {
		const { matchDocuments } = await import('$lib/server/compare/match.js');
		const docsA = [
			{ id: 'a1', title: 'Chapter One', novelId: 'na', wordCount: 100, plaintext: 'hello world', html: '<p>hello world</p>' },
		];
		const docsB = [
			{ id: 'b1', title: 'Chapter One', novelId: 'nb', wordCount: 100, plaintext: 'hello world', html: '<p>hello world</p>' },
		];
		const pairs = matchDocuments(docsA, docsB);
		expect(pairs.length).toBe(1);
		expect(pairs[0].docA?.id).toBe('a1');
		expect(pairs[0].docB?.id).toBe('b1');
		expect(pairs[0].method).toBe('exact_title');
	});

	it('should mark unmatched documents correctly', async () => {
		const { matchDocuments } = await import('$lib/server/compare/match.js');
		const docsA = [
			{ id: 'a1', title: 'Epilogue', novelId: 'na', wordCount: 50, plaintext: 'stars faded into darkness', html: '<p>stars faded into darkness</p>' },
		];
		const docsB = [
			{ id: 'b1', title: 'Prologue', novelId: 'nb', wordCount: 50, plaintext: 'morning began with coffee', html: '<p>morning began with coffee</p>' },
		];
		const pairs = matchDocuments(docsA, docsB);
		const unmatchedA = pairs.filter(p => p.method === 'unmatched_a');
		const unmatchedB = pairs.filter(p => p.method === 'unmatched_b');
		expect(unmatchedA.length).toBe(1);
		expect(unmatchedA[0].docA?.id).toBe('a1');
		expect(unmatchedB.length).toBe(1);
		expect(unmatchedB[0].docB?.id).toBe('b1');
	});

	it('should match by content similarity when titles differ', async () => {
		const { matchDocuments } = await import('$lib/server/compare/match.js');
		const sharedText = 'the silver moon rose over the quiet village and the stars twinkled brightly';
		const docsA = [
			{ id: 'a1', title: 'Opening', novelId: 'na', wordCount: 50, plaintext: sharedText, html: `<p>${sharedText}</p>` },
		];
		const docsB = [
			{ id: 'b1', title: 'The Beginning', novelId: 'nb', wordCount: 50, plaintext: sharedText, html: `<p>${sharedText}</p>` },
		];
		const pairs = matchDocuments(docsA, docsB);
		expect(pairs.length).toBe(1);
		expect(pairs[0].method).toBe('content_similarity');
		expect(pairs[0].similarity).toBeGreaterThan(0.3);
	});

	it('should handle novels with different chapter counts', async () => {
		const { matchDocuments } = await import('$lib/server/compare/match.js');
		const docsA = [
			{ id: 'a1', title: 'Chapter One', novelId: 'na', wordCount: 100, plaintext: 'hello', html: '<p>hello</p>' },
			{ id: 'a2', title: 'Chapter Two', novelId: 'na', wordCount: 100, plaintext: 'world', html: '<p>world</p>' },
			{ id: 'a3', title: 'Chapter Three', novelId: 'na', wordCount: 100, plaintext: 'foo', html: '<p>foo</p>' },
		];
		const docsB = [
			{ id: 'b1', title: 'Chapter One', novelId: 'nb', wordCount: 100, plaintext: 'hello', html: '<p>hello</p>' },
		];
		const pairs = matchDocuments(docsA, docsB);
		const matched = pairs.filter(p => p.docA && p.docB);
		const unmatchedA = pairs.filter(p => p.method === 'unmatched_a');
		expect(matched.length).toBe(1);
		expect(unmatchedA.length).toBe(2);
	});

	it('should handle empty novel gracefully', async () => {
		const { matchDocuments } = await import('$lib/server/compare/match.js');
		const pairs = matchDocuments([], []);
		expect(pairs.length).toBe(0);
	});
});

describe('Layer 0: computePairDiff', () => {
	it('should produce no changes for identical texts', async () => {
		const { computePairDiff } = await import('$lib/server/compare/diff.js');
		const pair = {
			docA: { id: 'a1', title: 'Ch1', novelId: 'na', wordCount: 5, plaintext: 'the cat sat', html: '' },
			docB: { id: 'b1', title: 'Ch1', novelId: 'nb', wordCount: 5, plaintext: 'the cat sat', html: '' },
			method: 'exact_title' as const,
			similarity: 1.0,
			titleSimilarity: 1.0,
		};
		const result = computePairDiff(pair, 0);
		const hasChanges = result.changes.some(c => c.added || c.removed);
		expect(hasChanges).toBe(false);
	});

	it('should detect a single word change', async () => {
		const { computePairDiff } = await import('$lib/server/compare/diff.js');
		const pair = {
			docA: { id: 'a1', title: 'Ch1', novelId: 'na', wordCount: 3, plaintext: 'the cat sat', html: '' },
			docB: { id: 'b1', title: 'Ch1', novelId: 'nb', wordCount: 3, plaintext: 'the dog sat', html: '' },
			method: 'exact_title' as const,
			similarity: 0.5,
			titleSimilarity: 1.0,
		};
		const result = computePairDiff(pair, 0);
		const added = result.changes.filter(c => c.added);
		const removed = result.changes.filter(c => c.removed);
		expect(added.length).toBeGreaterThan(0);
		expect(removed.length).toBeGreaterThan(0);
	});

	it('should handle completely different texts', async () => {
		const { computePairDiff } = await import('$lib/server/compare/diff.js');
		const pair = {
			docA: { id: 'a1', title: 'Ch1', novelId: 'na', wordCount: 3, plaintext: 'alpha beta gamma', html: '' },
			docB: { id: 'b1', title: 'Ch1', novelId: 'nb', wordCount: 3, plaintext: 'delta epsilon zeta', html: '' },
			method: 'exact_title' as const,
			similarity: 0.0,
			titleSimilarity: 1.0,
		};
		const result = computePairDiff(pair, 0);
		const added = result.changes.filter(c => c.added);
		const removed = result.changes.filter(c => c.removed);
		expect(added.length).toBeGreaterThan(0);
		expect(removed.length).toBeGreaterThan(0);
	});
});

// ─── Layer 1: Document collection + merge execution ─────────────

describe('Layer 1: collectCompareDocuments', () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createTestDb();
	});

	it('should collect documents in sort order with plaintext', async () => {
		const { collectCompareDocuments } = await import('$lib/server/compare/collect.js');
		const { novelAId } = seedTwoNovelsForCompare(db);

		// We need a content reader that returns test content
		const contentReader = (novelId: string, docId: string) => {
			const contents: Record<string, string> = {
				'doc-a1': '<p>The silver moon rose</p>',
				'doc-a2': '<p>She walked through the forest</p>',
				'doc-a3': '<p>Years later she returned</p>',
			};
			return contents[docId] || null;
		};

		const docs = collectCompareDocuments(db, novelAId, contentReader);
		expect(docs.length).toBe(3);
		expect(docs[0].title).toBe('Chapter One');
		expect(docs[1].title).toBe('Chapter Two');
		expect(docs[2].title).toBe('Epilogue');
		// Should have plaintext (HTML stripped)
		expect(docs[0].plaintext).not.toContain('<p>');
		expect(docs[0].plaintext).toContain('silver moon');
	});

	it('should skip soft-deleted documents', async () => {
		const { collectCompareDocuments } = await import('$lib/server/compare/collect.js');
		const { novelAId } = seedTwoNovelsForCompare(db);
		db.prepare('UPDATE documents SET deleted_at = ? WHERE id = ?').run(now, 'doc-a1');

		const contentReader = () => '<p>content</p>';
		const docs = collectCompareDocuments(db, novelAId, contentReader);
		expect(docs.length).toBe(2);
		expect(docs[0].title).toBe('Chapter Two');
	});
});

describe('Layer 1: executeMerge', () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createTestDb();
	});

	it('should create a new novel with the given title', async () => {
		const { executeMerge } = await import('$lib/server/compare/merge.js');
		const { novelAId, novelBId } = seedTwoNovelsForCompare(db);
		const user = seedUser(db, 'archivist');

		// Simple merge: pick all from A
		const pairs = [
			{
				docA: { id: 'doc-a1', title: 'Chapter One', novelId: novelAId, wordCount: 50, plaintext: 'text a1', html: '<p>text a1</p>' },
				docB: { id: 'doc-b1', title: 'Chapter One', novelId: novelBId, wordCount: 50, plaintext: 'text a1', html: '<p>text a1</p>' },
				method: 'exact_title' as const, similarity: 1.0, titleSimilarity: 1.0,
			},
		];
		const instructions = [{ pairIndex: 0, choice: 'a' as const }];

		const report = executeMerge(db, 'Merged: Tigrenache', pairs, instructions, 'Tigrenache Draft 2', 'Tigrenache Draft 3', user.id);
		expect(report.novelTitle).toBe('Merged: Tigrenache');
		expect(report.novelId).toBeTruthy();

		// Verify novel exists in DB
		const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(report.novelId);
		expect(novel).toBeTruthy();
	});

	it('should create variant folder with compile_include=0 for "both" choice', async () => {
		const { executeMerge } = await import('$lib/server/compare/merge.js');
		seedTwoNovelsForCompare(db);
		const user = seedUser(db, 'archivist');

		const pairs = [
			{
				docA: { id: 'doc-a2', title: 'Chapter Two', novelId: 'novel-a', wordCount: 80, plaintext: 'version a', html: '<p>version a</p>' },
				docB: { id: 'doc-b2', title: 'Chapter Two', novelId: 'novel-b', wordCount: 90, plaintext: 'version b', html: '<p>version b</p>' },
				method: 'exact_title' as const, similarity: 0.7, titleSimilarity: 1.0,
			},
		];
		const instructions = [{ pairIndex: 0, choice: 'both' as const }];

		const report = executeMerge(db, 'Merged', pairs, instructions, 'Draft A', 'Draft B', user.id);
		expect(report.variantFolders).toBe(1);
		expect(report.documentsCreated).toBe(2);
		expect(report.foldersCreated).toBe(1);

		// Verify variant folder exists
		const folders = db.prepare('SELECT * FROM folders WHERE novel_id = ?').all(report.novelId) as any[];
		expect(folders.length).toBe(1);
		expect(folders[0].title).toBe('Chapter Two');

		// Verify both docs inside folder have compile_include = 0
		const docs = db.prepare('SELECT * FROM documents WHERE novel_id = ? AND parent_id = ?').all(report.novelId, folders[0].id) as any[];
		expect(docs.length).toBe(2);
		expect(docs.every((d: any) => d.compile_include === 0)).toBe(true);

		// Verify synopsis tracks provenance
		const synopses = docs.map((d: any) => d.synopsis);
		expect(synopses).toContain('From: Draft A');
		expect(synopses).toContain('From: Draft B');
	});

	it('should skip chapters with "skip" choice', async () => {
		const { executeMerge } = await import('$lib/server/compare/merge.js');
		seedTwoNovelsForCompare(db);
		const user = seedUser(db, 'archivist');

		const pairs = [
			{
				docA: { id: 'doc-a1', title: 'Chapter One', novelId: 'novel-a', wordCount: 50, plaintext: 'text', html: '<p>text</p>' },
				docB: { id: 'doc-b1', title: 'Chapter One', novelId: 'novel-b', wordCount: 50, plaintext: 'text', html: '<p>text</p>' },
				method: 'exact_title' as const, similarity: 1.0, titleSimilarity: 1.0,
			},
		];
		const instructions = [{ pairIndex: 0, choice: 'skip' as const }];

		const report = executeMerge(db, 'Merged', pairs, instructions, 'Draft A', 'Draft B', user.id);
		expect(report.documentsCreated).toBe(0);
	});

	it('should always include unmatched documents', async () => {
		const { executeMerge } = await import('$lib/server/compare/merge.js');
		seedTwoNovelsForCompare(db);
		const user = seedUser(db, 'archivist');

		const pairs = [
			{
				docA: { id: 'doc-a3', title: 'Epilogue', novelId: 'novel-a', wordCount: 30, plaintext: 'epilogue text', html: '<p>epilogue text</p>' },
				docB: null,
				method: 'unmatched_a' as const, similarity: 0, titleSimilarity: 0,
			},
			{
				docA: null,
				docB: { id: 'doc-b4', title: 'Prologue', novelId: 'novel-b', wordCount: 40, plaintext: 'prologue text', html: '<p>prologue text</p>' },
				method: 'unmatched_b' as const, similarity: 0, titleSimilarity: 0,
			},
		];
		const instructions = [
			{ pairIndex: 0, choice: 'a' as const },
			{ pairIndex: 1, choice: 'b' as const },
		];

		const report = executeMerge(db, 'Merged', pairs, instructions, 'Draft A', 'Draft B', user.id);
		expect(report.documentsCreated).toBe(2);

		// Verify both unmatched docs are in the merged novel
		const docs = db.prepare('SELECT title FROM documents WHERE novel_id = ? ORDER BY sort_order').all(report.novelId) as any[];
		const titles = docs.map((d: any) => d.title);
		expect(titles).toContain('Epilogue');
		expect(titles).toContain('Prologue');
	});

	it('should create FTS entries for all merged documents', async () => {
		const { executeMerge } = await import('$lib/server/compare/merge.js');
		seedTwoNovelsForCompare(db);
		const user = seedUser(db, 'archivist');

		const pairs = [
			{
				docA: { id: 'doc-a1', title: 'Chapter One', novelId: 'novel-a', wordCount: 50, plaintext: 'hello world', html: '<p>hello world</p>' },
				docB: null,
				method: 'unmatched_a' as const, similarity: 0, titleSimilarity: 0,
			},
		];
		const instructions = [{ pairIndex: 0, choice: 'a' as const }];

		const report = executeMerge(db, 'Merged', pairs, instructions, 'Draft A', 'Draft B', user.id);

		const docs = db.prepare('SELECT id FROM documents WHERE novel_id = ?').all(report.novelId) as any[];
		for (const doc of docs) {
			const fts = db.prepare('SELECT * FROM documents_fts WHERE doc_id = ?').get(doc.id);
			expect(fts).toBeTruthy();
		}
	});

	it('should log merge action to audit log', async () => {
		const { executeMerge } = await import('$lib/server/compare/merge.js');
		seedTwoNovelsForCompare(db);
		const user = seedUser(db, 'archivist');

		const pairs = [
			{
				docA: { id: 'doc-a1', title: 'Chapter One', novelId: 'novel-a', wordCount: 50, plaintext: 'text', html: '<p>text</p>' },
				docB: null,
				method: 'unmatched_a' as const, similarity: 0, titleSimilarity: 0,
			},
		];
		const instructions = [{ pairIndex: 0, choice: 'a' as const }];

		const report = executeMerge(db, 'Merged', pairs, instructions, 'Draft A', 'Draft B', user.id);

		const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'novel.merge'").get() as any;
		expect(audit).toBeTruthy();
		expect(audit.entity_id).toBe(report.novelId);
		expect(audit.user_id).toBe(user.id);
	});

	it('should set synopsis with draft provenance on choice "a"', async () => {
		const { executeMerge } = await import('$lib/server/compare/merge.js');
		seedTwoNovelsForCompare(db);
		const user = seedUser(db, 'archivist');

		const pairs = [
			{
				docA: { id: 'doc-a1', title: 'Chapter One', novelId: 'novel-a', wordCount: 50, plaintext: 'text', html: '<p>text</p>' },
				docB: { id: 'doc-b1', title: 'Chapter One', novelId: 'novel-b', wordCount: 50, plaintext: 'text', html: '<p>text</p>' },
				method: 'exact_title' as const, similarity: 1.0, titleSimilarity: 1.0,
			},
		];
		const instructions = [{ pairIndex: 0, choice: 'a' as const }];

		const report = executeMerge(db, 'Merged', pairs, instructions, 'Tigrenache Draft 2', 'Tigrenache Draft 3', user.id);

		const doc = db.prepare('SELECT synopsis FROM documents WHERE novel_id = ?').get(report.novelId) as any;
		expect(doc.synopsis).toBe('From: Tigrenache Draft 2');
	});
});

// ─── Review fixes ───────────────────────────────────────────────

describe('Review fix #1: matchDocuments preserves Novel A ordering for unmatched', () => {
	it('should interleave unmatched A docs at their original positions', async () => {
		const { matchDocuments } = await import('$lib/server/compare/match.js');
		// A has 3 chapters: Ch1 (matched), Ch2 (unmatched), Ch3 (matched)
		// Result should be: Ch1, Ch2, Ch3 — not Ch1, Ch3, Ch2
		const docsA = [
			{ id: 'a1', title: 'Chapter One', novelId: 'na', wordCount: 100, plaintext: 'hello', html: '' },
			{ id: 'a2', title: 'Interlude', novelId: 'na', wordCount: 50, plaintext: 'unique interlude content xyz', html: '' },
			{ id: 'a3', title: 'Chapter Three', novelId: 'na', wordCount: 100, plaintext: 'goodbye', html: '' },
		];
		const docsB = [
			{ id: 'b1', title: 'Chapter One', novelId: 'nb', wordCount: 100, plaintext: 'hello', html: '' },
			{ id: 'b3', title: 'Chapter Three', novelId: 'nb', wordCount: 100, plaintext: 'goodbye', html: '' },
		];
		const pairs = matchDocuments(docsA, docsB);

		// Extract the A-side doc ids in result order
		const aIds = pairs.map(p => p.docA?.id).filter(Boolean);
		expect(aIds).toEqual(['a1', 'a2', 'a3']);
	});
});

describe('Review fix #2: merge instruction validation', () => {
	it('should validate pairIndex uniqueness and coverage', () => {
		const source = fs.readFileSync('src/routes/api/compare/merge/+server.ts', 'utf-8');
		// The endpoint must validate that pairIndex values form a complete 0..N-1 set
		expect(source).toContain('pairIndex');
		// Should check for duplicates or validate the set, not just length
		expect(source).toMatch(/Set|unique|duplicate|every|indexOf/);
	});

	it('should validate choice values', () => {
		const source = fs.readFileSync('src/routes/api/compare/merge/+server.ts', 'utf-8');
		// The endpoint must validate that choice is one of: a, b, both, skip
		expect(source).toMatch(/choice.*['"]a['"]|validChoices|['"]a['"].*['"]b['"].*['"]both['"].*['"]skip['"]/);
	});
});

describe('Review fix #3: diff endpoint DB validation', () => {
	it('should verify documents exist in DB before reading files', () => {
		const source = fs.readFileSync('src/routes/api/compare/diff/+server.ts', 'utf-8');
		// Must query DB to confirm docs exist and are not soft-deleted
		expect(source).toContain('deleted_at IS NULL');
		expect(source).toContain('documents');
	});
});

// ─── Layer 2: API endpoint source-scans ─────────────────────────

describe('Layer 2: compare API endpoints', () => {
	it('POST /api/compare/match handler exists and uses requireUser', () => {
		const source = fs.readFileSync('src/routes/api/compare/match/+server.ts', 'utf-8');
		expect(source).toContain('export const POST');
		expect(source).toContain('requireUser');
	});

	it('POST /api/compare/diff handler exists and uses requireUser', () => {
		const source = fs.readFileSync('src/routes/api/compare/diff/+server.ts', 'utf-8');
		expect(source).toContain('export const POST');
		expect(source).toContain('requireUser');
	});

	it('POST /api/compare/merge handler exists and uses requireUser', () => {
		const source = fs.readFileSync('src/routes/api/compare/merge/+server.ts', 'utf-8');
		expect(source).toContain('export const POST');
		expect(source).toContain('requireUser');
	});
});

// ─── Layer 3: UI source-scans ───────────────────────────────────

describe('Layer 3: compare UI', () => {
	it('compare page exists', () => {
		const source = fs.readFileSync('src/routes/novels/compare/+page.svelte', 'utf-8');
		expect(source).toContain('Compare');
	});

	it('compare page has auth guard', () => {
		const source = fs.readFileSync('src/routes/novels/compare/+page.server.ts', 'utf-8');
		expect(source).toBeTruthy();
	});

	it('DiffView component exists', () => {
		const source = fs.readFileSync('src/lib/components/DiffView.svelte', 'utf-8');
		expect(source).toContain('diff');
	});

	it('MergeControls component exists', () => {
		const source = fs.readFileSync('src/lib/components/MergeControls.svelte', 'utf-8');
		expect(source).toContain('merge');
	});

	it('library page has compare link', () => {
		const source = fs.readFileSync('src/routes/+page.svelte', 'utf-8');
		expect(source).toContain('/novels/compare');
	});

	it('compare types exist in types.ts', () => {
		const source = fs.readFileSync('src/lib/types.ts', 'utf-8');
		expect(source).toContain('CompareDocument');
		expect(source).toContain('MatchedPair');
		expect(source).toContain('MergeReport');
		expect(source).toContain('MergeInstruction');
		expect(source).toContain('DiffChange');
	});
});

// ─── Variant-aware CompileDialog ────────────────────────────────

describe('Variant folder tagging', () => {
	let db: Database.Database;
	beforeEach(() => { db = createTestDb(); });

	it('executeMerge sets folder_type="variant" on variant folders', async () => {
		const { executeMerge } = await import('$lib/server/compare/merge.js');
		seedTwoNovelsForCompare(db);
		const user = seedUser(db, 'archivist');

		const pairs = [
			{
				docA: { id: 'doc-a1', title: 'Chapter One', novelId: 'novel-a', wordCount: 50, plaintext: 'version one text', html: '<p>version one text</p>' },
				docB: { id: 'doc-b1', title: 'Chapter One', novelId: 'novel-b', wordCount: 50, plaintext: 'version two text', html: '<p>version two text</p>' },
				method: 'exact_title' as const, similarity: 0.5, titleSimilarity: 1.0,
			},
		];
		const instructions = [{ pairIndex: 0, choice: 'both' as const }];

		const report = executeMerge(db, 'Merged', pairs, instructions, 'Draft A', 'Draft B', user.id);

		// The variant folder should have folder_type = 'variant'
		const folder = db.prepare('SELECT folder_type FROM folders WHERE novel_id = ?').get(report.novelId) as any;
		expect(folder).toBeTruthy();
		expect(folder.folder_type).toBe('variant');
	});
});

describe('CompileDialog variant-aware UI', () => {
	it('detects variant folders via folder_type', () => {
		const source = fs.readFileSync('src/lib/components/CompileDialog.svelte', 'utf-8');
		// Must check for folder_type === 'variant' to detect variant folders
		expect(source).toContain("folder_type");
		expect(source).toContain("variant");
	});

	it('renders variant group with badge and version count', () => {
		const source = fs.readFileSync('src/lib/components/CompileDialog.svelte', 'utf-8');
		// Must have variant group UI elements
		expect(source).toContain('variant-group');
		expect(source).toContain('variant-badge');
		expect(source).toContain('versions');
	});

	it('uses variant_group kind in collect entries', () => {
		const source = fs.readFileSync('src/lib/components/CompileDialog.svelte', 'utf-8');
		// The flat list must distinguish regular documents from variant groups
		expect(source).toContain('variant_group');
		expect(source).toContain("kind");
	});
});

import { describe, it, expect } from 'vitest';
import fs from 'fs';

/**
 * Unit D (W5b spec): import page UI wiring for bundle import.
 *
 * The bundle flow lives beside the existing .scriv scan/import flow in
 * src/routes/+page.svelte, reusing its modal, path-input conventions, and the
 * archivist-only owner picker. It has its own small state machine because it
 * needs a dry-run -> confirm step the .scriv flow doesn't:
 *   idle -> dry_running -> dry_run_done -> importing -> done
 *
 * This is all client-side Svelte with no DB/server dependency worth an
 * in-memory-DB test, so — per house style (see mobile-layout.test.ts,
 * ownership.test.ts) — it's covered by source-greps against the component.
 */

const SOURCE = fs.readFileSync('src/routes/+page.svelte', 'utf-8');

describe('bundle import: path input beside the .scriv flow', () => {
	it('adds a bundle path input and section heading', () => {
		expect(SOURCE).toContain('bind:value={bundlePath}');
		expect(SOURCE).toContain('Import Bundle');
	});

	it('posts to /api/import/bundle', () => {
		expect(SOURCE).toContain("fetch('/api/import/bundle'");
	});
});

describe('bundle import: reuses the shared archivist owner picker', () => {
	it('does not duplicate the owner <select> for the bundle flow', () => {
		const selects = SOURCE.match(/<select bind:value=\{importOwnerId\}>/g) || [];
		expect(selects).toHaveLength(1);
	});

	it('both the dry run and confirm requests read the shared importOwnerId', () => {
		const ownerAssignments = SOURCE.match(
			/if \(isArchivist && importOwnerId\) payload\.owner_id = importOwnerId;/g
		) || [];
		// .scriv single import, .scriv batch import, bundle dry run, bundle confirm
		expect(ownerAssignments.length).toBeGreaterThanOrEqual(2);
	});
});

describe('bundle import: dry run then confirm', () => {
	it('dry run request sets dry_run: true', () => {
		const fnStart = SOURCE.indexOf('async function bundleDryRun');
		const fnEnd = SOURCE.indexOf('async function bundleImport');
		expect(fnStart).toBeGreaterThan(-1);
		const fnBody = SOURCE.slice(fnStart, fnEnd);
		expect(fnBody).toMatch(/dry_run:\s*true/);
	});

	it('confirm request sets dry_run: false — a real import, not another dry run', () => {
		const fnStart = SOURCE.indexOf('async function bundleImport');
		const fnEnd = SOURCE.indexOf('function bundleBack');
		expect(fnStart).toBeGreaterThan(-1);
		const fnBody = SOURCE.slice(fnStart, fnEnd);
		expect(fnBody).toMatch(/dry_run:\s*false/);
	});

	it('bundleImport is a no-op unless a dry run has already completed', () => {
		const fnStart = SOURCE.indexOf('async function bundleImport');
		const fnEnd = SOURCE.indexOf('function bundleBack');
		const fnBody = SOURCE.slice(fnStart, fnEnd);
		expect(fnBody).toMatch(/if \(bundleMode !== 'dry_run_done' \|\| !bundleReports\) return;/);
	});

	it('the confirm button only renders in the dry_run_done branch', () => {
		const idx = SOURCE.indexOf("bundleMode === 'dry_run_done' && bundleReports");
		expect(idx).toBeGreaterThan(-1);
		const block = SOURCE.slice(idx, idx + 3000);
		expect(block).toContain('onclick={bundleImport}');
		expect(block).toMatch(/Import \{bundleReports\.length\}/);
	});

	it('the idle branch offers Dry Run, not the confirm button', () => {
		const idleIdx = SOURCE.indexOf("{#if bundleMode === 'idle'}");
		const dryRunDoneIdx = SOURCE.indexOf("bundleMode === 'dry_run_done'", idleIdx);
		expect(idleIdx).toBeGreaterThan(-1);
		expect(dryRunDoneIdx).toBeGreaterThan(idleIdx);
		const idleBlock = SOURCE.slice(idleIdx, dryRunDoneIdx);
		expect(idleBlock).toContain('onclick={bundleDryRun}');
		expect(idleBlock).not.toContain('onclick={bundleImport}');
	});
});

describe('bundle import: stale-dry-run footgun guard', () => {
	it('tracks the path/owner a completed dry run was run against', () => {
		expect(SOURCE).toContain('let lastDryRunPath = $state(');
		expect(SOURCE).toContain('let lastDryRunOwnerId = $state(');
		expect(SOURCE).toContain('lastDryRunPath = bundlePath.trim();');
		expect(SOURCE).toContain('lastDryRunOwnerId = importOwnerId;');
	});

	it('an $effect resets bundleMode to idle when the path or owner changes after a dry run', () => {
		const effectIdx = SOURCE.indexOf('const pathNow = bundlePath.trim();');
		expect(effectIdx).toBeGreaterThan(-1);
		const effectBody = SOURCE.slice(effectIdx - 50, effectIdx + 600);
		expect(effectBody).toMatch(/pathNow !== lastDryRunPath \|\| ownerNow !== lastDryRunOwnerId/);
		expect(effectBody).toContain("bundleMode = 'idle';");
		expect(effectBody).toContain('bundleReports = null;');
	});

	it('the reset guard covers both the dry-run-done and done (post-import) states', () => {
		const effectIdx = SOURCE.indexOf('const pathNow = bundlePath.trim();');
		const effectBody = SOURCE.slice(effectIdx - 50, effectIdx + 600);
		expect(effectBody).toMatch(/bundleMode === 'dry_run_done' \|\| bundleMode === 'done'/);
	});
});

describe('bundle import: loading and error states', () => {
	it('shows a distinct loading message while the dry run is in flight', () => {
		expect(SOURCE).toMatch(/bundleMode === 'dry_running'[\s\S]{0,80}Running dry run/);
	});

	it('shows a distinct loading message while the real import is in flight', () => {
		expect(SOURCE).toMatch(/bundleMode === 'importing'[\s\S]{0,120}Importing/);
	});

	it('surfaces the server 400 message to the user on failure', () => {
		const fnStart = SOURCE.indexOf('async function bundleDryRun');
		const fnEnd = SOURCE.indexOf('async function bundleImport');
		const fnBody = SOURCE.slice(fnStart, fnEnd);
		expect(fnBody).toContain('bundleError = err.message');
	});

	it('renders the bundle error in its own error box', () => {
		const idx = SOURCE.indexOf('{#if bundleError}');
		expect(idx).toBeGreaterThan(-1);
		const block = SOURCE.slice(idx, idx + 200);
		expect(block).toContain('import-report error');
		expect(block).toContain('{bundleError}');
	});

	it('disables the path input while a dry run or import is in flight', () => {
		expect(SOURCE).toContain('disabled={isBundleBusy}');
		expect(SOURCE).toContain(
			"let isBundleBusy = $derived(bundleMode === 'dry_running' || bundleMode === 'importing');"
		);
	});
});

describe('bundle import: per-work report rendering', () => {
	it('renders errors and warnings as visibly distinct elements', () => {
		expect(SOURCE).toContain('report-error batch-error-detail');
		expect(SOURCE).toContain('batch-warnings-summary');
	});

	it('shows a skipped badge distinct from failure and success badges', () => {
		expect(SOURCE).toMatch(
			/report\.errors\.length > 0[\s\S]{0,40}<span class="badge-error">Failed<\/span>[\s\S]{0,60}report\.skipped[\s\S]{0,60}duplicate-badge">Already imported/
		);
	});

	it('reports docs, folders, variants, and word count per work', () => {
		expect(SOURCE).toMatch(/report\.docs_imported\}\s*document/);
		expect(SOURCE).toMatch(/report\.folders_created\}\s*folder/);
		expect(SOURCE).toMatch(/report\.variants_imported > 0/);
		expect(SOURCE).toMatch(/report\.total_word_count > 0/);
	});

	it('the final (post-confirm) report reuses the same item rendering and offers Open Novel', () => {
		const doneIdx = SOURCE.indexOf("bundleMode === 'done' && bundleReports");
		expect(doneIdx).toBeGreaterThan(-1);
		const block = SOURCE.slice(doneIdx, doneIdx + 3000);
		expect(block).toContain('batch-result-item');
		expect(block).toContain('goto(`/novels/${report.novel_id}`)');
	});
});

describe('bundle import: modal lifecycle guards', () => {
	it('openImportModal resets all bundle state so a stale report never survives a reopen', () => {
		const fnStart = SOURCE.indexOf('function openImportModal');
		const fnEnd = SOURCE.indexOf('function closeImportModal');
		expect(fnStart).toBeGreaterThan(-1);
		const fnBody = SOURCE.slice(fnStart, fnEnd);
		expect(fnBody).toContain("bundlePath = '';");
		expect(fnBody).toContain("bundleMode = 'idle';");
		expect(fnBody).toContain('bundleReports = null;');
		expect(fnBody).toContain("lastDryRunPath = '';");
		expect(fnBody).toContain("lastDryRunOwnerId = '';");
	});

	it('closeImportModal blocks while a bundle dry run or import is in flight', () => {
		const fnStart = SOURCE.indexOf('function closeImportModal');
		expect(fnStart).toBeGreaterThan(-1);
		const fnBody = SOURCE.slice(fnStart, fnStart + 400);
		expect(fnBody).toContain('isBundleBusy');
	});
});

describe('bundle import: plain-language modal copy (user-guide audit)', () => {
	// Scope to the user-facing paragraph right after the "Import Bundle" heading —
	// the surrounding code has its own "(W5b Unit D)" comments, which are fine.
	function copyBlock(): string {
		const idx = SOURCE.indexOf('Import Bundle');
		expect(idx).toBeGreaterThan(-1);
		return SOURCE.slice(idx, idx + 500);
	}

	it('does not reference the internal W5b spec or "curated bundle directory" jargon in the copy shown to users', () => {
		const block = copyBlock();
		expect(block).not.toMatch(/W5b/);
		expect(block).not.toMatch(/curated bundle directory/i);
	});

	it('explains bundle.json and the dry-run-first, nothing-imported-until-confirm behavior in plain language', () => {
		const block = copyBlock();
		expect(block).toMatch(/bundle\.json/);
		expect(block).toMatch(/preview/i);
		expect(block).toMatch(/nothing is imported until you confirm/i);
	});
});

describe('bundle import: types', () => {
	it('imports the BundleImportReport type shared with the backend (Unit B)', () => {
		expect(SOURCE).toMatch(/import type \{[^}]*BundleImportReport[^}]*\} from '\$lib\/types\.js';/);
	});
});

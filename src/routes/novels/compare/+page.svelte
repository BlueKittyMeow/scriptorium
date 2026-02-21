<script lang="ts">
	import DiffView from '$lib/components/DiffView.svelte';
	import MergeControls from '$lib/components/MergeControls.svelte';
	import type { MatchedPair, DiffChange, MergeInstruction, MergeReport } from '$lib/types.js';

	let { data } = $props();

	// Step 1: Selection
	let novelIdA = $state('');
	let novelIdB = $state('');

	// Step 2: Comparison results
	type Step = 'select' | 'compare' | 'merged';
	let step: Step = $state('select');
	let pairs: MatchedPair[] = $state([]);
	let novelATitle = $state('');
	let novelBTitle = $state('');
	let loading = $state(false);
	let error: string | null = $state(null);

	// Diff expansion
	let expandedPair: number | null = $state(null);
	let diffCache = $state<Record<number, { changes: DiffChange[]; wordCountA: number; wordCountB: number }>>({});
	let diffLoading = $state(false);

	// Step 3: Merge
	let instructions: MergeInstruction[] = $state([]);
	let mergedTitle = $state('');
	let mergeReport: MergeReport | null = $state(null);
	let merging = $state(false);

	async function compare() {
		if (!novelIdA || !novelIdB) return;
		if (novelIdA === novelIdB) { error = 'Please select two different novels'; return; }

		loading = true;
		error = null;
		try {
			const res = await fetch('/api/compare/match', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ novelIdA, novelIdB })
			});
			if (!res.ok) {
				const err = await res.json();
				error = err.message || 'Comparison failed';
				return;
			}
			const result = await res.json();
			pairs = result.pairs;
			novelATitle = result.novelA.title;
			novelBTitle = result.novelB.title;
			mergedTitle = `Merged: ${novelATitle.replace(/\s+Draft\s+\d+/i, '')}`;
			diffCache = {};
			expandedPair = null;

			// Initialize merge instructions with smart defaults
			instructions = pairs.map((p, i) => {
				if (p.method === 'unmatched_a') return { pairIndex: i, choice: 'a' as const };
				if (p.method === 'unmatched_b') return { pairIndex: i, choice: 'b' as const };
				if (p.similarity >= 0.95) return { pairIndex: i, choice: 'a' as const };
				return { pairIndex: i, choice: 'a' as const };
			});

			step = 'compare';
		} catch (err: any) {
			error = err.message;
		} finally {
			loading = false;
		}
	}

	async function loadDiff(pairIndex: number) {
		if (diffCache[pairIndex]) {
			expandedPair = expandedPair === pairIndex ? null : pairIndex;
			return;
		}

		const pair = pairs[pairIndex];
		if (!pair.docA || !pair.docB) return;

		diffLoading = true;
		try {
			const res = await fetch('/api/compare/diff', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					novelIdA: pair.docA.novelId,
					docIdA: pair.docA.id,
					novelIdB: pair.docB.novelId,
					docIdB: pair.docB.id
				})
			});
			if (res.ok) {
				diffCache[pairIndex] = await res.json();
				expandedPair = pairIndex;
			}
		} finally {
			diffLoading = false;
		}
	}

	async function executeMerge() {
		merging = true;
		error = null;
		try {
			const res = await fetch('/api/compare/merge', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					novelIdA,
					novelIdB,
					mergedTitle,
					instructions
				})
			});
			if (!res.ok) {
				const err = await res.json();
				error = err.message || 'Merge failed';
				return;
			}
			mergeReport = await res.json();
			step = 'merged';
		} catch (err: any) {
			error = err.message;
		} finally {
			merging = false;
		}
	}

	function similarityColor(sim: number): string {
		if (sim >= 0.9) return 'var(--success-text)';
		if (sim >= 0.5) return 'var(--warning-text)';
		return 'var(--error-text)';
	}

	function similarityBg(sim: number): string {
		if (sim >= 0.9) return 'var(--success-bg)';
		if (sim >= 0.5) return 'var(--warning-bg)';
		return 'var(--error-bg)';
	}
</script>

<div class="compare-page">
	<header class="compare-header">
		<a href="/" class="back-link">&larr; Library</a>
		<h1>Compare Drafts</h1>
		<p class="subtitle">Match chapters across drafts, view differences, and merge into a single novel</p>
	</header>

	{#if error}
		<div class="error-banner">{error}</div>
	{/if}

	<!-- Step 1: Select novels -->
	{#if step === 'select'}
		<div class="select-step">
			<div class="novel-selectors">
				<div class="selector">
					<label for="novel-a">Novel A (base)</label>
					<select id="novel-a" bind:value={novelIdA}>
						<option value="">Select a novel...</option>
						{#each data.novels as novel}
							<option value={novel.id}>{novel.title}</option>
						{/each}
					</select>
				</div>
				<div class="selector">
					<label for="novel-b">Novel B (comparison)</label>
					<select id="novel-b" bind:value={novelIdB}>
						<option value="">Select a novel...</option>
						{#each data.novels as novel}
							<option value={novel.id}>{novel.title}</option>
						{/each}
					</select>
				</div>
			</div>
			<button class="btn btn-primary" onclick={compare} disabled={!novelIdA || !novelIdB || loading}>
				{loading ? 'Comparing...' : 'Compare'}
			</button>
		</div>

	<!-- Step 2: Comparison results + merge controls -->
	{:else if step === 'compare'}
		<div class="compare-step">
			<div class="compare-summary">
				<h2>{novelATitle} vs {novelBTitle}</h2>
				<p>{pairs.length} chapter{pairs.length !== 1 ? 's' : ''} matched</p>
				<button class="btn btn-secondary btn-sm" onclick={() => { step = 'select'; }}>Change Selection</button>
			</div>

			<div class="pairs-table">
				{#each pairs as pair, i}
					<div class="pair-row" class:expanded={expandedPair === i}>
						<button class="pair-summary" onclick={() => pair.docA && pair.docB && loadDiff(i)}>
							<span class="doc-title doc-a">
								{pair.docA?.title || '—'}
							</span>

							{#if pair.method === 'unmatched_a'}
								<span class="match-badge unmatched">only in A</span>
							{:else if pair.method === 'unmatched_b'}
								<span class="match-badge unmatched">only in B</span>
							{:else}
								<span class="match-badge" style="color: {similarityColor(pair.similarity)}; background: {similarityBg(pair.similarity)};">
									{Math.round(pair.similarity * 100)}%
								</span>
							{/if}

							<span class="doc-title doc-b">
								{pair.docB?.title || '—'}
							</span>
						</button>

						{#if expandedPair === i && diffCache[i]}
							<div class="diff-panel">
								<DiffView
									changes={diffCache[i].changes}
									wordCountA={diffCache[i].wordCountA}
									wordCountB={diffCache[i].wordCountB}
								/>
							</div>
						{/if}

						<MergeControls
							{pair}
							bind:choice={instructions[i].choice}
							{novelATitle}
							{novelBTitle}
						/>
					</div>
				{/each}
			</div>

			<div class="merge-section">
				<h3>Create Merged Novel</h3>
				<div class="merge-title-row">
					<label for="merged-title">Title:</label>
					<input id="merged-title" type="text" bind:value={mergedTitle} placeholder="Merged novel title" />
				</div>
				<button class="btn btn-primary" onclick={executeMerge} disabled={!mergedTitle.trim() || merging}>
					{merging ? 'Merging...' : 'Create Merged Novel'}
				</button>
			</div>
		</div>

	<!-- Step 3: Merge complete -->
	{:else if step === 'merged' && mergeReport}
		<div class="merged-step">
			<h2>Merge Complete</h2>
			<div class="merge-report">
				<p><strong>{mergeReport.novelTitle}</strong> created successfully!</p>
				<ul>
					<li>{mergeReport.documentsCreated} documents created</li>
					{#if mergeReport.foldersCreated > 0}
						<li>{mergeReport.foldersCreated} folders created ({mergeReport.variantFolders} variant folder{mergeReport.variantFolders !== 1 ? 's' : ''})</li>
					{/if}
					<li>{mergeReport.totalWordCount.toLocaleString()} words total</li>
				</ul>
			</div>
			<div class="merge-actions">
				<a class="btn btn-primary" href="/novels/{mergeReport.novelId}">Open Novel</a>
				<button class="btn btn-secondary" onclick={() => { step = 'select'; mergeReport = null; }}>Compare More</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.compare-page {
		max-width: 960px;
		margin: 0 auto;
		padding: 2rem 1.5rem;
	}

	.compare-header {
		margin-bottom: 2rem;
	}

	.back-link {
		color: var(--accent);
		text-decoration: none;
		font-size: 0.85rem;
	}

	.back-link:hover {
		text-decoration: underline;
	}

	.compare-header h1 {
		font-size: 1.75rem;
		color: var(--text-heading);
		margin-top: 0.5rem;
	}

	.subtitle {
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.error-banner {
		background: var(--error-bg);
		color: var(--error-text);
		padding: 0.75rem 1rem;
		border-radius: 6px;
		margin-bottom: 1rem;
	}

	/* Step 1: Selection */
	.select-step {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.novel-selectors {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.5rem;
	}

	.selector label {
		display: block;
		font-weight: 500;
		margin-bottom: 0.5rem;
		color: var(--text-heading);
	}

	.selector select {
		width: 100%;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--border-input);
		border-radius: 6px;
		font-size: 0.9rem;
		background: var(--bg-surface);
		color: var(--text);
	}

	.selector select:focus {
		outline: none;
		border-color: var(--accent);
	}

	/* Step 2: Comparison */
	.compare-summary {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-bottom: 1.5rem;
		flex-wrap: wrap;
	}

	.compare-summary h2 {
		font-size: 1.2rem;
		color: var(--text-heading);
	}

	.compare-summary p {
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.pairs-table {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 2rem;
	}

	.pair-row {
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
	}

	.pair-row.expanded {
		border-color: var(--border-active);
	}

	.pair-summary {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		gap: 0.75rem;
		align-items: center;
		padding: 0.75rem 1rem;
		width: 100%;
		background: var(--bg-surface);
		border: none;
		cursor: pointer;
		text-align: left;
		color: var(--text);
	}

	.pair-summary:hover {
		background: var(--bg-elevated);
	}

	.doc-title {
		font-size: 0.9rem;
	}

	.doc-b {
		text-align: right;
	}

	.match-badge {
		font-size: 0.75rem;
		padding: 0.15rem 0.5rem;
		border-radius: 10px;
		text-align: center;
		white-space: nowrap;
	}

	.match-badge.unmatched {
		color: var(--text-muted);
		background: var(--bg-elevated);
	}

	.diff-panel {
		padding: 1rem;
		border-top: 1px solid var(--border);
		background: var(--bg-elevated);
		max-height: 400px;
		overflow-y: auto;
	}

	/* Step 3: Merge */
	.merge-section {
		border-top: 2px solid var(--border);
		padding-top: 1.5rem;
	}

	.merge-section h3 {
		color: var(--text-heading);
		margin-bottom: 1rem;
	}

	.merge-title-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.merge-title-row label {
		font-weight: 500;
		white-space: nowrap;
	}

	.merge-title-row input {
		flex: 1;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border-input);
		border-radius: 6px;
		font-size: 0.9rem;
		background: var(--bg-surface);
		color: var(--text);
	}

	.merge-title-row input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.merged-step {
		text-align: center;
	}

	.merged-step h2 {
		color: var(--text-heading);
		margin-bottom: 1rem;
	}

	.merge-report {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 1.5rem;
		display: inline-block;
		text-align: left;
		margin-bottom: 1.5rem;
	}

	.merge-report ul {
		margin: 0.5rem 0 0 1.25rem;
		color: var(--text-secondary);
	}

	.merge-actions {
		display: flex;
		gap: 0.75rem;
		justify-content: center;
	}

	/* Shared button styles */
	.btn {
		padding: 0.5rem 1.25rem;
		border-radius: 6px;
		border: 1px solid transparent;
		font-size: 0.9rem;
		cursor: pointer;
		transition: all 0.15s;
		text-decoration: none;
		display: inline-block;
	}

	.btn-primary {
		background: var(--accent);
		color: var(--text-on-accent);
		border-color: var(--accent);
	}

	.btn-primary:hover { background: var(--accent-hover); }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

	.btn-secondary {
		background: var(--bg-surface);
		color: var(--accent);
		border-color: var(--border-input);
	}

	.btn-secondary:hover { background: var(--bg-elevated); }

	.btn-sm {
		padding: 0.25rem 0.75rem;
		font-size: 0.8rem;
	}

	@media (max-width: 600px) {
		.novel-selectors {
			grid-template-columns: 1fr;
		}

		.pair-summary {
			grid-template-columns: 1fr;
			gap: 0.25rem;
		}

		.doc-b {
			text-align: left;
		}
	}
</style>

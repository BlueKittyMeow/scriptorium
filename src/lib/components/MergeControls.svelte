<script lang="ts">
	import type { MatchedPair, MergeChoice } from '$lib/types.js';

	let { pair, choice = $bindable(), novelATitle, novelBTitle }: {
		pair: MatchedPair;
		choice: MergeChoice;
		novelATitle: string;
		novelBTitle: string;
	} = $props();

	let isUnmatched = $derived(pair.method === 'unmatched_a' || pair.method === 'unmatched_b');
	let hasBoth = $derived(pair.docA !== null && pair.docB !== null);
</script>

<div class="merge-controls">
	{#if isUnmatched}
		<span class="merge-auto">
			Auto-included from {pair.method === 'unmatched_a' ? novelATitle : novelBTitle}
		</span>
	{:else}
		<div class="merge-options">
			<label class="merge-option">
				<input type="radio" bind:group={choice} value="a" disabled={!pair.docA} />
				<span>Use A</span>
			</label>
			<label class="merge-option">
				<input type="radio" bind:group={choice} value="b" disabled={!pair.docB} />
				<span>Use B</span>
			</label>
			{#if hasBoth}
				<label class="merge-option">
					<input type="radio" bind:group={choice} value="both" />
					<span>Keep Both</span>
				</label>
			{/if}
			<label class="merge-option">
				<input type="radio" bind:group={choice} value="skip" />
				<span>Skip</span>
			</label>
		</div>
	{/if}
</div>

<style>
	.merge-controls {
		padding: 0.5rem 1rem;
		border-top: 1px solid var(--border);
		background: var(--bg-surface);
	}

	.merge-auto {
		font-size: 0.8rem;
		color: var(--text-muted);
		font-style: italic;
	}

	.merge-options {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.merge-option {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.8rem;
		cursor: pointer;
		color: var(--text);
	}

	.merge-option input[type="radio"] {
		cursor: pointer;
	}

	.merge-option input[type="radio"]:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}
</style>

<script lang="ts">
	import type { DiffChange } from '$lib/types.js';

	let { changes, wordCountA, wordCountB }: {
		changes: DiffChange[];
		wordCountA: number;
		wordCountB: number;
	} = $props();

	let hasChanges = $derived(changes.some(c => c.added || c.removed));
</script>

<div class="diff-view">
	<div class="diff-stats">
		<span>A: {wordCountA} words</span>
		<span>B: {wordCountB} words</span>
		{#if !hasChanges}
			<span class="identical-badge">Identical</span>
		{/if}
	</div>

	<div class="diff-content">
		{#each changes as change}
			{#if change.added}
				<span class="diff-added">{change.value}</span>
			{:else if change.removed}
				<span class="diff-removed">{change.value}</span>
			{:else}
				<span>{change.value}</span>
			{/if}
		{/each}
	</div>
</div>

<style>
	.diff-view {
		font-family: var(--font-body, Georgia, serif);
		line-height: 1.6;
	}

	.diff-stats {
		display: flex;
		gap: 1rem;
		font-size: 0.8rem;
		color: var(--text-muted);
		margin-bottom: 0.75rem;
	}

	.identical-badge {
		color: var(--success-text);
		background: var(--success-bg);
		padding: 0.1rem 0.4rem;
		border-radius: 3px;
	}

	.diff-content {
		font-size: 0.9rem;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.diff-added {
		background: var(--success-bg);
		color: var(--success-text);
	}

	.diff-removed {
		background: var(--error-bg);
		color: var(--error-text);
		text-decoration: line-through;
	}
</style>

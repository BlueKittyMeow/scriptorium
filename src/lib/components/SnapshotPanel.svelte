<script lang="ts">
	import type { SnapshotSummary } from '$lib/types.js';

	let {
		snapshots = [],
		activeSnapshotId = null,
		onPreview,
		onCompare,
		onClose,
		onLoadMore
	}: {
		snapshots: SnapshotSummary[];
		activeSnapshotId?: string | null;
		onPreview: (snapId: string) => void;
		onCompare: (snapId: string) => void;
		onClose: () => void;
		onLoadMore?: () => void;
	} = $props();

	const grouped = $derived(groupByDay(snapshots));
	const indexMap = $derived(new Map(snapshots.map((s, i) => [s.id, i])));

	function groupByDay(items: SnapshotSummary[]): Map<string, SnapshotSummary[]> {
		const groups = new Map<string, SnapshotSummary[]>();
		for (const snap of items) {
			const date = new Date(snap.created_at);
			const key = isToday(date) ? 'Today'
				: isYesterday(date) ? 'Yesterday'
				: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(snap);
		}
		return groups;
	}

	function isToday(date: Date): boolean {
		const now = new Date();
		return date.getFullYear() === now.getFullYear() &&
			date.getMonth() === now.getMonth() &&
			date.getDate() === now.getDate();
	}

	function isYesterday(date: Date): boolean {
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		return date.getFullYear() === yesterday.getFullYear() &&
			date.getMonth() === yesterday.getMonth() &&
			date.getDate() === yesterday.getDate();
	}

	function formatTime(dateStr: string): string {
		const date = new Date(dateStr);
		return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
	}

	function formatDelta(index: number): string | null {
		if (index >= snapshots.length - 1) return null;
		const current = snapshots[index].word_count ?? 0;
		const older = snapshots[index + 1].word_count ?? 0;
		const diff = current - older;
		if (diff === 0) return null;
		return diff > 0 ? `+${diff}` : `${diff}`;
	}

	const IMPORTED_PREFIX = 'imported-variant: ';

	function isImported(reason: string): boolean {
		return reason.startsWith(IMPORTED_PREFIX);
	}

	function reasonLabel(reason: string): string {
		if (reason === 'autosave') return 'auto';
		if (reason === 'pre-restore') return 'pre-restore';
		// Imported variants are labelled with just the source filename
		if (isImported(reason)) return reason.slice(IMPORTED_PREFIX.length);
		return reason;
	}
</script>

<div class="snapshot-panel">
	<div class="panel-header">
		<button class="panel-close" onclick={onClose} title="Close" aria-label="Close snapshots">×</button>
		<h3>Snapshots</h3>
	</div>

	<div class="panel-content">
		{#if snapshots.length === 0}
			<p class="no-snapshots">No snapshots yet</p>
		{:else}
			{#each [...grouped] as [dayLabel, daySnapshots]}
				<div class="day-group">
					<div class="day-header">{dayLabel}</div>
					{#each daySnapshots as snap, i}
						{@const globalIndex = indexMap.get(snap.id) ?? 0}
						{@const delta = formatDelta(globalIndex)}
						<div
							class="snapshot-entry"
							class:active={activeSnapshotId === snap.id}
						>
							<button class="snap-main" onclick={() => onPreview(snap.id)} title="Preview snapshot">
								<span class="snap-time">{formatTime(snap.created_at)}</span>
								<span class="snap-words">{(snap.word_count ?? 0).toLocaleString()} words</span>
								{#if delta}
									<span class="snap-delta" class:positive={delta.startsWith('+')} class:negative={delta.startsWith('-')}>{delta}</span>
								{/if}
								{#if isImported(snap.reason)}
									<span class="snap-reason reason-imported">imported</span>
									<span class="snap-filename" title={reasonLabel(snap.reason)}>{reasonLabel(snap.reason)}</span>
								{:else}
									<span class="snap-reason reason-{snap.reason}">{reasonLabel(snap.reason)}</span>
								{/if}
							</button>
							<button class="snap-compare" onclick={() => onCompare(snap.id)} title="Compare with current" aria-label="Compare with current">⇄</button>
						</div>
					{/each}
				</div>
			{/each}

			{#if onLoadMore}
				<button class="load-more" onclick={onLoadMore}>Load older snapshots</button>
			{/if}
		{/if}
	</div>
</div>

<style>
	.snapshot-panel {
		width: 280px;
		min-width: 280px;
		background: var(--bg-sidebar);
		border-left: 1px solid var(--border-strong);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.panel-header {
		padding: 0.75rem 1rem;
		padding-right: 2.5rem; /* clear the fixed theme toggle */
		border-bottom: 1px solid var(--border-strong);
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.panel-header h3 {
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--text-heading);
		margin: 0;
	}

	.panel-content {
		flex: 1;
		overflow-y: auto;
		padding: 0.25rem 0;
	}

	.no-snapshots {
		font-size: 0.8rem;
		color: var(--text-muted);
		padding: 1rem;
		text-align: center;
	}

	.day-group {
		margin-bottom: 0.25rem;
	}

	.day-header {
		font-size: 0.7rem;
		color: var(--text-muted);
		padding: 0.5rem 0.75rem 0.15rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-weight: 600;
	}

	.snapshot-entry {
		display: flex;
		align-items: center;
		width: 100%;
	}

	.snapshot-entry:hover {
		background: var(--tree-hover);
	}

	.snapshot-entry.active {
		background: var(--accent-bg);
	}

	.snap-main {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4rem;
		flex: 1;
		min-width: 0;
		padding: 0.35rem 0 0.35rem 0.75rem;
		background: none;
		border: none;
		cursor: pointer;
		font-size: 0.8rem;
		color: var(--text);
		text-align: left;
	}

	.snap-compare {
		flex-shrink: 0;
		padding: 0.2rem 0.4rem;
		margin: 0 0.5rem 0 0.25rem;
		background: none;
		border: 1px solid transparent;
		border-radius: 4px;
		font-size: 0.85rem;
		color: var(--text-muted);
		cursor: pointer;
	}

	.snap-compare:hover {
		color: var(--accent);
		border-color: var(--border-input);
		background: var(--bg-elevated);
	}

	.snap-time {
		font-weight: 500;
		flex-shrink: 0;
		min-width: 4.5rem;
	}

	.snap-words {
		color: var(--text-faint);
		font-size: 0.75rem;
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.snap-delta {
		font-size: 0.7rem;
		font-weight: 600;
		flex-shrink: 0;
	}

	.snap-delta.positive {
		color: var(--saved);
	}

	.snap-delta.negative {
		color: var(--unsaved);
	}

	.snap-reason {
		font-size: 0.6rem;
		padding: 0.1rem 0.3rem;
		border-radius: 3px;
		flex-shrink: 0;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.reason-autosave {
		color: var(--text-muted);
		background: var(--bg-elevated);
	}

	.reason-manual {
		color: var(--accent);
		background: var(--accent-bg);
	}

	.reason-pre-restore {
		color: var(--saving);
		background: var(--bg-elevated);
	}

	.reason-imported {
		color: var(--warning-text);
		background: var(--warning-bg);
	}

	/* Imported-variant source filename — wraps to its own line under the entry */
	.snap-filename {
		flex-basis: 100%;
		font-size: 0.7rem;
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.load-more {
		display: block;
		width: 100%;
		padding: 0.5rem;
		background: none;
		border: none;
		border-top: 1px solid var(--border);
		color: var(--accent);
		font-size: 0.75rem;
		cursor: pointer;
	}

	.load-more:hover {
		background: var(--bg-elevated);
	}

	.panel-close {
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		cursor: pointer;
		font-size: 1.1rem;
		line-height: 1;
		color: var(--text);
		padding: 0.15rem 0.45rem;
		border-radius: 4px;
	}

	.panel-close:hover {
		color: var(--accent);
		border-color: var(--accent);
	}

	@media (max-width: 768px) {
		.snapshot-panel {
			position: fixed;
			bottom: 0;
			left: 0;
			right: 0;
			width: 100%;
			min-width: 0;
			height: 60vh;
			border-left: none;
			border-top: 1px solid var(--border-strong);
			z-index: 60;
		}
	}
</style>

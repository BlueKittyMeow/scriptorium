<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	let novels: any[] = $state([]);
	let showImportModal = $state(false);
	let showNewNovelModal = $state(false);
	let importPath = $state('');
	let newNovelTitle = $state('');
	let importing = $state(false);
	let importReport: any = $state(null);
	let loading = $state(true);

	onMount(async () => {
		await loadNovels();
	});

	async function loadNovels() {
		loading = true;
		const res = await fetch('/api/novels');
		novels = await res.json();
		loading = false;
	}

	async function createNovel() {
		if (!newNovelTitle.trim()) return;
		const res = await fetch('/api/novels', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: newNovelTitle.trim() })
		});
		const novel = await res.json();
		showNewNovelModal = false;
		newNovelTitle = '';
		goto(`/novels/${novel.id}`);
	}

	async function importScriv() {
		if (!importPath.trim()) return;
		importing = true;
		importReport = null;
		try {
			const res = await fetch('/api/admin/import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: importPath.trim() })
			});
			if (!res.ok) {
				const err = await res.json();
				importReport = { error: err.message || 'Import failed' };
				return;
			}
			importReport = await res.json();
			await loadNovels();
		} catch (err: any) {
			importReport = { error: err.message };
		} finally {
			importing = false;
		}
	}

	let renamingNovelId: string | null = $state(null);
	let renamingNovelTitle = $state('');

	async function renameNovel(novelId: string) {
		const trimmed = renamingNovelTitle.trim();
		if (!trimmed) { renamingNovelId = null; return; }
		await fetch(`/api/novels/${novelId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: trimmed })
		});
		renamingNovelId = null;
		await loadNovels();
	}

	function formatWordCount(count: number): string {
		if (count >= 1000) return `${(count / 1000).toFixed(1)}k words`;
		return `${count} words`;
	}
</script>

<div class="library">
	<header class="library-header">
		<h1>Scriptorium</h1>
		<p class="subtitle">A preservation-first writing application</p>
	</header>

	<div class="actions">
		<button class="btn btn-primary" onclick={() => showNewNovelModal = true}>New Novel</button>
		<button class="btn btn-secondary" onclick={() => showImportModal = true}>Import .scriv</button>
	</div>

	{#if loading}
		<div class="empty-state">Loading...</div>
	{:else if novels.length === 0}
		<div class="empty-state">
			<p>No novels yet.</p>
			<p class="hint">Create a new novel or import a .scriv project to get started.</p>
		</div>
	{:else}
		<div class="novel-grid">
			{#each novels as novel}
				<a class="novel-card" href="/novels/{novel.id}">
					<div class="novel-card-header">
						{#if renamingNovelId === novel.id}
							<!-- svelte-ignore a11y_autofocus -->
							<input
								class="novel-rename-input"
								bind:value={renamingNovelTitle}
								onclick={(e) => e.preventDefault()}
								onblur={() => renameNovel(novel.id)}
								onkeydown={(e) => { if (e.key === 'Enter') renameNovel(novel.id); if (e.key === 'Escape') renamingNovelId = null; }}
								autofocus
							/>
						{:else}
							<h2>{novel.title}</h2>
							<button class="rename-btn" onclick={(e) => { e.preventDefault(); renamingNovelId = novel.id; renamingNovelTitle = novel.title; }} title="Rename novel">✎</button>
						{/if}
					</div>
					{#if novel.subtitle}
						<p class="novel-subtitle">{novel.subtitle}</p>
					{/if}
					<div class="novel-meta">
						<span class="status">{novel.status}</span>
						<span class="word-count">{formatWordCount(novel.total_word_count || 0)}</span>
					</div>
				</a>
			{/each}
		</div>
	{/if}
</div>

<!-- Import Modal -->
{#if showImportModal}
	<div class="modal-backdrop" onclick={() => { if (!importing) showImportModal = false; }} role="presentation">
		<div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !importing && (showImportModal = false)} role="dialog" tabindex="-1">
			<h2>Import Scrivener Project</h2>
			<p>Enter the full path to your .scriv directory:</p>
			<input
				type="text"
				bind:value={importPath}
				placeholder="/path/to/MyNovel.scriv"
				disabled={importing}
			/>
			<div class="modal-actions">
				<button class="btn btn-secondary" onclick={() => showImportModal = false} disabled={importing}>Cancel</button>
				<button class="btn btn-primary" onclick={importScriv} disabled={importing || !importPath.trim()}>
					{importing ? 'Importing...' : 'Import'}
				</button>
			</div>

			{#if importReport}
				<div class="import-report" class:error={importReport.error}>
					{#if importReport.error}
						<p class="report-error">{importReport.error}</p>
					{:else}
						<p><strong>{importReport.novel_title}</strong> imported successfully!</p>
						<ul>
							<li>{importReport.docs_imported} documents imported</li>
							<li>{importReport.folders_created} folders created</li>
							{#if importReport.files_skipped > 0}
								<li>{importReport.files_skipped} files skipped</li>
							{/if}
							{#if importReport.errors.length > 0}
								<li class="report-error">{importReport.errors.length} errors</li>
							{/if}
						</ul>
						{#if importReport.warnings.length > 0}
							<details>
								<summary>{importReport.warnings.length} warnings</summary>
								<ul>
									{#each importReport.warnings as warning}
										<li>{warning}</li>
									{/each}
								</ul>
							</details>
						{/if}
						<button class="btn btn-primary" onclick={() => goto(`/novels/${importReport.novel_id}`)}>
							Open Novel
						</button>
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}

<!-- New Novel Modal -->
{#if showNewNovelModal}
	<div class="modal-backdrop" onclick={() => showNewNovelModal = false} role="presentation">
		<div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && (showNewNovelModal = false)} role="dialog" tabindex="-1">
			<h2>New Novel</h2>
			<input
				type="text"
				bind:value={newNovelTitle}
				placeholder="Novel title"
				onkeydown={(e) => e.key === 'Enter' && createNovel()}
			/>
			<div class="modal-actions">
				<button class="btn btn-secondary" onclick={() => showNewNovelModal = false}>Cancel</button>
				<button class="btn btn-primary" onclick={createNovel} disabled={!newNovelTitle.trim()}>Create</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.library {
		max-width: 900px;
		margin: 0 auto;
		padding: 2rem 1.5rem;
	}

	.library-header {
		margin-bottom: 2rem;
	}

	.library-header h1 {
		font-size: 2rem;
		font-weight: 600;
		color: #3a2e26;
	}

	.subtitle {
		color: #8a7a6a;
		font-style: italic;
		margin-top: 0.25rem;
	}

	.actions {
		display: flex;
		gap: 0.75rem;
		margin-bottom: 2rem;
	}

	.btn {
		padding: 0.5rem 1.25rem;
		border-radius: 6px;
		border: 1px solid transparent;
		font-size: 0.9rem;
		cursor: pointer;
		transition: all 0.15s;
	}

	.btn-primary {
		background: #5c4a3a;
		color: white;
		border-color: #5c4a3a;
	}

	.btn-primary:hover {
		background: #4a3a2c;
	}

	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-secondary {
		background: white;
		color: #5c4a3a;
		border-color: #d4c8bc;
	}

	.btn-secondary:hover {
		background: #f5f0eb;
	}

	.empty-state {
		text-align: center;
		padding: 4rem 2rem;
		color: #8a7a6a;
	}

	.hint {
		margin-top: 0.5rem;
		font-size: 0.9rem;
	}

	.novel-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 1rem;
	}

	.novel-card {
		background: white;
		border: 1px solid #e8e0d8;
		border-radius: 8px;
		padding: 1.25rem;
		text-decoration: none;
		color: inherit;
		transition: all 0.15s;
	}

	.novel-card:hover {
		border-color: #c8b8a8;
		box-shadow: 0 2px 8px rgba(0,0,0,0.06);
	}

	.novel-card-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.novel-card h2 {
		font-size: 1.1rem;
		font-weight: 600;
		margin-bottom: 0.25rem;
		flex: 1;
	}

	.rename-btn {
		background: none;
		border: none;
		cursor: pointer;
		font-size: 0.85rem;
		color: #a89a8a;
		padding: 0.1rem 0.25rem;
		opacity: 0;
		transition: opacity 0.15s;
	}

	.novel-card:hover .rename-btn {
		opacity: 1;
	}

	.rename-btn:hover {
		color: #5c4a3a;
	}

	.novel-rename-input {
		font-size: 1.1rem;
		font-weight: 600;
		border: 1px solid #5c4a3a;
		border-radius: 4px;
		padding: 0.15rem 0.4rem;
		width: 100%;
	}

	.novel-rename-input:focus {
		outline: none;
	}

	.novel-subtitle {
		font-size: 0.85rem;
		color: #8a7a6a;
		margin-bottom: 0.5rem;
	}

	.novel-meta {
		display: flex;
		gap: 0.75rem;
		margin-top: 0.75rem;
		font-size: 0.8rem;
		color: #a89a8a;
	}

	.status {
		text-transform: capitalize;
		padding: 0.1rem 0.5rem;
		background: #f5f0eb;
		border-radius: 3px;
	}

	/* Modals */
	.modal-backdrop {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0,0,0,0.4);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}

	.modal {
		background: white;
		border-radius: 12px;
		padding: 2rem;
		max-width: 500px;
		width: 90%;
		box-shadow: 0 8px 32px rgba(0,0,0,0.15);
	}

	.modal h2 {
		margin-bottom: 0.75rem;
	}

	.modal p {
		margin-bottom: 0.75rem;
		color: #666;
		font-size: 0.9rem;
	}

	.modal input {
		width: 100%;
		padding: 0.6rem 0.75rem;
		border: 1px solid #d4c8bc;
		border-radius: 6px;
		font-size: 0.9rem;
		margin-bottom: 1rem;
	}

	.modal input:focus {
		outline: none;
		border-color: #5c4a3a;
	}

	.modal-actions {
		display: flex;
		gap: 0.5rem;
		justify-content: flex-end;
	}

	.import-report {
		margin-top: 1rem;
		padding: 1rem;
		background: #f5f0eb;
		border-radius: 6px;
		font-size: 0.85rem;
	}

	.import-report.error {
		background: #fef2f2;
	}

	.import-report ul {
		margin: 0.5rem 0 0 1.25rem;
	}

	.report-error {
		color: #c44;
	}

	.import-report details {
		margin-top: 0.5rem;
	}

	.import-report .btn {
		margin-top: 0.75rem;
	}

	@media (max-width: 600px) {
		.library {
			padding: 1rem;
		}

		.novel-grid {
			grid-template-columns: 1fr;
		}
	}
</style>

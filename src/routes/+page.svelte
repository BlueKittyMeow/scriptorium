<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { ScrivProject } from '$lib/types.js';

	let novels: any[] = $state([]);
	let showNewNovelModal = $state(false);
	let newNovelTitle = $state('');
	let loading = $state(true);

	// Import modal state machine
	type ImportMode = 'idle' | 'scanning' | 'project_list' | 'importing_single' | 'importing_batch' | 'report_single' | 'report_batch';
	let showImportModal = $state(false);
	let importMode: ImportMode = $state('idle');
	let importPath = $state('');
	let importError: string | null = $state(null);

	// Single import
	let singleReport: any = $state(null);

	// Batch scan/import
	let scannedProjects: ScrivProject[] = $state([]);
	let selectedPaths: Set<string> = $state(new Set());
	let batchResults: any = $state(null);
	let batchProgress = $state({ current: 0, total: 0, currentName: '' });
	let scanAbort: AbortController | null = $state(null);

	let isSingleScrivPath = $derived(importPath.trim().endsWith('.scriv'));
	let selectedCount = $derived(selectedPaths.size);
	let isBusy = $derived(
		importMode === 'scanning' || importMode === 'importing_single' || importMode === 'importing_batch'
	);

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

	function openImportModal() {
		// Reset all state on open (review fix #7)
		importMode = 'idle';
		importPath = '';
		importError = null;
		singleReport = null;
		scannedProjects = [];
		selectedPaths = new Set();
		batchResults = null;
		batchProgress = { current: 0, total: 0, currentName: '' };
		if (scanAbort) { scanAbort.abort(); scanAbort = null; }
		showImportModal = true;
	}

	function closeImportModal() {
		if (isBusy) return;
		if (scanAbort) { scanAbort.abort(); scanAbort = null; }
		showImportModal = false;
	}

	async function importSingle() {
		if (!importPath.trim()) return;
		importMode = 'importing_single';
		importError = null;
		singleReport = null;
		try {
			const res = await fetch('/api/admin/import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: importPath.trim() })
			});
			if (!res.ok) {
				const err = await res.json();
				importError = err.message || 'Import failed';
				importMode = 'idle';
				return;
			}
			singleReport = await res.json();
			importMode = 'report_single';
			await loadNovels();
		} catch (err: any) {
			importError = err.message;
			importMode = 'idle';
		}
	}

	async function scanDirectory() {
		if (!importPath.trim()) return;
		importMode = 'scanning';
		importError = null;

		const abort = new AbortController();
		scanAbort = abort;

		try {
			const res = await fetch('/api/admin/import/scan', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: importPath.trim() }),
				signal: abort.signal
			});

			// Guard against stale response if modal was closed
			if (abort.signal.aborted) return;

			if (!res.ok) {
				const err = await res.json();
				importError = err.message || 'Scan failed';
				importMode = 'idle';
				return;
			}

			const data = await res.json();
			scannedProjects = data.projects;
			selectedPaths = new Set(data.projects.map((p: ScrivProject) => p.path));
			importMode = 'project_list';
		} catch (err: any) {
			if (err.name === 'AbortError') return;
			importError = err.message;
			importMode = 'idle';
		} finally {
			scanAbort = null;
		}
	}

	function toggleProject(projectPath: string) {
		const next = new Set(selectedPaths);
		if (next.has(projectPath)) {
			next.delete(projectPath);
		} else {
			next.add(projectPath);
		}
		selectedPaths = next;
	}

	function toggleAll() {
		if (selectedPaths.size === scannedProjects.length) {
			selectedPaths = new Set();
		} else {
			selectedPaths = new Set(scannedProjects.map(p => p.path));
		}
	}

	async function importBatch() {
		if (selectedPaths.size === 0) return;
		const paths = Array.from(selectedPaths);
		importMode = 'importing_batch';
		batchProgress = { current: 0, total: paths.length, currentName: '' };

		try {
			const res = await fetch('/api/admin/import/batch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ paths })
			});
			if (!res.ok) {
				const err = await res.json();
				importError = err.message || 'Batch import failed';
				importMode = 'project_list';
				return;
			}
			batchResults = await res.json();
			importMode = 'report_batch';
			await loadNovels();
		} catch (err: any) {
			importError = err.message;
			importMode = 'project_list';
		}
	}

	function handleImportAction() {
		if (isSingleScrivPath) {
			importSingle();
		} else if (importPath.trim()) {
			scanDirectory();
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
		<button class="btn btn-secondary" onclick={openImportModal}>Import .scriv</button>
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
				<a class="novel-card" href="/novels/{novel.id}" onclick={(e) => { if (renamingNovelId === novel.id) e.preventDefault(); }}>
					<div class="novel-card-header">
						{#if renamingNovelId === novel.id}
							<!-- svelte-ignore a11y_autofocus -->
							<input
								class="novel-rename-input"
								bind:value={renamingNovelTitle}
								onclick={(e) => e.preventDefault()}
								onblur={() => renameNovel(novel.id)}
								onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); renameNovel(novel.id); } if (e.key === 'Escape') renamingNovelId = null; }}
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
	<div class="modal-backdrop" onclick={closeImportModal} role="presentation">
		<div class="modal import-modal" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && closeImportModal()} role="dialog" aria-modal="true" tabindex="-1">
			<h2>Import Scrivener Project</h2>

			{#if importError}
				<div class="import-report error">
					<p class="report-error">{importError}</p>
				</div>
			{/if}

			<!-- IDLE: Path entry -->
			{#if importMode === 'idle'}
				<p>Enter a path to a .scriv file, or a directory to scan for projects:</p>
				<input
					type="text"
					bind:value={importPath}
					placeholder="/path/to/MyNovel.scriv or ~/Writing"
					onkeydown={(e) => e.key === 'Enter' && handleImportAction()}
				/>
				<div class="modal-actions">
					<button class="btn btn-secondary" onclick={closeImportModal}>Cancel</button>
					{#if isSingleScrivPath}
						<button class="btn btn-primary" onclick={importSingle} disabled={!importPath.trim()}>
							Import
						</button>
					{:else}
						<button class="btn btn-primary" onclick={scanDirectory} disabled={!importPath.trim()}>
							Scan for Projects
						</button>
					{/if}
				</div>

			<!-- SCANNING: Loading -->
			{:else if importMode === 'scanning'}
				<p>Scanning for .scriv projects...</p>
				<div class="modal-actions">
					<button class="btn btn-secondary" onclick={closeImportModal}>Cancel</button>
				</div>

			<!-- PROJECT_LIST: Selectable checklist -->
			{:else if importMode === 'project_list'}
				<div class="project-list-header">
					<p>Found {scannedProjects.length} project{scannedProjects.length !== 1 ? 's' : ''}:</p>
					<button class="btn-link" onclick={toggleAll}>
						{selectedPaths.size === scannedProjects.length ? 'Deselect All' : 'Select All'}
					</button>
				</div>
				<div class="project-list">
					{#each scannedProjects as project}
						<label class="project-item">
							<input
								type="checkbox"
								checked={selectedPaths.has(project.path)}
								onchange={() => toggleProject(project.path)}
							/>
							<div class="project-info">
								<span class="project-name">{project.name}</span>
								<span class="project-path">{project.path.replace(importPath.trim(), '.')}</span>
								{#if project.existingNovelTitle}
									<span class="duplicate-badge">Already imported?</span>
								{/if}
							</div>
						</label>
					{/each}
				</div>
				<div class="modal-actions">
					<button class="btn btn-secondary" onclick={() => { importMode = 'idle'; importError = null; }}>Back</button>
					<button class="btn btn-primary" onclick={importBatch} disabled={selectedCount === 0}>
						Import {selectedCount} project{selectedCount !== 1 ? 's' : ''}
					</button>
				</div>

			<!-- IMPORTING_SINGLE: Single import in progress -->
			{:else if importMode === 'importing_single'}
				<p>Importing...</p>

			<!-- IMPORTING_BATCH: Batch progress -->
			{:else if importMode === 'importing_batch'}
				<p>Importing {batchProgress.total} projects...</p>

			<!-- REPORT_SINGLE: Single import results -->
			{:else if importMode === 'report_single' && singleReport}
				<div class="import-report">
					<p><strong>{singleReport.novel_title}</strong> imported successfully!</p>
					<ul>
						<li>{singleReport.docs_imported} documents imported</li>
						<li>{singleReport.folders_created} folders created</li>
						{#if singleReport.total_word_count > 0}
							<li>{formatWordCount(singleReport.total_word_count)}</li>
						{/if}
						{#if singleReport.files_skipped > 0}
							<li>{singleReport.files_skipped} files skipped</li>
						{/if}
						{#if singleReport.errors?.length > 0}
							<li class="report-error">{singleReport.errors.length} errors</li>
						{/if}
					</ul>
					{#if singleReport.warnings?.length > 0}
						<details>
							<summary>{singleReport.warnings.length} warnings</summary>
							<ul>
								{#each singleReport.warnings as warning}
									<li>{warning}</li>
								{/each}
							</ul>
						</details>
					{/if}
					<button class="btn btn-primary" onclick={() => goto(`/novels/${singleReport.novel_id}`)}>
						Open Novel
					</button>
				</div>
				<div class="modal-actions">
					<button class="btn btn-secondary" onclick={closeImportModal}>Done</button>
				</div>

			<!-- REPORT_BATCH: Batch import results -->
			{:else if importMode === 'report_batch' && batchResults}
				<div class="import-report">
					<p>
						<strong>{batchResults.summary.succeeded}</strong> of {batchResults.summary.total} projects imported
						({batchResults.summary.total_docs} documents, {batchResults.summary.total_folders} folders{batchResults.summary.total_words > 0 ? `, ${formatWordCount(batchResults.summary.total_words)}` : ''})
					</p>
					{#if batchResults.summary.failed > 0}
						<p class="report-error">{batchResults.summary.failed} failed</p>
					{/if}
				</div>
				<div class="batch-results">
					{#each batchResults.results as result}
						<div class="batch-result-item" class:failed={result.errors.length > 0}>
							<div class="batch-result-header">
								<span class="project-name">{result.novel_title || result.path.split('/').pop()}</span>
								{#if result.errors.length > 0}
									<span class="badge-error">Failed</span>
								{:else}
									<span class="badge-success">{result.docs_imported} docs</span>
								{/if}
							</div>
							{#if result.errors.length > 0}
								<p class="report-error batch-error-detail">{result.errors.join(', ')}</p>
							{:else}
								<div class="batch-result-actions">
									<button class="btn btn-primary btn-sm" onclick={() => goto(`/novels/${result.novel_id}`)}>
										Open
									</button>
								</div>
							{/if}
							{#if result.warnings?.length > 0}
								<details>
									<summary class="batch-warnings-summary">{result.warnings.length} warnings</summary>
									<ul>
										{#each result.warnings as warning}
											<li>{warning}</li>
										{/each}
									</ul>
								</details>
							{/if}
						</div>
					{/each}
				</div>
				<div class="modal-actions">
					<button class="btn btn-secondary" onclick={closeImportModal}>Done</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<!-- New Novel Modal -->
{#if showNewNovelModal}
	<div class="modal-backdrop" onclick={() => showNewNovelModal = false} role="presentation">
		<div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && (showNewNovelModal = false)} role="dialog" aria-modal="true" tabindex="-1">
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
		color: var(--text-heading);
	}

	.subtitle {
		color: var(--text-secondary);
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
		background: var(--accent);
		color: var(--text-on-accent);
		border-color: var(--accent);
	}

	.btn-primary:hover {
		background: var(--accent-hover);
	}

	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-secondary {
		background: var(--bg-surface);
		color: var(--accent);
		border-color: var(--border-input);
	}

	.btn-secondary:hover {
		background: var(--bg-elevated);
	}

	.empty-state {
		text-align: center;
		padding: 4rem 2rem;
		color: var(--text-secondary);
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
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 1.25rem;
		text-decoration: none;
		color: inherit;
		transition: all 0.15s;
	}

	.novel-card:hover {
		border-color: var(--border-active);
		box-shadow: 0 2px 8px var(--shadow-sm);
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
		color: var(--text-muted);
		padding: 0.1rem 0.25rem;
		opacity: 0;
		transition: opacity 0.15s;
	}

	.novel-card:hover .rename-btn {
		opacity: 1;
	}

	.rename-btn:hover {
		color: var(--accent);
	}

	.novel-rename-input {
		font-size: 1.1rem;
		font-weight: 600;
		border: 1px solid var(--accent);
		border-radius: 4px;
		padding: 0.15rem 0.4rem;
		width: 100%;
		background: var(--bg-surface);
		color: var(--text);
	}

	.novel-rename-input:focus {
		outline: none;
	}

	.novel-subtitle {
		font-size: 0.85rem;
		color: var(--text-secondary);
		margin-bottom: 0.5rem;
	}

	.novel-meta {
		display: flex;
		gap: 0.75rem;
		margin-top: 0.75rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}

	.status {
		text-transform: capitalize;
		padding: 0.1rem 0.5rem;
		background: var(--bg-elevated);
		border-radius: 3px;
	}

	/* Modals */
	.modal-backdrop {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: var(--bg-overlay);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}

	.modal {
		background: var(--bg-surface);
		border-radius: 12px;
		padding: 2rem;
		max-width: 500px;
		width: 90%;
		box-shadow: 0 8px 32px var(--shadow-lg);
	}

	.import-modal {
		max-width: 600px;
	}

	.modal h2 {
		margin-bottom: 0.75rem;
		color: var(--text-heading);
	}

	.modal p {
		margin-bottom: 0.75rem;
		color: var(--text-faint);
		font-size: 0.9rem;
	}

	.modal input {
		width: 100%;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--border-input);
		border-radius: 6px;
		font-size: 0.9rem;
		margin-bottom: 1rem;
		background: var(--bg-surface);
		color: var(--text);
	}

	.modal input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.modal-actions {
		display: flex;
		gap: 0.5rem;
		justify-content: flex-end;
	}

	.import-report {
		margin-top: 1rem;
		padding: 1rem;
		background: var(--bg-elevated);
		border-radius: 6px;
		font-size: 0.85rem;
	}

	.import-report.error {
		background: var(--error-bg);
	}

	.import-report ul {
		margin: 0.5rem 0 0 1.25rem;
	}

	.report-error {
		color: var(--error-text);
	}

	.import-report details {
		margin-top: 0.5rem;
	}

	.import-report .btn {
		margin-top: 0.75rem;
	}

	/* Batch import styles */
	.project-list-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.5rem;
	}

	.project-list-header p {
		margin-bottom: 0;
	}

	.btn-link {
		background: none;
		border: none;
		color: var(--accent);
		cursor: pointer;
		font-size: 0.85rem;
		padding: 0;
	}

	.btn-link:hover {
		text-decoration: underline;
	}

	.project-list {
		max-height: 300px;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: 6px;
		margin-bottom: 1rem;
	}

	.project-item {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		cursor: pointer;
		border-bottom: 1px solid var(--border);
	}

	.project-item:last-child {
		border-bottom: none;
	}

	.project-item:hover {
		background: var(--bg-elevated);
	}

	.project-item input[type="checkbox"] {
		margin-top: 0.2rem;
		width: auto;
	}

	.project-info {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}

	.project-name {
		font-weight: 500;
		color: var(--text);
	}

	.project-path {
		font-size: 0.75rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.duplicate-badge {
		font-size: 0.7rem;
		color: var(--warning-text);
		background: var(--warning-bg);
		padding: 0.1rem 0.4rem;
		border-radius: 3px;
		width: fit-content;
	}

	.batch-results {
		max-height: 300px;
		overflow-y: auto;
		margin: 0.75rem 0;
	}

	.batch-result-item {
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--border);
	}

	.batch-result-item:last-child {
		border-bottom: none;
	}

	.batch-result-item.failed {
		background: var(--error-bg);
	}

	.batch-result-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.badge-success {
		font-size: 0.7rem;
		color: var(--success-text);
		background: var(--success-bg);
		padding: 0.1rem 0.4rem;
		border-radius: 3px;
	}

	.badge-error {
		font-size: 0.7rem;
		color: var(--error-text);
		background: var(--error-bg);
		padding: 0.1rem 0.4rem;
		border-radius: 3px;
	}

	.batch-error-detail {
		font-size: 0.8rem;
		margin-top: 0.25rem;
	}

	.batch-result-actions {
		margin-top: 0.25rem;
	}

	.btn-sm {
		padding: 0.2rem 0.6rem;
		font-size: 0.8rem;
	}

	.batch-warnings-summary {
		font-size: 0.75rem;
		color: var(--text-muted);
		cursor: pointer;
		margin-top: 0.25rem;
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

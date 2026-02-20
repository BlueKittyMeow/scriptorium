<script lang="ts">
	import type { TreeNode, CompileFormat } from '$lib/types.js';

	let {
		novelId,
		novelTitle,
		tree,
		open = $bindable(false),
		onClose
	}: {
		novelId: string;
		novelTitle: string;
		tree: TreeNode[];
		open: boolean;
		onClose: () => void;
	} = $props();

	let format: CompileFormat = $state('docx');
	let compiling = $state(false);
	let previewing = $state(false);
	let errorMsg: string | null = $state(null);
	let pendingToggles = $state(0);

	// Build a flat list of documents from the tree for the include checklist
	const flatDocs = $derived(collectDocs(tree));

	function collectDocs(nodes: TreeNode[]): { id: string; title: string; depth: number; compile_include: number }[] {
		const result: { id: string; title: string; depth: number; compile_include: number }[] = [];
		function walk(nodes: TreeNode[], depth: number) {
			for (const node of nodes) {
				if (node.deleted_at) continue;
				if (node.type === 'document') {
					result.push({
						id: node.id,
						title: node.title,
						depth,
						compile_include: node.compile_include ?? 1
					});
				}
				if (node.type === 'folder' && node.children) {
					walk(node.children, depth + 1);
				}
			}
		}
		walk(nodes, 0);
		return result;
	}

	async function toggleCompileInclude(docId: string, currentValue: number) {
		const newValue = currentValue ? 0 : 1;
		pendingToggles++;
		try {
			const res = await fetch(`/api/novels/${novelId}/tree/nodes/${docId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ compile_include: newValue })
			});
			if (!res.ok) {
				errorMsg = 'Failed to update document include setting';
				return;
			}
			// Update local tree state — find the node and toggle it
			updateTreeNode(tree, docId, newValue);
			tree = [...tree]; // trigger reactivity
		} finally {
			pendingToggles--;
		}
	}

	function updateTreeNode(nodes: TreeNode[], docId: string, value: number) {
		for (const node of nodes) {
			if (node.id === docId && node.type === 'document') {
				node.compile_include = value;
				return;
			}
			if (node.children) updateTreeNode(node.children, docId, value);
		}
	}

	async function handleCompile() {
		compiling = true;
		errorMsg = null;
		try {
			const res = await fetch(`/api/novels/${novelId}/compile`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ format })
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({ message: 'Compile failed' }));
				errorMsg = err.message || `Compile failed (${res.status})`;
				return;
			}

			// Download the file
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			const ext = format === 'markdown' ? 'md' : format;
			a.href = url;
			a.download = `${novelTitle}.${ext}`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Compile failed';
		} finally {
			compiling = false;
		}
	}

	async function handlePreview() {
		previewing = true;
		errorMsg = null;
		try {
			const url = `/api/novels/${novelId}/compile/preview`;
			window.open(url, '_blank');
		} finally {
			previewing = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}
</script>

{#if open}
	<div class="modal-backdrop" onclick={onClose} onkeydown={handleKeydown} role="presentation">
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div class="compile-modal" onclick={(e) => e.stopPropagation()} onkeydown={handleKeydown} role="dialog" aria-modal="true" aria-label="Compile novel" tabindex="-1">
			<h2>Compile &amp; Export</h2>

			<!-- Format selector -->
			<div class="form-group">
				<label for="compile-format">Output format</label>
				<select id="compile-format" bind:value={format}>
					<option value="docx">Word (.docx)</option>
					<option value="epub">EPUB (.epub)</option>
					<option value="pdf">PDF (.pdf)</option>
					<option value="markdown">Markdown (.md)</option>
				</select>
			</div>

			<!-- Document checklist -->
			<div class="form-group">
				<label>Include in compilation</label>
				<div class="doc-checklist">
					{#each flatDocs as doc}
						<label class="doc-check" style="padding-left: {doc.depth * 1.25}rem">
							<input
								type="checkbox"
								checked={doc.compile_include === 1}
								onchange={() => toggleCompileInclude(doc.id, doc.compile_include)}
							/>
							<span class="doc-check-title">{doc.title}</span>
						</label>
					{/each}
					{#if flatDocs.length === 0}
						<p class="empty-note">No documents in this novel yet.</p>
					{/if}
				</div>
			</div>

			{#if errorMsg}
				<div class="error-msg">{errorMsg}</div>
			{/if}

			<div class="modal-actions">
				<button class="btn btn-secondary" onclick={handlePreview} disabled={previewing || pendingToggles > 0 || flatDocs.length === 0}>
					{previewing ? 'Opening...' : 'Preview'}
				</button>
				<div class="actions-right">
					<button class="btn btn-secondary" onclick={onClose}>Cancel</button>
					<button class="btn btn-primary" onclick={handleCompile} disabled={compiling || pendingToggles > 0 || flatDocs.length === 0}>
						{compiling ? 'Compiling...' : pendingToggles > 0 ? 'Saving...' : 'Export'}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.modal-backdrop {
		position: fixed;
		top: 0; left: 0; right: 0; bottom: 0;
		background: var(--bg-overlay);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}

	.compile-modal {
		background: var(--bg-surface);
		border-radius: 12px;
		padding: 1.5rem;
		max-width: 500px;
		width: 90%;
		max-height: 80vh;
		overflow-y: auto;
		box-shadow: 0 8px 32px var(--shadow-lg);
	}

	.compile-modal h2 {
		margin-bottom: 1rem;
		font-size: 1.1rem;
		color: var(--text-heading);
	}

	.form-group {
		margin-bottom: 1rem;
	}

	.form-group > label {
		display: block;
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--text-secondary);
		margin-bottom: 0.35rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	select {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border-input);
		border-radius: 6px;
		font-size: 0.9rem;
		background: var(--bg-surface);
		color: var(--text);
		cursor: pointer;
	}

	select:focus {
		outline: none;
		border-color: var(--accent);
	}

	.doc-checklist {
		max-height: 300px;
		overflow-y: auto;
		border: 1px solid var(--border-input);
		border-radius: 6px;
		padding: 0.25rem 0;
	}

	.doc-check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.35rem 0.75rem;
		font-size: 0.85rem;
		color: var(--text);
		cursor: pointer;
	}

	.doc-check:hover {
		background: var(--bg-elevated);
	}

	.doc-check input[type="checkbox"] {
		accent-color: var(--accent);
		flex-shrink: 0;
	}

	.doc-check-title {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.empty-note {
		padding: 1rem;
		text-align: center;
		color: var(--text-muted);
		font-size: 0.85rem;
	}

	.error-msg {
		background: var(--error-bg, #fef2f2);
		color: var(--error, #b91c1c);
		padding: 0.5rem 0.75rem;
		border-radius: 6px;
		font-size: 0.85rem;
		margin-bottom: 1rem;
	}

	.modal-actions {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
	}

	.actions-right {
		display: flex;
		gap: 0.5rem;
	}

	.btn { padding: 0.5rem 1.25rem; border-radius: 6px; border: 1px solid transparent; font-size: 0.9rem; cursor: pointer; }
	.btn-primary { background: var(--accent); color: var(--text-on-accent); }
	.btn-primary:hover { background: var(--accent-hover); }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-secondary { background: var(--bg-surface); color: var(--accent); border-color: var(--border-input); }
	.btn-secondary:hover { background: var(--bg-elevated); }
	.btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
</style>

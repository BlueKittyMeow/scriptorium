<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import type { TreeNode } from '$lib/types.js';
	import Editor from '$lib/components/Editor.svelte';

	let { data } = $props();

	let tree: TreeNode[] = $state([]);
	let activeDocId: string | null = $state(null);
	let activeDoc: any = $state(null);
	let sidebarOpen = $state(true);
	let expandedFolders: Set<string> = $state(new Set());
	let showNewModal = $state(false);
	let newItemType: 'folder' | 'document' = $state('document');
	let newItemTitle = $state('');
	let newItemParent: string | null = $state(null);
	let searchQuery = $state('');
	let searchResults: any[] = $state([]);
	let showSearch = $state(false);
	let searchTimeout: any = $state(null);
	let searchInputEl: HTMLInputElement;
	let pendingSearchTerm: string | null = $state(null);

	// Drag and drop state
	let draggedNode: TreeNode | null = $state(null);
	let dropTarget: { nodeId: string; position: 'before' | 'after' | 'inside' } | null = $state(null);

	const novelId = $derived($page.params.id);
	const trashedItems = $derived(collectTrashed(tree));

	onMount(async () => {
		await loadTree();
	});

	async function loadTree() {
		const res = await fetch(`/api/novels/${novelId}/tree`);
		tree = await res.json();
		// Auto-expand all folders
		function collectFolderIds(nodes: TreeNode[]) {
			for (const n of nodes) {
				if (n.type === 'folder') {
					expandedFolders.add(n.id);
					collectFolderIds(n.children);
				}
			}
		}
		expandedFolderIds(tree);
	}

	function expandedFolderIds(nodes: TreeNode[]) {
		const newSet = new Set(expandedFolders);
		function collect(nodes: TreeNode[]) {
			for (const n of nodes) {
				if (n.type === 'folder') {
					newSet.add(n.id);
					collect(n.children);
				}
			}
		}
		collect(nodes);
		expandedFolders = newSet;
	}

	async function selectDocument(docId: string) {
		activeDocId = docId;
		const res = await fetch(`/api/documents/${docId}`);
		activeDoc = await res.json();
	}

	async function saveDocument(content: string) {
		if (!activeDocId) return;
		const res = await fetch(`/api/documents/${activeDocId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content })
		});
		const updated = await res.json();
		// Update word count in tree
		updateTreeNodeWordCount(tree, activeDocId, updated.word_count);
		tree = [...tree]; // trigger reactivity
	}

	function updateTreeNodeWordCount(nodes: TreeNode[], docId: string, wordCount: number) {
		for (const n of nodes) {
			if (n.id === docId) {
				n.word_count = wordCount;
				return;
			}
			if (n.children.length) updateTreeNodeWordCount(n.children, docId, wordCount);
		}
	}

	function toggleFolder(folderId: string) {
		const newSet = new Set(expandedFolders);
		if (newSet.has(folderId)) {
			newSet.delete(folderId);
		} else {
			newSet.add(folderId);
		}
		expandedFolders = newSet;
	}

	async function createItem() {
		if (!newItemTitle.trim()) return;
		await fetch(`/api/novels/${novelId}/tree/nodes`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: newItemType,
				parent_id: newItemParent,
				title: newItemTitle.trim(),
				sort_order: getNextSortOrder(newItemParent)
			})
		});
		showNewModal = false;
		newItemTitle = '';
		await loadTree();
	}

	function getNextSortOrder(parentId: string | null): number {
		function findChildren(nodes: TreeNode[], pid: string | null): TreeNode[] {
			if (pid === null) return nodes;
			for (const n of nodes) {
				if (n.id === pid) return n.children;
				const found = findChildren(n.children, pid);
				if (found.length || n.id === pid) return n.children;
			}
			return [];
		}
		const siblings = findChildren(tree, parentId);
		if (siblings.length === 0) return 1.0;
		return Math.max(...siblings.map(s => s.sort_order)) + 1.0;
	}

	async function trashItem(nodeId: string, nodeType: string) {
		await fetch(`/api/novels/${novelId}/tree/nodes/${nodeId}?type=${nodeType}`, {
			method: 'DELETE'
		});
		if (activeDocId === nodeId) {
			activeDocId = null;
			activeDoc = null;
		}
		await loadTree();
	}

	async function restoreItem(nodeId: string, nodeType: string) {
		const table = nodeType === 'folder' ? 'folders' : 'documents';
		// Use PATCH to restore (clear deleted_at)
		await fetch(`/api/novels/${novelId}/tree/nodes/${nodeId}?type=${nodeType}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: nodeType, restore: true })
		});
		await loadTree();
	}

	function openNewModal(type: 'folder' | 'document', parentId: string | null = null) {
		newItemType = type;
		newItemParent = parentId;
		newItemTitle = '';
		showNewModal = true;
	}

	async function handleSearch() {
		if (!searchQuery.trim()) {
			searchResults = [];
			return;
		}
		const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&novel=${novelId}`);
		searchResults = await res.json();
	}

	function onSearchInput() {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(handleSearch, 300);
	}

	function handleKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
			e.preventDefault();
			showSearch = !showSearch;
			if (!showSearch) {
				searchQuery = '';
				searchResults = [];
			}
		}
	}

	// Autofocus search input when panel opens
	$effect(() => {
		if (showSearch && searchInputEl) {
			// Tick delay so the DOM has rendered
			setTimeout(() => searchInputEl?.focus(), 0);
		}
	});

	// Drag and drop handlers
	function handleDragStart(e: DragEvent, node: TreeNode) {
		draggedNode = node;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', node.id);
		}
	}

	function handleDragOver(e: DragEvent, node: TreeNode) {
		if (!draggedNode || draggedNode.id === node.id) return;
		if (draggedNode.type === 'folder' && isDescendant(draggedNode, node.id)) return;

		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const y = e.clientY - rect.top;
		const height = rect.height;

		if (node.type === 'folder') {
			if (y < height * 0.25) {
				dropTarget = { nodeId: node.id, position: 'before' };
			} else if (y > height * 0.75) {
				dropTarget = { nodeId: node.id, position: 'after' };
			} else {
				dropTarget = { nodeId: node.id, position: 'inside' };
			}
		} else {
			dropTarget = y < height * 0.5
				? { nodeId: node.id, position: 'before' }
				: { nodeId: node.id, position: 'after' };
		}
	}

	function handleDragEnd() {
		draggedNode = null;
		dropTarget = null;
	}

	function isDescendant(parent: TreeNode, targetId: string): boolean {
		for (const child of parent.children) {
			if (child.id === targetId) return true;
			if (child.type === 'folder' && isDescendant(child, targetId)) return true;
		}
		return false;
	}

	function getSiblingsOf(targetId: string): { siblings: TreeNode[], parentId: string | null } {
		const rootVisible = tree.filter(n => !n.deleted_at);
		if (rootVisible.some(n => n.id === targetId)) {
			return { siblings: rootVisible, parentId: null };
		}
		function search(nodes: TreeNode[]): { siblings: TreeNode[], parentId: string } | null {
			for (const node of nodes) {
				const visible = node.children.filter(c => !c.deleted_at);
				if (visible.some(c => c.id === targetId)) {
					return { siblings: visible, parentId: node.id };
				}
				const found = search(node.children);
				if (found) return found;
			}
			return null;
		}
		return search(tree) || { siblings: [], parentId: null };
	}

	async function handleDrop(e: DragEvent, targetNode: TreeNode) {
		e.preventDefault();
		if (!draggedNode || !dropTarget || draggedNode.id === targetNode.id) {
			draggedNode = null;
			dropTarget = null;
			return;
		}

		let newParentId: string | null;
		let newSortOrder: number;

		if (dropTarget.position === 'inside') {
			newParentId = targetNode.id;
			const visible = targetNode.children.filter(c => !c.deleted_at && c.id !== draggedNode!.id);
			newSortOrder = visible.length === 0 ? 1 : Math.max(...visible.map(c => c.sort_order)) + 1;
		} else {
			const { siblings, parentId } = getSiblingsOf(targetNode.id);
			newParentId = parentId;
			const filtered = siblings.filter(s => s.id !== draggedNode!.id);
			const idx = filtered.findIndex(s => s.id === targetNode.id);

			if (dropTarget.position === 'before') {
				if (idx <= 0) {
					newSortOrder = (filtered[0]?.sort_order ?? 1) - 1;
				} else {
					newSortOrder = (filtered[idx - 1].sort_order + filtered[idx].sort_order) / 2;
				}
			} else {
				if (idx >= filtered.length - 1) {
					newSortOrder = (filtered[idx]?.sort_order ?? 0) + 1;
				} else {
					newSortOrder = (filtered[idx].sort_order + filtered[idx + 1].sort_order) / 2;
				}
			}
		}

		const nodeType = draggedNode.type;
		const nodeId = draggedNode.id;
		draggedNode = null;
		dropTarget = null;

		await fetch(`/api/novels/${novelId}/tree`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				node_id: nodeId,
				node_type: nodeType,
				new_parent_id: newParentId,
				new_sort_order: newSortOrder
			})
		});

		await loadTree();
	}

	function collectTrashed(nodes: TreeNode[]): TreeNode[] {
		const result: TreeNode[] = [];
		function walk(items: TreeNode[]) {
			for (const item of items) {
				if (item.deleted_at) {
					result.push(item);
				}
				walk(item.children);
			}
		}
		walk(nodes);
		return result;
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="workspace">
	<!-- Sidebar -->
	<aside class="sidebar" class:collapsed={!sidebarOpen}>
		<div class="sidebar-header">
			<a href="/" class="back-link">← Library</a>
			<h2>{data.novel.title}</h2>
			<button class="sidebar-toggle" onclick={() => sidebarOpen = !sidebarOpen}>
				{sidebarOpen ? '◀' : '▶'}
			</button>
		</div>

		{#if sidebarOpen}
			<div class="sidebar-content">
				<div class="sidebar-actions">
					<button class="btn-sm" onclick={() => openNewModal('document')}>+ Doc</button>
					<button class="btn-sm" onclick={() => openNewModal('folder')}>+ Folder</button>
					<button class="btn-sm" onclick={() => { showSearch = !showSearch; }}>Search</button>
				</div>

				<!-- Search panel -->
				{#if showSearch}
					<div class="search-panel">
						<input
							type="text"
							bind:this={searchInputEl}
							bind:value={searchQuery}
							oninput={onSearchInput}
							placeholder="Search documents... (Ctrl+K)"
						/>
						{#if searchResults.length > 0}
							<div class="search-results">
								{#each searchResults as result}
									<button class="search-result" onclick={() => { pendingSearchTerm = searchQuery; selectDocument(result.id); showSearch = false; searchQuery = ''; searchResults = []; }}>
										<span class="result-title">{result.title}</span>
										<span class="result-snippet">{@html result.snippet}</span>
									</button>
								{/each}
							</div>
						{:else if searchQuery.trim()}
							<p class="no-results">No results</p>
						{/if}
					</div>
				{/if}

				<!-- Binder tree -->
				<nav class="binder-tree" ondragleave={(e) => {
					if (!e.relatedTarget || !(e.currentTarget as HTMLElement).contains(e.relatedTarget as HTMLElement)) {
						dropTarget = null;
					}
				}}>
					{#each tree.filter(n => !n.deleted_at) as node}
						{@render treeNode(node, 0)}
					{/each}

					<!-- Trash section -->
					{#if trashedItems.length > 0}
						<div class="trash-section">
							<div class="trash-header">Trash ({trashedItems.length})</div>
							{#each trashedItems as item}
								<div class="tree-item trashed" style="padding-left: 1rem">
									<span class="node-icon">{item.type === 'folder' ? '📁' : '📄'}</span>
									<span class="node-title">{item.title}</span>
									<button class="btn-tiny" onclick={() => restoreItem(item.id, item.type)} title="Restore">↩</button>
								</div>
							{/each}
						</div>
					{/if}
				</nav>
			</div>
		{/if}
	</aside>

	<!-- Main content -->
	<main class="editor-area">
		{#if activeDoc}
			{#if browser}
				<Editor
					docId={activeDoc.id}
					initialContent={activeDoc.content || ''}
					title={activeDoc.title}
					onsave={saveDocument}
					searchTerm={pendingSearchTerm}
					onSearchHighlightDone={() => { pendingSearchTerm = null; }}
				/>
			{/if}
		{:else}
			<div class="no-doc">
				<p>Select a document from the binder to begin writing.</p>
			</div>
		{/if}
	</main>
</div>

<!-- New item modal -->
{#if showNewModal}
	<div class="modal-backdrop" onclick={() => showNewModal = false} role="presentation">
		<div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && (showNewModal = false)} role="dialog" tabindex="-1">
			<h2>New {newItemType === 'folder' ? 'Folder' : 'Document'}</h2>
			<input
				type="text"
				bind:value={newItemTitle}
				placeholder={newItemType === 'folder' ? 'Folder name' : 'Document title'}
				onkeydown={(e) => e.key === 'Enter' && createItem()}
			/>
			<div class="modal-actions">
				<button class="btn btn-secondary" onclick={() => showNewModal = false}>Cancel</button>
				<button class="btn btn-primary" onclick={createItem} disabled={!newItemTitle.trim()}>Create</button>
			</div>
		</div>
	</div>
{/if}

{#snippet treeNode(node: TreeNode, depth: number)}
	{#if !node.deleted_at}
		<div
			class="tree-item"
			class:active={node.id === activeDocId}
			class:dragging={draggedNode?.id === node.id}
			class:drag-before={dropTarget?.nodeId === node.id && dropTarget?.position === 'before'}
			class:drag-after={dropTarget?.nodeId === node.id && dropTarget?.position === 'after'}
			class:drag-inside={dropTarget?.nodeId === node.id && dropTarget?.position === 'inside'}
			style="padding-left: {depth * 1.25 + 0.5}rem"
			draggable="true"
			ondragstart={(e) => handleDragStart(e, node)}
			ondragover={(e) => handleDragOver(e, node)}
			ondrop={(e) => handleDrop(e, node)}
			ondragend={handleDragEnd}
			role="treeitem"
			tabindex="0"
			aria-selected={node.id === activeDocId}
		>
			{#if node.type === 'folder'}
				<button class="folder-toggle" onclick={() => toggleFolder(node.id)}>
					{expandedFolders.has(node.id) ? '▼' : '▶'}
				</button>
				<span class="node-icon">📁</span>
				<span class="node-title folder-title">{node.title}</span>
				<span class="node-actions">
					<button class="btn-tiny" onclick={() => openNewModal('document', node.id)} title="New document">+</button>
					<button class="btn-tiny" onclick={() => trashItem(node.id, 'folder')} title="Move to trash">×</button>
				</span>
			{:else}
				<span class="node-icon">📄</span>
				<button class="node-title doc-title" onclick={() => selectDocument(node.id)}>
					{node.title}
				</button>
				{#if node.word_count}
					<span class="word-badge">{node.word_count}</span>
				{/if}
				<span class="node-actions">
					<button class="btn-tiny" onclick={() => trashItem(node.id, 'document')} title="Move to trash">×</button>
				</span>
			{/if}
		</div>

		{#if node.type === 'folder' && expandedFolders.has(node.id)}
			{#each node.children.filter(c => !c.deleted_at) as child}
				{@render treeNode(child, depth + 1)}
			{/each}
		{/if}
	{/if}
{/snippet}

<style>
	.workspace {
		display: flex;
		height: 100vh;
	}

	/* Sidebar */
	.sidebar {
		width: 300px;
		min-width: 300px;
		background: #f0ebe5;
		border-right: 1px solid #d8d0c6;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		transition: min-width 0.2s, width 0.2s;
	}

	.sidebar.collapsed {
		width: 40px;
		min-width: 40px;
	}

	.sidebar-header {
		padding: 0.75rem 1rem;
		border-bottom: 1px solid #d8d0c6;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		position: relative;
	}

	.back-link {
		font-size: 0.8rem;
		text-decoration: none;
		color: #8a7a6a;
	}

	.back-link:hover {
		color: #5c4a3a;
	}

	.sidebar-header h2 {
		font-size: 1rem;
		font-weight: 600;
		color: #3a2e26;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sidebar-toggle {
		position: absolute;
		right: 0.5rem;
		top: 0.5rem;
		background: none;
		border: none;
		cursor: pointer;
		font-size: 0.8rem;
		color: #8a7a6a;
		padding: 0.25rem;
	}

	.sidebar-content {
		flex: 1;
		overflow-y: auto;
	}

	.sidebar-actions {
		display: flex;
		gap: 0.25rem;
		padding: 0.5rem;
		border-bottom: 1px solid #d8d0c6;
	}

	.btn-sm {
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
		background: white;
		border: 1px solid #d4c8bc;
		border-radius: 4px;
		cursor: pointer;
		color: #5c4a3a;
	}

	.btn-sm:hover {
		background: #f5f0eb;
	}

	/* Search */
	.search-panel {
		padding: 0.5rem;
		border-bottom: 1px solid #d8d0c6;
	}

	.search-panel input {
		width: 100%;
		padding: 0.4rem 0.5rem;
		border: 1px solid #d4c8bc;
		border-radius: 4px;
		font-size: 0.8rem;
	}

	.search-panel input:focus {
		outline: none;
		border-color: #5c4a3a;
	}

	.search-results {
		max-height: 300px;
		overflow-y: auto;
		margin-top: 0.25rem;
	}

	.search-result {
		display: block;
		width: 100%;
		text-align: left;
		padding: 0.5rem;
		background: white;
		border: 1px solid #e8e0d8;
		border-radius: 4px;
		margin-top: 0.25rem;
		cursor: pointer;
		font-size: 0.8rem;
	}

	.search-result:hover {
		background: #f5f0eb;
	}

	.result-title {
		display: block;
		font-weight: 600;
		font-size: 0.8rem;
	}

	.result-snippet {
		display: block;
		font-size: 0.75rem;
		color: #666;
		margin-top: 0.15rem;
	}

	:global(.result-snippet mark) {
		background: #ffe066;
		padding: 0 2px;
		border-radius: 2px;
	}

	.no-results {
		font-size: 0.8rem;
		color: #999;
		padding: 0.5rem;
		text-align: center;
	}

	/* Binder tree */
	.binder-tree {
		padding: 0.25rem 0;
	}

	.tree-item {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.3rem 0.5rem;
		font-size: 0.85rem;
		position: relative;
	}

	.tree-item:hover {
		background: rgba(0,0,0,0.04);
	}

	.tree-item.active {
		background: rgba(92, 74, 58, 0.12);
	}

	.tree-item.dragging {
		opacity: 0.4;
	}

	.tree-item.drag-before {
		box-shadow: 0 -2px 0 0 #5c4a3a;
	}

	.tree-item.drag-after {
		box-shadow: 0 2px 0 0 #5c4a3a;
	}

	.tree-item.drag-inside {
		background: rgba(92, 74, 58, 0.15);
		border-radius: 4px;
	}

	.tree-item.trashed {
		opacity: 0.5;
		text-decoration: line-through;
	}

	.folder-toggle {
		background: none;
		border: none;
		cursor: pointer;
		font-size: 0.65rem;
		color: #8a7a6a;
		padding: 0.1rem;
		width: 1rem;
		flex-shrink: 0;
	}

	.node-icon {
		font-size: 0.8rem;
		flex-shrink: 0;
	}

	.node-title {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.folder-title {
		font-weight: 500;
		color: #5c4a3a;
	}

	.doc-title {
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		font-size: 0.85rem;
		color: #2c2c2c;
		padding: 0;
	}

	.doc-title:hover {
		color: #5c4a3a;
	}

	.word-badge {
		font-size: 0.65rem;
		color: #a89a8a;
		flex-shrink: 0;
	}

	.node-actions {
		display: none;
		flex-shrink: 0;
		gap: 0.1rem;
	}

	.tree-item:hover .node-actions {
		display: flex;
	}

	.btn-tiny {
		background: none;
		border: none;
		cursor: pointer;
		font-size: 0.8rem;
		color: #a89a8a;
		padding: 0 0.2rem;
	}

	.btn-tiny:hover {
		color: #5c4a3a;
	}

	.trash-section {
		margin-top: 1rem;
		border-top: 1px solid #d8d0c6;
		padding-top: 0.25rem;
	}

	.trash-header {
		font-size: 0.75rem;
		color: #a89a8a;
		padding: 0.25rem 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	/* Editor area */
	.editor-area {
		flex: 1;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.no-doc {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #a89a8a;
	}

	/* Modals */
	.modal-backdrop {
		position: fixed;
		top: 0; left: 0; right: 0; bottom: 0;
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
		max-width: 400px;
		width: 90%;
		box-shadow: 0 8px 32px rgba(0,0,0,0.15);
	}

	.modal h2 { margin-bottom: 0.75rem; font-size: 1.1rem; }

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

	.btn { padding: 0.5rem 1.25rem; border-radius: 6px; border: 1px solid transparent; font-size: 0.9rem; cursor: pointer; }
	.btn-primary { background: #5c4a3a; color: white; }
	.btn-primary:hover { background: #4a3a2c; }
	.btn-primary:disabled { opacity: 0.5; }
	.btn-secondary { background: white; color: #5c4a3a; border-color: #d4c8bc; }
	.btn-secondary:hover { background: #f5f0eb; }

	/* Mobile responsive */
	@media (max-width: 768px) {
		.sidebar {
			position: fixed;
			z-index: 50;
			top: 0;
			left: 0;
			bottom: 0;
			width: 85%;
			min-width: 0;
			transform: translateX(0);
			transition: transform 0.2s;
		}

		.sidebar.collapsed {
			transform: translateX(-100%);
			width: 85%;
		}

		.editor-area {
			width: 100%;
		}
	}
</style>

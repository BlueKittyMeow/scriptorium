<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import type { TreeNode, SnapshotSummary, DiffChange } from '$lib/types.js';
	import Editor from '$lib/components/Editor.svelte';
	import SnapshotPanel from '$lib/components/SnapshotPanel.svelte';
	import SnapshotPreview from '$lib/components/SnapshotPreview.svelte';
	import DiffView from '$lib/components/DiffView.svelte';
	import CompileDialog from '$lib/components/CompileDialog.svelte';
	import {
		getDefaultDocumentParent,
		findNodeById,
		isDescendantOf,
		getVisibleSiblingsOf,
		computeSwapMove,
		getMoveTargets,
		computeAppendSortOrder
	} from '$lib/binder-tree.js';

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
	let newItemTitleEl = $state<HTMLInputElement | undefined>(undefined);
	let searchQuery = $state('');
	let searchResults: any[] = $state([]);
	let showSearch = $state(false);
	let searchTimeout: any = $state(null);
	let searchInputEl = $state<HTMLInputElement | undefined>(undefined);
	let pendingSearchTerm: string | null = $state(null);

	// Snapshot state
	let showSnapshots = $state(false);
	let snapshots: SnapshotSummary[] = $state([]);
	let snapshotOffset = $state(0);
	let hasMoreSnapshots = $state(false);
	let previewingSnapshot: { id: string; content: string } | null = $state(null);
	let snapshotDiff: { snapId: string; changes: DiffChange[]; wordCountA: number; wordCountB: number; reason: string; created_at: string } | null = $state(null);
	let diffLoading = $state(false);
	let diffError: string | null = $state(null);
	let showRestoreConfirm: string | null = $state(null);
	let editorFlush: (() => Promise<void>) | null = $state(null);
	let editorContentVersion = $state(0);

	// Compile dialog state
	let showCompileDialog = $state(false);

	// Novel rename state
	let editingNovelTitle = $state(false);
	let novelTitleDraft = $state('');

	// Tree node (folder/document) rename state
	let renamingNodeId: string | null = $state(null);
	let renameDraft = $state('');
	let renameInputEl = $state<HTMLInputElement | undefined>(undefined);

	// Drag and drop state
	let draggedNode: TreeNode | null = $state(null);
	let dropTarget: { nodeId: string; position: 'before' | 'after' | 'inside' } | null = $state(null);

	// Touch-friendly move state (coarse pointers only — see .node-menu-btn CSS)
	let openMenuNodeId: string | null = $state(null);
	let showMoveModal = $state(false);
	let moveModalNode: TreeNode | null = $state(null);

	const novelId = $derived($page.params.id!);
	const trashedItems = $derived(collectTrashed(tree));
	const newItemParentTitle = $derived(newItemParent ? findNodeById(tree, newItemParent)?.title ?? null : null);
	const moveTargets = $derived(moveModalNode ? getMoveTargets(tree, moveModalNode) : []);

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
		// On mobile, the sidebar is a full-screen overlay — close it so the editor is visible.
		if (typeof window !== 'undefined' && window.innerWidth <= 768) {
			sidebarOpen = false;
		}
		const res = await fetch(`/api/documents/${docId}`);
		activeDoc = await res.json();
	}

	async function saveDocument(content: string, docId: string) {
		if (!docId) return;
		const res = await fetch(`/api/documents/${docId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content })
		});
		// Surface HTTP failures so the Editor's catch flips status back to 'unsaved'.
		if (!res.ok) throw new Error(`Save failed: ${res.status}`);
		const updated = await res.json();
		// Update word count in tree for the doc the content belongs to, not activeDocId.
		updateTreeNodeWordCount(tree, docId, updated.word_count);
		tree = [...tree]; // trigger reactivity
	}

	// ─── Snapshot functions ─────────────────────────────────────────────

	async function loadSnapshots(docId: string, reset = true) {
		if (reset) {
			snapshotOffset = 0;
			snapshots = [];
		}
		const limit = 50;
		const res = await fetch(`/api/documents/${docId}/snapshots?limit=${limit}&offset=${snapshotOffset}`);
		const batch: SnapshotSummary[] = await res.json();
		if (reset) {
			snapshots = batch;
		} else {
			snapshots = [...snapshots, ...batch];
		}
		hasMoreSnapshots = batch.length >= limit;
		snapshotOffset += batch.length;
	}

	async function loadMoreSnapshots() {
		if (!activeDocId) return;
		await loadSnapshots(activeDocId, false);
	}

	async function toggleSnapshots() {
		showSnapshots = !showSnapshots;
		if (showSnapshots && activeDocId) {
			await loadSnapshots(activeDocId);
		}
		if (!showSnapshots) {
			previewingSnapshot = null;
			dismissDiff();
		}
	}

	async function previewSnapshot(snapId: string) {
		if (!activeDocId) return;
		// Flush pending editor save before entering preview
		if (editorFlush) await editorFlush();
		const res = await fetch(`/api/documents/${activeDocId}/snapshots/${snapId}`);
		if (!res.ok) return;
		const snapData = await res.json();
		dismissDiff();
		previewingSnapshot = { id: snapId, content: snapData.content };
	}

	function dismissPreview() {
		previewingSnapshot = null;
	}

	// Diff takeover is visible while loading, on error, or with a result
	const diffActive = $derived(diffLoading || !!diffError || !!snapshotDiff);

	async function compareSnapshot(snapId: string) {
		if (!activeDocId) return;
		// Flush pending editor save so the diff reflects what's on screen
		if (editorFlush) await editorFlush();
		previewingSnapshot = null;
		snapshotDiff = null;
		diffError = null;
		diffLoading = true;
		try {
			const res = await fetch(`/api/documents/${activeDocId}/snapshots/${snapId}/diff`);
			if (!res.ok) {
				diffError = `Could not load comparison (${res.status})`;
				return;
			}
			const data = await res.json();
			snapshotDiff = { snapId, ...data };
		} catch {
			diffError = 'Could not load comparison';
		} finally {
			diffLoading = false;
		}
	}

	function dismissDiff() {
		snapshotDiff = null;
		diffError = null;
		diffLoading = false;
	}

	function requestRestore(snapId: string) {
		showRestoreConfirm = snapId;
	}

	async function confirmRestore() {
		if (!showRestoreConfirm || !activeDocId) return;
		const snapId = showRestoreConfirm;
		showRestoreConfirm = null;

		const res = await fetch(`/api/documents/${activeDocId}/restore/${snapId}`, { method: 'POST' });
		if (!res.ok) return;
		const result = await res.json();

		// Reload document with restored content
		const docRes = await fetch(`/api/documents/${activeDocId}`);
		activeDoc = await docRes.json();

		// Bump contentVersion to tell Editor to reload without save-then-switch
		editorContentVersion++;

		// Update tree word count
		updateTreeNodeWordCount(tree, activeDocId, result.document.word_count);
		tree = [...tree];

		// Close preview + diff, refresh snapshot list
		previewingSnapshot = null;
		dismissDiff();
		await loadSnapshots(activeDocId);
	}

	async function handleManualSnapshot() {
		if (!activeDocId) return;
		const res = await fetch(`/api/documents/${activeDocId}/snapshots`, { method: 'POST' });
		if (!res.ok) return;
		// Refresh snapshot list if panel is open
		if (showSnapshots) {
			await loadSnapshots(activeDocId);
		}
	}

	function registerEditorFlush(flush: () => Promise<void>) {
		editorFlush = flush;
	}

	// Close preview and refresh snapshots when active doc changes while panel is open
	let prevSnapshotDocId: string | null = null;
	$effect(() => {
		const docId = activeDocId;
		if (docId && showSnapshots && docId !== prevSnapshotDocId) {
			prevSnapshotDocId = docId;
			previewingSnapshot = null;
			dismissDiff();
			loadSnapshots(docId);
		} else if (!showSnapshots) {
			prevSnapshotDocId = null;
		}
	});

	// ─── Tree helpers ───────────────────────────────────────────────────

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

	async function renameNovel() {
		const trimmed = novelTitleDraft.trim();
		if (!trimmed || trimmed === data.novel.title) {
			editingNovelTitle = false;
			return;
		}
		await fetch(`/api/novels/${novelId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: trimmed })
		});
		data.novel.title = trimmed;
		editingNovelTitle = false;
	}

	function startRename(node: TreeNode) {
		renamingNodeId = node.id;
		renameDraft = node.title;
	}

	async function renameNode(node: TreeNode, newTitle: string) {
		const trimmed = newTitle.trim();
		if (!trimmed || trimmed === node.title) {
			renamingNodeId = null;
			return;
		}
		await fetch(`/api/novels/${novelId}/tree/nodes/${node.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: trimmed, type: node.type })
		});
		node.title = trimmed;
		if (node.id === activeDocId && activeDoc) {
			activeDoc.title = trimmed;
		}
		renamingNodeId = null;
	}

	// Autofocus search input when panel opens
	$effect(() => {
		if (showSearch && searchInputEl) {
			// Tick delay so the DOM has rendered
			setTimeout(() => searchInputEl?.focus(), 0);
		}
	});

	// Autofocus the New-item modal's title input. The `autofocus` attribute on
	// the input alone isn't enough here: the modal is opened by clicking a
	// button (+ Doc / + Folder / a folder row's +), and Chromium leaves focus
	// on the just-clicked button rather than yielding it to a freshly-inserted
	// autofocus element — confirmed live, same reasoning as the search input
	// above (also opened via a button click).
	$effect(() => {
		if (showNewModal && newItemTitleEl) {
			setTimeout(() => newItemTitleEl?.focus(), 0);
		}
	});

	// Autofocus the tree-node rename input — same Chromium quirk as the two
	// autofocus effects above: this field is opened via a button click
	// (⋯ → Rename) or a dblclick, and plain `autofocus` doesn't reliably
	// grab focus in either case.
	$effect(() => {
		if (renamingNodeId && renameInputEl) {
			setTimeout(() => renameInputEl?.focus(), 0);
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
		if (draggedNode.type === 'folder' && isDescendantOf(draggedNode, node.id)) return;

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
			newSortOrder = computeAppendSortOrder(tree, targetNode.id, draggedNode.id);
		} else {
			const { siblings, parentId } = getVisibleSiblingsOf(tree, targetNode.id);
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

	// ─── Touch-friendly move (coarse pointers) ─────────────────────────
	// Same reorder endpoint + payload shape as handleDrop above — only the
	// parent/sort_order computation differs (shared helpers in $lib/binder-tree).

	async function moveNode(node: TreeNode, direction: 'up' | 'down') {
		const move = computeSwapMove(tree, node.id, direction);
		if (!move) return;

		await fetch(`/api/novels/${novelId}/tree`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				node_id: node.id,
				node_type: node.type,
				new_parent_id: move.parentId,
				new_sort_order: move.sortOrder
			})
		});

		await loadTree();
	}

	function openMoveModal(node: TreeNode) {
		moveModalNode = node;
		showMoveModal = true;
	}

	function closeMoveModal() {
		showMoveModal = false;
		moveModalNode = null;
	}

	async function moveNodeInto(newParentId: string | null) {
		if (!moveModalNode) return;
		const node = moveModalNode;
		const newSortOrder = computeAppendSortOrder(tree, newParentId, node.id);
		closeMoveModal();

		await fetch(`/api/novels/${novelId}/tree`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				node_id: node.id,
				node_type: node.type,
				new_parent_id: newParentId,
				new_sort_order: newSortOrder
			})
		});

		await loadTree();
	}

	function toggleNodeMenu(nodeId: string) {
		openMenuNodeId = openMenuNodeId === nodeId ? null : nodeId;
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
			{#if editingNovelTitle}
				<!-- svelte-ignore a11y_autofocus -->
				<input
					class="novel-title-input"
					bind:value={novelTitleDraft}
					onblur={renameNovel}
					onkeydown={(e) => { if (e.key === 'Enter') renameNovel(); if (e.key === 'Escape') editingNovelTitle = false; }}
					autofocus
				/>
			{:else}
				<h2 ondblclick={() => { editingNovelTitle = true; novelTitleDraft = data.novel.title; }} title="Double-click to rename">{data.novel.title}</h2>
			{/if}
			<button class="sidebar-toggle" onclick={() => sidebarOpen = !sidebarOpen}>
				{sidebarOpen ? '◀' : '▶'}
			</button>
		</div>

		{#if sidebarOpen}
			<div class="sidebar-content">
				<div class="sidebar-actions">
					<button class="btn-sm" onclick={() => openNewModal('document', getDefaultDocumentParent(tree, activeDocId))}>+ Doc</button>
					<button class="btn-sm" onclick={() => openNewModal('folder')}>+ Folder</button>
					<button class="btn-sm" onclick={() => { showSearch = !showSearch; }}>Search</button>
					<button class="btn-sm" onclick={() => showCompileDialog = true}>Compile</button>
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
									<button class="search-result" onclick={async () => { const term = searchQuery; showSearch = false; searchQuery = ''; searchResults = []; await selectDocument(result.id); await tick(); pendingSearchTerm = term; }}>
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
									<span class="node-icon {item.type === 'folder' ? 'icon-folder' : 'icon-doc'}" aria-hidden="true"></span>
									<span class="node-title">{item.title}</span>
									<button class="btn-tiny" onclick={() => restoreItem(item.id, item.type)} title="Restore">↩</button>
								</div>
							{/each}
						</div>
					{/if}
				</nav>

				<!-- Mobile-only drawer footer — the top bar (and its Help link) is
				     hidden on the workspace at this breakpoint (see +layout.svelte),
				     so this is the reachable surface for Help on a phone. -->
				<div class="sidebar-footer">
					<a href="/help" class="sidebar-help-link">? Help</a>
				</div>
			</div>
		{/if}
	</aside>

	<!-- Mobile backdrop — tap to close the sidebar overlay -->
	{#if sidebarOpen}
		<button class="sidebar-backdrop" onclick={() => sidebarOpen = false} aria-label="Close binder"></button>
	{/if}

	<!-- Main content -->
	<main class="editor-area">
		<!-- Mobile-only binder reopen — the in-sidebar toggle slides off-screen when collapsed -->
		{#if !sidebarOpen}
			<button class="binder-reopen" onclick={() => sidebarOpen = true} aria-label="Open binder" title="Open binder">☰</button>
		{/if}

		{#if activeDoc}
			<!-- Live editor — hidden during preview/diff, never destroyed -->
			<div class="editor-wrapper" class:hidden={!!previewingSnapshot || diffActive}>
				{#if browser}
					<Editor
						docId={activeDoc.id}
						initialContent={activeDoc.content || ''}
						title={activeDoc.title}
						onsave={saveDocument}
						searchTerm={pendingSearchTerm}
						onSearchHighlightDone={() => { pendingSearchTerm = null; }}
						onSnapshotsToggle={toggleSnapshots}
						onManualSnapshot={handleManualSnapshot}
						registerFlush={registerEditorFlush}
						contentVersion={editorContentVersion}
						onrename={(t) => {
							const node = activeDocId ? findNodeById(tree, activeDocId) : null;
							if (node) renameNode(node, t);
						}}
					/>
				{/if}
			</div>

			<!-- Read-only preview — shown only during preview -->
			{#if previewingSnapshot}
				<div class="snapshot-preview-area">
					<div class="preview-banner">
						<span>Viewing snapshot</span>
						<div class="preview-actions">
							<button class="btn btn-primary" onclick={() => { if (previewingSnapshot) requestRestore(previewingSnapshot.id); }}>Restore this version</button>
							<button class="btn btn-secondary" onclick={dismissPreview}>Back to current</button>
						</div>
					</div>
					{#if browser}
						<div class="preview-scroll">
							{#key previewingSnapshot.id}
								<SnapshotPreview content={previewingSnapshot.content} />
							{/key}
						</div>
					{/if}
				</div>
			{/if}

			<!-- Snapshot diff — panel takeover, same pattern as preview -->
			{#if diffActive}
				<div class="snapshot-preview-area">
					<div class="preview-banner">
						<span>Comparing snapshot (A) with current (B)</span>
						<div class="preview-actions">
							{#if snapshotDiff}
								<button class="btn btn-primary" onclick={() => snapshotDiff && requestRestore(snapshotDiff.snapId)}>Restore this version</button>
							{/if}
							<button class="btn btn-secondary" onclick={dismissDiff}>Back to current</button>
						</div>
					</div>
					<div class="preview-scroll">
						{#if diffLoading}
							<p class="diff-status">Loading comparison…</p>
						{:else if diffError}
							<p class="diff-status diff-status-error">{diffError}</p>
						{:else if snapshotDiff}
							<div class="snapshot-diff-body">
								<DiffView
									changes={snapshotDiff.changes}
									wordCountA={snapshotDiff.wordCountA}
									wordCountB={snapshotDiff.wordCountB}
								/>
							</div>
						{/if}
					</div>
				</div>
			{/if}
		{:else}
			<div class="no-doc">
				<p>Select a document from the binder to begin writing.</p>
			</div>
		{/if}
	</main>

	<!-- Snapshot panel -->
	{#if showSnapshots && activeDocId}
		<SnapshotPanel
			{snapshots}
			activeSnapshotId={previewingSnapshot?.id ?? snapshotDiff?.snapId ?? null}
			onPreview={previewSnapshot}
			onCompare={compareSnapshot}
			onClose={() => { showSnapshots = false; previewingSnapshot = null; dismissDiff(); }}
			onLoadMore={hasMoreSnapshots ? loadMoreSnapshots : undefined}
		/>
	{/if}
</div>

<!-- New item modal -->
{#if showNewModal}
	<div class="modal-backdrop" onclick={() => showNewModal = false} role="presentation">
		<div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && (showNewModal = false)} role="dialog" aria-modal="true" tabindex="-1">
			<h2>New {newItemType === 'folder' ? 'Folder' : 'Document'}</h2>
			{#if newItemParentTitle}
				<p class="modal-hint">in {newItemParentTitle}</p>
			{/if}
			<!-- svelte-ignore a11y_autofocus -->
			<input
				type="text"
				bind:this={newItemTitleEl}
				bind:value={newItemTitle}
				placeholder={newItemType === 'folder' ? 'Folder name' : 'Document title'}
				onkeydown={(e) => e.key === 'Enter' && createItem()}
				autofocus
			/>
			<div class="modal-actions">
				<button class="btn btn-secondary" onclick={() => showNewModal = false}>Cancel</button>
				<button class="btn btn-primary" onclick={createItem} disabled={!newItemTitle.trim()}>Create</button>
			</div>
		</div>
	</div>
{/if}

<!-- Move into… picker (touch-only reorder path — same reorder endpoint as drag-and-drop) -->
{#if showMoveModal && moveModalNode}
	<div class="modal-backdrop" onclick={closeMoveModal} role="presentation">
		<div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && closeMoveModal()} role="dialog" aria-modal="true" tabindex="-1">
			<h2>Move "{moveModalNode.title}"</h2>
			<div class="move-target-list">
				<button class="move-target" onclick={() => moveNodeInto(null)}>Top level</button>
				{#each moveTargets as target (target.id)}
					<button class="move-target" style="padding-left: {0.75 + target.depth}rem" onclick={() => moveNodeInto(target.id)}>{target.title}</button>
				{/each}
			</div>
			<div class="modal-actions">
				<button class="btn btn-secondary" onclick={closeMoveModal}>Cancel</button>
			</div>
		</div>
	</div>
{/if}

<!-- Restore confirmation modal -->
{#if showRestoreConfirm}
	<div class="modal-backdrop" onclick={() => showRestoreConfirm = null} role="presentation">
		<div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && (showRestoreConfirm = null)} role="dialog" aria-modal="true" tabindex="-1">
			<h2>Restore to this version?</h2>
			<p class="modal-body">Your current document will be saved as a snapshot before restoring. Nothing will be lost.</p>
			<div class="modal-actions">
				<button class="btn btn-secondary" onclick={() => showRestoreConfirm = null}>Cancel</button>
				<button class="btn btn-primary" onclick={confirmRestore}>Restore</button>
			</div>
		</div>
	</div>
{/if}

<!-- Compile dialog -->
<CompileDialog
	{novelId}
	novelTitle={data.novel.title}
	{tree}
	bind:open={showCompileDialog}
	onClose={() => showCompileDialog = false}
/>

{#snippet treeNode(node: TreeNode, depth: number)}
	{#if !node.deleted_at}
		{@const siblingInfo = getVisibleSiblingsOf(tree, node.id)}
		{@const nodeIdx = siblingInfo.siblings.findIndex((s) => s.id === node.id)}
		{@const isFirstSibling = nodeIdx <= 0}
		{@const isLastSibling = nodeIdx === siblingInfo.siblings.length - 1}
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
				<span class="node-icon icon-folder" aria-hidden="true"></span>
				{#if renamingNodeId === node.id}
					<!-- svelte-ignore a11y_autofocus -->
					<input
						class="rename-input"
						bind:this={renameInputEl}
						bind:value={renameDraft}
						onblur={() => renameNode(node, renameDraft)}
						onkeydown={(e) => {
							if (e.key === 'Enter') { e.preventDefault(); renameNode(node, renameDraft); }
							if (e.key === 'Escape') { renamingNodeId = null; }
						}}
						autofocus
					/>
				{:else}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<span class="node-title folder-title" ondblclick={() => startRename(node)} title="Double-click to rename">{node.title}</span>
				{/if}
				<span class="node-actions">
					<button class="btn-tiny" onclick={() => openNewModal('document', node.id)} title="New document">+</button>
					<button class="btn-tiny node-menu-btn" onclick={() => toggleNodeMenu(node.id)} title="Move" aria-label="Move folder">⋯</button>
					<button class="btn-tiny" onclick={() => trashItem(node.id, 'folder')} title="Move to trash">×</button>
				</span>
			{:else}
				<span class="node-icon icon-doc" aria-hidden="true"></span>
				{#if renamingNodeId === node.id}
					<!-- svelte-ignore a11y_autofocus -->
					<input
						class="rename-input"
						bind:this={renameInputEl}
						bind:value={renameDraft}
						onblur={() => renameNode(node, renameDraft)}
						onkeydown={(e) => {
							if (e.key === 'Enter') { e.preventDefault(); renameNode(node, renameDraft); }
							if (e.key === 'Escape') { renamingNodeId = null; }
						}}
						autofocus
					/>
				{:else}
					<button class="node-title doc-title" onclick={() => selectDocument(node.id)} ondblclick={() => startRename(node)} title="Double-click to rename">
						{node.title}
					</button>
				{/if}
				{#if node.word_count}
					<span class="word-badge">{node.word_count}</span>
				{/if}
				<span class="node-actions">
					<button class="btn-tiny node-menu-btn" onclick={() => toggleNodeMenu(node.id)} title="Move" aria-label="Move document">⋯</button>
					<button class="btn-tiny" onclick={() => trashItem(node.id, 'document')} title="Move to trash">×</button>
				</span>
			{/if}

			{#if openMenuNodeId === node.id}
				<div class="node-menu" role="menu">
					<button
						class="node-menu-item"
						onclick={() => { openMenuNodeId = null; startRename(node); }}
					>✎ Rename</button>
					<button
						class="node-menu-item"
						disabled={isFirstSibling}
						onclick={() => { moveNode(node, 'up'); openMenuNodeId = null; }}
					>↑ Move up</button>
					<button
						class="node-menu-item"
						disabled={isLastSibling}
						onclick={() => { moveNode(node, 'down'); openMenuNodeId = null; }}
					>↓ Move down</button>
					<button
						class="node-menu-item"
						onclick={() => { openMenuNodeId = null; openMoveModal(node); }}
					>⇒ Move into…</button>
				</div>
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
		height: 100dvh; /* dynamic viewport unit — avoids mobile URL-bar/keyboard overlap */
	}

	/* Mobile-only binder reopen button (hidden on desktop, which keeps a rail toggle) */
	.binder-reopen {
		display: none;
	}

	/* Mobile-only backdrop behind the open sidebar overlay */
	.sidebar-backdrop {
		display: none;
	}

	/* Sidebar */
	.sidebar {
		width: 300px;
		min-width: 300px;
		background: var(--bg-sidebar);
		border-right: 1px solid var(--border-strong);
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
		border-bottom: 1px solid var(--border-strong);
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		position: relative;
	}

	.back-link {
		font-size: 0.8rem;
		text-decoration: none;
		color: var(--text-secondary);
	}

	.back-link:hover {
		color: var(--accent);
	}

	.sidebar-header h2 {
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-heading);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: default;
	}

	.novel-title-input {
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-heading);
		border: 1px solid var(--accent);
		border-radius: 4px;
		padding: 0.1rem 0.3rem;
		width: 100%;
		background: var(--bg-surface);
	}

	.novel-title-input:focus {
		outline: none;
	}

	.sidebar-toggle {
		position: absolute;
		right: 0.5rem;
		top: 0.5rem;
		background: none;
		border: none;
		cursor: pointer;
		font-size: 0.8rem;
		color: var(--text-secondary);
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
		border-bottom: 1px solid var(--border-strong);
	}

	.btn-sm {
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
		background: var(--bg-surface);
		border: 1px solid var(--border-input);
		border-radius: 4px;
		cursor: pointer;
		color: var(--accent);
	}

	.btn-sm:hover {
		background: var(--bg-elevated);
	}

	/* Search */
	.search-panel {
		padding: 0.5rem;
		border-bottom: 1px solid var(--border-strong);
	}

	.search-panel input {
		width: 100%;
		padding: 0.4rem 0.5rem;
		border: 1px solid var(--border-input);
		border-radius: 4px;
		font-size: 0.8rem;
		background: var(--bg-surface);
		color: var(--text);
	}

	.search-panel input:focus {
		outline: none;
		border-color: var(--accent);
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
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 4px;
		margin-top: 0.25rem;
		cursor: pointer;
		font-size: 0.8rem;
		color: var(--text);
	}

	.search-result:hover {
		background: var(--bg-elevated);
	}

	.result-title {
		display: block;
		font-weight: 600;
		font-size: 0.8rem;
	}

	.result-snippet {
		display: block;
		font-size: 0.75rem;
		color: var(--text-faint);
		margin-top: 0.15rem;
	}

	:global(.result-snippet mark) {
		background: var(--search-highlight);
		padding: 0 2px;
		border-radius: 2px;
	}

	.no-results {
		font-size: 0.8rem;
		color: var(--text-muted);
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
		background: var(--tree-hover);
	}

	.tree-item.active {
		background: var(--accent-bg);
	}

	.tree-item.dragging {
		opacity: 0.4;
	}

	.tree-item.drag-before {
		box-shadow: 0 -2px 0 0 var(--accent);
	}

	.tree-item.drag-after {
		box-shadow: 0 2px 0 0 var(--accent);
	}

	.tree-item.drag-inside {
		background: var(--accent-bg-strong);
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
		color: var(--text-secondary);
		padding: 0.1rem;
		width: 1rem;
		flex-shrink: 0;
	}

	.node-icon {
		font-size: 0.8rem;
		flex-shrink: 0;
		width: 1rem;
		text-align: center;
		color: var(--text-muted);
	}

	.icon-folder::before {
		content: '';
		display: inline-block;
		width: 0.8rem;
		height: 0.6rem;
		background: var(--accent);
		clip-path: polygon(0 20%, 40% 20%, 50% 0, 100% 0, 100% 100%, 0 100%);
		opacity: 0.6;
	}

	.icon-doc::before {
		content: '';
		display: inline-block;
		width: 0.55rem;
		height: 0.7rem;
		background: var(--text-faint);
		clip-path: polygon(0 0, 65% 0, 100% 30%, 100% 100%, 0 100%);
		opacity: 0.5;
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
		color: var(--accent);
	}

	.doc-title {
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		font-size: 0.85rem;
		color: var(--text);
		padding: 0;
	}

	.doc-title:hover {
		color: var(--accent);
	}

	.rename-input {
		flex: 1;
		min-width: 0;
		font-size: 0.85rem;
		color: var(--text);
		border: 1px solid var(--accent);
		border-radius: 4px;
		padding: 0.1rem 0.3rem;
		background: var(--bg-surface);
	}

	.rename-input:focus {
		outline: none;
	}

	.word-badge {
		font-size: 0.65rem;
		color: var(--text-muted);
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

	/* Drag-and-drop covers reordering on desktop already, so the ↑/↓/Move-into
	   trigger stays hidden there (even on row hover) and only appears where
	   drag-and-drop can't work — coarse (touch) pointers. Declared before the
	   @media override below so the override wins the cascade on touch devices. */
	.node-menu-btn {
		display: none;
	}

	/* Touch devices have no hover — reveal load-bearing row actions permanently */
	@media (pointer: coarse) {
		.tree-item .node-actions {
			display: flex;
		}

		/* Reveal the touch-only move menu trigger too (see .node-menu-btn above) */
		.node-menu-btn {
			display: inline-block;
		}
	}

	.btn-tiny {
		background: none;
		border: none;
		cursor: pointer;
		font-size: 0.8rem;
		color: var(--text-muted);
		padding: 0 0.2rem;
	}

	.btn-tiny:hover {
		color: var(--accent);
	}

	.node-menu {
		position: absolute;
		top: 100%;
		right: 0.5rem;
		z-index: 20;
		min-width: 9rem;
		background: var(--bg-surface);
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		box-shadow: 0 8px 24px var(--shadow-lg);
		padding: 0.25rem;
		display: flex;
		flex-direction: column;
	}

	.node-menu-item {
		display: block;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		border-radius: 5px;
		padding: 0.4rem 0.5rem;
		font-size: 0.8rem;
		color: var(--text);
		cursor: pointer;
		white-space: nowrap;
	}

	.node-menu-item:hover:not(:disabled) {
		background: var(--accent-bg);
		color: var(--accent);
	}

	.node-menu-item:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.trash-section {
		margin-top: 1rem;
		border-top: 1px solid var(--border-strong);
		padding-top: 0.25rem;
	}

	.trash-header {
		font-size: 0.75rem;
		color: var(--text-muted);
		padding: 0.25rem 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	/* Mobile-only drawer footer (Help link) — desktop already has the top
	   bar's Help link, so this stays hidden there to avoid duplication. */
	.sidebar-footer {
		display: none;
	}

	.sidebar-help-link {
		font-size: 0.8rem;
		color: var(--text-secondary);
		text-decoration: none;
	}

	.sidebar-help-link:hover {
		color: var(--accent);
	}

	/* Editor area */
	.editor-area {
		flex: 1;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.editor-wrapper {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.hidden {
		display: none;
	}

	.snapshot-preview-area {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}

	/* Chrome above a scrolling read-only view — same rule as the editor header:
	   a selection dragged out of the snapshot text must not swallow the banner. */
	.preview-banner {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.5rem 1rem;
		background: var(--bg-elevated);
		border-bottom: 2px solid var(--saving);
		font-size: 0.85rem;
		color: var(--text-heading);
		-webkit-user-select: none;
		user-select: none;
	}

	.preview-actions {
		display: flex;
		gap: 0.5rem;
	}

	.preview-scroll {
		flex: 1;
		overflow-y: auto;
		background: var(--bg-surface);
	}

	.snapshot-diff-body {
		max-width: 700px;
		margin: 0 auto;
		padding: 2rem 1.5rem;
	}

	.diff-status {
		padding: 2rem 1.5rem;
		text-align: center;
		font-size: 0.9rem;
		color: var(--text-muted);
	}

	.diff-status-error {
		color: var(--error-text);
	}

	.modal-body {
		font-size: 0.9rem;
		color: var(--text-secondary);
		margin-bottom: 1rem;
		line-height: 1.5;
	}

	.modal-hint {
		font-size: 0.8rem;
		color: var(--text-muted);
		margin: -0.35rem 0 0.75rem;
	}

	.move-target-list {
		max-height: 300px;
		overflow-y: auto;
		border: 1px solid var(--border-input);
		border-radius: 6px;
		margin-bottom: 1rem;
	}

	.move-target {
		display: block;
		width: 100%;
		text-align: left;
		padding: 0.5rem 0.75rem;
		background: none;
		border: none;
		border-bottom: 1px solid var(--border);
		cursor: pointer;
		font-size: 0.85rem;
		color: var(--text);
	}

	.move-target:last-child {
		border-bottom: none;
	}

	.move-target:hover {
		background: var(--tree-hover);
		color: var(--accent);
	}

	.no-doc {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
	}

	/* Modals */
	.modal-backdrop {
		position: fixed;
		top: 0; left: 0; right: 0; bottom: 0;
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
		max-width: 400px;
		width: 90%;
		box-shadow: 0 8px 32px var(--shadow-lg);
	}

	.modal h2 { margin-bottom: 0.75rem; font-size: 1.1rem; color: var(--text-heading); }

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

	.btn { padding: 0.5rem 1.25rem; border-radius: 6px; border: 1px solid transparent; font-size: 0.9rem; cursor: pointer; }
	.btn-primary { background: var(--accent); color: var(--text-on-accent); }
	.btn-primary:hover { background: var(--accent-hover); }
	.btn-primary:disabled { opacity: 0.5; }
	.btn-secondary { background: var(--bg-surface); color: var(--accent); border-color: var(--border-input); }
	.btn-secondary:hover { background: var(--bg-elevated); }

	/* Mobile responsive */
	@media (max-width: 768px) {
		/* Document-level scrolling on mobile — see the note in Editor.svelte's
		   mobile block for why (Chrome/Android runs a selection away to the
		   ends of a nested scroll container). Both of these must give up
		   overflow:hidden as well as the fixed height: an overflow:hidden
		   ancestor makes itself the scrollport and would break the sticky
		   header and footer inside the editor. */
		.workspace {
			height: auto;
			min-height: 100dvh;
		}

		.editor-area,
		.editor-wrapper {
			overflow: visible;
		}

		/* The snapshot preview and diff views lose their nested scroller to the
		   same change (their height is no longer constrained), which fixes the
		   runaway selection there too. Their banner carries "Restore this
		   version" / "Back to current", so it sticks rather than scrolling out
		   of reach on a long snapshot — matching the editor header. */
		.preview-banner {
			position: sticky;
			top: 0;
			z-index: 20;
		}

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
			position: relative;
		}

		.sidebar-backdrop {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 45;
			background: var(--bg-overlay);
			border: none;
			cursor: pointer;
		}

		.binder-reopen {
			display: flex;
			align-items: center;
			justify-content: center;
			position: fixed;
			top: 0.5rem;
			left: 0.5rem;
			z-index: 40;
			width: 2.25rem;
			height: 2.25rem;
			background: var(--bg-surface);
			border: 1px solid var(--border-input);
			border-radius: 6px;
			font-size: 1rem;
			color: var(--accent);
			cursor: pointer;
			box-shadow: 0 2px 8px var(--shadow-lg);
		}

		/* Workspace hides the top bar (and its Help link) on mobile — surface
		   Help from the binder drawer footer instead, the drawer being the
		   one piece of chrome that's already reachable via ☰. */
		.sidebar-footer {
			display: block;
			padding: 0.5rem 1rem;
			border-top: 1px solid var(--border-strong);
		}
	}
</style>

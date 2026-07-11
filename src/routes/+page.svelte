<script lang="ts">
	import { goto } from '$app/navigation';
	import type { ScrivProject, BundleImportReport } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Novels are delivered by +page.server.ts (no client fetch on first paint —
	// saves a round trip on cellular). loadNovels() re-fetches after
	// create/import so the grid stays fresh without a full navigation.
	// svelte-ignore state_referenced_locally
	let novels: any[] = $state(data.novels ?? []);
	// Collections (universes → eras) travel with the server load too. Reloaded
	// after any shelf edit so the bookshelf stays fresh without a navigation.
	// svelte-ignore state_referenced_locally
	let collections: any[] = $state(data.collections ?? []);
	let showNewNovelModal = $state(false);
	let newNovelTitle = $state('');

	// Current user (from the layout load). Drives archivist-only UI.
	const currentUser = $derived(data.user);
	const isArchivist = $derived(currentUser?.role === 'archivist');

	// ─── Bookshelf toggle ────────────────────────────────────────────
	const SHELF_KEY = 'scriptorium-shelf';
	let selectedShelf = $state('all');

	// Distinct owners present in the data, as chip descriptors.
	const shelves = $derived.by(() => {
		const seen = new Set<string>();
		const owners: string[] = [];
		for (const n of novels) {
			if (n.owner_username && !seen.has(n.owner_username)) {
				seen.add(n.owner_username);
				owners.push(n.owner_username);
			}
		}
		const mine = currentUser?.username;
		// "Mine" first (if present), then the rest alphabetically.
		owners.sort((a, b) => {
			if (a === mine) return -1;
			if (b === mine) return 1;
			return a.localeCompare(b);
		});
		return [
			{ key: 'all', label: 'All' },
			...owners.map((u) => ({ key: u, label: u === mine ? 'Mine' : u }))
		];
	});

	const filteredNovels = $derived(
		selectedShelf === 'all'
			? novels
			: novels.filter((n) => n.owner_username === selectedShelf)
	);

	function selectShelf(key: string) {
		selectedShelf = key;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(SHELF_KEY, key);
		}
	}

	$effect(() => {
		// Restore persisted shelf on mount; fall back to "All" if that owner is
		// no longer present in the data.
		if (typeof localStorage === 'undefined') return;
		const saved = localStorage.getItem(SHELF_KEY);
		if (saved && shelves.some((s) => s.key === saved)) {
			selectedShelf = saved;
		} else if (saved) {
			selectedShelf = 'all';
		}
	});

	// ─── Owner picker (archivist only) ──────────────────────────────
	let usersList: { id: string; username: string; role: string }[] = $state([]);
	let usersLoaded = $state(false);
	let newNovelOwnerId = $state('');
	let importOwnerId = $state('');

	async function ensureUsersLoaded() {
		// /api/admin/users is archivist-only — never call it for writers.
		if (!isArchivist || usersLoaded) return;
		try {
			const res = await fetch('/api/admin/users');
			if (res.ok) {
				const body = await res.json();
				usersList = body.users ?? [];
				usersLoaded = true;
			}
		} catch {
			// Non-fatal: owner picker simply won't populate; creation defaults to self.
		}
	}

	// Import modal state machine
	type ImportMode = 'idle' | 'scanning' | 'project_list' | 'importing_single' | 'importing_batch' | 'report_single' | 'report_batch';
	let showImportModal = $state(false);
	let importMode = $state<ImportMode>('idle');
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

	// ─── Bundle import (W5b Unit D) ──────────────────────────────────
	// A sibling flow beside the .scriv scan/import above, reusing the same
	// modal, path-input conventions, and archivist owner picker (importOwnerId).
	// Own state machine because it has a dry-run → confirm step the .scriv
	// flow doesn't: idle -> dry_running -> dry_run_done -> importing -> done.
	type BundleMode = 'idle' | 'dry_running' | 'dry_run_done' | 'importing' | 'done';
	let bundlePath = $state('');
	let bundleMode = $state<BundleMode>('idle');
	let bundleError: string | null = $state(null);
	let bundleReports: BundleImportReport[] | null = $state(null);
	let isBundleBusy = $derived(bundleMode === 'dry_running' || bundleMode === 'importing');

	// The path/owner a completed dry run was run against. If either changes
	// afterward, the pending confirm is stale — reset before it can be acted
	// on (the footgun: dry-run one bundle, edit the path, hit confirm, import
	// the wrong thing).
	let lastDryRunPath = $state('');
	let lastDryRunOwnerId = $state('');

	$effect(() => {
		const pathNow = bundlePath.trim();
		const ownerNow = importOwnerId;
		if (
			(bundleMode === 'dry_run_done' || bundleMode === 'done') &&
			(pathNow !== lastDryRunPath || ownerNow !== lastDryRunOwnerId)
		) {
			bundleMode = 'idle';
			bundleReports = null;
			bundleError = null;
		}
	});

	// Client refresh after create/import — re-fetch the same list the server load
	// produced so the grid updates without a full navigation.
	async function loadNovels() {
		const res = await fetch('/api/novels');
		novels = await res.json();
	}

	function openNewNovelModal() {
		newNovelTitle = '';
		newNovelOwnerId = currentUser?.id ?? '';
		showNewNovelModal = true;
		ensureUsersLoaded();
	}

	async function createNovel() {
		if (!newNovelTitle.trim()) return;
		const payload: Record<string, unknown> = { title: newNovelTitle.trim() };
		if (isArchivist && newNovelOwnerId) payload.owner_id = newNovelOwnerId;
		const res = await fetch('/api/novels', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});
		const novel = await res.json();
		showNewNovelModal = false;
		newNovelTitle = '';
		goto(`/novels/${novel.id}`);
	}

	function openImportModal() {
		importOwnerId = currentUser?.id ?? '';
		ensureUsersLoaded();
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
		// Reset the bundle flow too — it's a sibling of the scriv flow above.
		bundlePath = '';
		bundleMode = 'idle';
		bundleError = null;
		bundleReports = null;
		lastDryRunPath = '';
		lastDryRunOwnerId = '';
		showImportModal = true;
	}

	function closeImportModal() {
		// Scanning is cancellable — abort it first
		if (scanAbort) { scanAbort.abort(); scanAbort = null; }
		// Block close only during active imports (not scanning/dry-running)
		if (importMode === 'importing_single' || importMode === 'importing_batch') return;
		if (isBundleBusy) return;
		showImportModal = false;
	}

	async function importSingle() {
		if (!importPath.trim()) return;
		importMode = 'importing_single';
		importError = null;
		singleReport = null;
		try {
			const importPayload: Record<string, unknown> = { path: importPath.trim() };
			if (isArchivist && importOwnerId) importPayload.owner_id = importOwnerId;
			const res = await fetch('/api/import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(importPayload)
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
			const res = await fetch('/api/import/scan', {
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
			const batchPayload: Record<string, unknown> = { paths };
			if (isArchivist && importOwnerId) batchPayload.owner_id = importOwnerId;
			const res = await fetch('/api/import/batch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(batchPayload)
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

	async function bundleDryRun() {
		if (!bundlePath.trim()) return;
		bundleMode = 'dry_running';
		bundleError = null;
		bundleReports = null;
		try {
			const payload: Record<string, unknown> = { path: bundlePath.trim(), dry_run: true };
			if (isArchivist && importOwnerId) payload.owner_id = importOwnerId;
			const res = await fetch('/api/import/bundle', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				bundleError = err.message || 'Dry run failed';
				bundleMode = 'idle';
				return;
			}
			bundleReports = await res.json();
			lastDryRunPath = bundlePath.trim();
			lastDryRunOwnerId = importOwnerId;
			bundleMode = 'dry_run_done';
		} catch (err: any) {
			bundleError = err.message;
			bundleMode = 'idle';
		}
	}

	async function bundleImport() {
		if (bundleMode !== 'dry_run_done' || !bundleReports) return;
		bundleMode = 'importing';
		bundleError = null;
		try {
			const payload: Record<string, unknown> = { path: bundlePath.trim(), dry_run: false };
			if (isArchivist && importOwnerId) payload.owner_id = importOwnerId;
			const res = await fetch('/api/import/bundle', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				bundleError = err.message || 'Import failed';
				bundleMode = 'dry_run_done';
				return;
			}
			bundleReports = await res.json();
			bundleMode = 'done';
			await loadNovels();
		} catch (err: any) {
			bundleError = err.message;
			bundleMode = 'dry_run_done';
		}
	}

	function bundleBack() {
		bundleMode = 'idle';
		bundleReports = null;
		bundleError = null;
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

	// Novel status vocabulary — per spec.md's Data Model ("Novel — ...
	// status (draft/revision/complete/abandoned)"). Mirrors NOVEL_STATUSES
	// in src/lib/server/validate.ts, which enforces the same set server-side.
	const NOVEL_STATUSES = ['draft', 'revision', 'complete', 'abandoned'];

	async function cycleNovelStatus(e: MouseEvent, novelId: string, currentStatus: string) {
		// Card is a link — stop the click from navigating (same guard as rename-btn).
		e.preventDefault();
		const idx = NOVEL_STATUSES.indexOf(currentStatus);
		const next = NOVEL_STATUSES[(idx + 1) % NOVEL_STATUSES.length];
		await fetch(`/api/novels/${novelId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: next })
		});
		await loadNovels();
	}

	// ─── Collections: the bookshelf (universes → eras → version stacks) ──

	async function loadCollections() {
		const res = await fetch('/api/collections');
		if (res.ok) collections = await res.json();
	}

	const bySortOrder = (a: any, b: any) => a.sort_order - b.sort_order;
	const byUpdatedDesc = (a: any, b: any) => String(b.updated_at).localeCompare(String(a.updated_at));

	// Top-level collections ("universes") and their child "eras".
	const topLevels = $derived([...collections].filter((c) => c.parent_id === null).sort(bySortOrder));
	function childrenOf(id: string) {
		return [...collections].filter((c) => c.parent_id === id).sort(bySortOrder);
	}

	// Owner-filtered novels assigned to a given collection (null = Unsorted).
	function novelsIn(collectionId: string | null) {
		return filteredNovels.filter((n) => (n.collection_id ?? null) === collectionId);
	}

	// A universe is worth rendering when unfiltered (structure/drop target), or,
	// under an owner filter, only when it holds matching cards directly or in an era.
	function universeVisible(top: any): boolean {
		if (selectedShelf === 'all') return true;
		if (novelsIn(top.id).length > 0) return true;
		return childrenOf(top.id).some((era) => novelsIn(era.id).length > 0);
	}
	function eraVisible(era: any): boolean {
		return selectedShelf === 'all' || novelsIn(era.id).length > 0;
	}

	// Build the ordered shelf items for a collection: standalone cards plus
	// version-stacks (novels sharing a stack_label; a lone-labelled novel is
	// just a card). Items are ordered by most-recently-updated representative.
	type ShelfItem =
		| { type: 'card'; novel: any; sortKey: string }
		| { type: 'stack'; label: string; novels: any[]; front: any; sortKey: string };
	function shelfItems(list: any[]): ShelfItem[] {
		const groups = new Map<string, any[]>();
		const items: ShelfItem[] = [];
		for (const n of list) {
			const label = n.stack_label;
			if (label) {
				if (!groups.has(label)) groups.set(label, []);
				groups.get(label)!.push(n);
			} else {
				items.push({ type: 'card', novel: n, sortKey: String(n.updated_at) });
			}
		}
		for (const [label, members] of groups) {
			if (members.length === 1) {
				items.push({ type: 'card', novel: members[0], sortKey: String(members[0].updated_at) });
			} else {
				members.sort(byUpdatedDesc);
				items.push({ type: 'stack', label, novels: members, front: members[0], sortKey: String(members[0].updated_at) });
			}
		}
		items.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
		return items;
	}

	// Distinct stack labels already used within a collection (for quick-choice chips).
	function stackLabelsIn(collectionId: string | null): string[] {
		const seen = new Set<string>();
		for (const n of novelsIn(collectionId)) {
			if (n.stack_label) seen.add(n.stack_label);
		}
		return [...seen].sort((a, b) => a.localeCompare(b));
	}

	// ─── Collapse state (universes + eras), persisted, SSR-guarded ──────
	const COLLAPSE_KEY = 'scriptorium-collections-collapsed';
	let collapsed = $state<Record<string, boolean>>({});

	$effect(() => {
		if (typeof localStorage === 'undefined') return;
		const saved = localStorage.getItem(COLLAPSE_KEY);
		if (saved) {
			try {
				collapsed = JSON.parse(saved);
			} catch {
				collapsed = {};
			}
		}
	});

	function isCollapsed(key: string): boolean {
		return !!collapsed[key];
	}
	function toggleCollapse(key: string) {
		collapsed = { ...collapsed, [key]: !collapsed[key] };
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
		}
	}

	// ─── Version-stack expansion (ephemeral, not persisted) ─────────────
	let expandedStacks = $state<Set<string>>(new Set());
	function stackKey(collectionKey: string, label: string) {
		return `${collectionKey}::${label}`;
	}
	function toggleStackExpand(key: string) {
		const next = new Set(expandedStacks);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		expandedStacks = next;
	}

	// ─── Assignment (Move to… / drag-and-drop / Stack…) ─────────────────
	async function assignCollection(novelId: string, collectionId: string | null) {
		await fetch(`/api/novels/${novelId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ collection_id: collectionId })
		});
		openMenuNovelId = null;
		await loadNovels();
	}

	async function setStackLabel(novelId: string, label: string | null) {
		const value = label && label.trim() ? label.trim() : null;
		await fetch(`/api/novels/${novelId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ stack_label: value })
		});
		openMenuNovelId = null;
		stackInput = '';
		await loadNovels();
	}

	// HTML5 drag-and-drop (desktop enhancement). The card <a> is draggable;
	// dropping onto a universe/era header assigns the collection. dragOccurred
	// suppresses the card's own navigation for the click that follows a drag.
	let draggedNovelId = $state<string | null>(null);
	let dropTargetKey = $state<string | null>(null);
	let dragOccurred = false;

	function onCardDragStart(e: DragEvent, novelId: string) {
		draggedNovelId = novelId;
		dragOccurred = true;
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}
	function onCardDragEnd() {
		draggedNovelId = null;
		dropTargetKey = null;
		// Reset just after the click that a drag-release can synthesize.
		setTimeout(() => (dragOccurred = false), 60);
	}
	function onHeaderDragOver(e: DragEvent, key: string) {
		if (!draggedNovelId) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dropTargetKey = key;
	}
	function onHeaderDragLeave(key: string) {
		if (dropTargetKey === key) dropTargetKey = null;
	}
	function onHeaderDrop(e: DragEvent, collectionId: string | null, key: string) {
		e.preventDefault();
		const id = draggedNovelId;
		dropTargetKey = null;
		draggedNovelId = null;
		if (id) assignCollection(id, collectionId);
	}
	function suppressCardNav(e: MouseEvent, novelId: string) {
		if (dragOccurred || renamingNovelId === novelId || openMenuNovelId === novelId) e.preventDefault();
	}

	// ─── Per-card menu (Move to… + Stack…) ──────────────────────────────
	let openMenuNovelId = $state<string | null>(null);
	let stackInput = $state('');
	function toggleMenu(e: MouseEvent, novelId: string) {
		e.preventDefault();
		e.stopPropagation();
		openMenuNovelId = openMenuNovelId === novelId ? null : novelId;
		stackInput = '';
	}

	// ─── Manage shelves modal ───────────────────────────────────────────
	let showManageModal = $state(false);
	let newCollTitle = $state('');
	let newCollParent = $state('');
	let renamingCollId = $state<string | null>(null);
	let renamingCollTitle = $state('');
	let deleteConfirmColl: any = $state(null);

	function openManageModal() {
		newCollTitle = '';
		newCollParent = '';
		renamingCollId = null;
		deleteConfirmColl = null;
		showManageModal = true;
	}

	async function createCollection() {
		const title = newCollTitle.trim();
		if (!title) return;
		const payload: Record<string, unknown> = { title };
		if (newCollParent) payload.parent_id = newCollParent;
		await fetch('/api/collections', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});
		newCollTitle = '';
		newCollParent = '';
		await loadCollections();
	}

	async function renameCollection(id: string) {
		const title = renamingCollTitle.trim();
		if (!title) { renamingCollId = null; return; }
		await fetch(`/api/collections/${id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title })
		});
		renamingCollId = null;
		await loadCollections();
	}

	// Reorder among siblings by swapping sort_order with the adjacent sibling.
	async function moveCollection(coll: any, dir: -1 | 1) {
		const siblings = coll.parent_id === null ? topLevels : childrenOf(coll.parent_id);
		const idx = siblings.findIndex((s) => s.id === coll.id);
		const swapWith = siblings[idx + dir];
		if (!swapWith) return;
		await Promise.all([
			fetch(`/api/collections/${coll.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sort_order: swapWith.sort_order })
			}),
			fetch(`/api/collections/${swapWith.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sort_order: coll.sort_order })
			})
		]);
		await loadCollections();
	}

	// Delete counts (for the confirm copy): members fall to Unsorted, child eras promote.
	function deleteMemberCount(id: string): number {
		return novels.filter((n) => n.collection_id === id).length;
	}
	function deleteChildCount(id: string): number {
		return childrenOf(id).length;
	}
	async function confirmDeleteCollection() {
		const coll = deleteConfirmColl;
		if (!coll) return;
		await fetch(`/api/collections/${coll.id}`, { method: 'DELETE' });
		deleteConfirmColl = null;
		await Promise.all([loadCollections(), loadNovels()]);
	}
</script>

<div class="library">
	<header class="library-header">
		<h1>Scriptorium</h1>
		<p class="subtitle">A preservation-first writing application</p>
	</header>

	<div class="actions">
		<button class="btn btn-primary" onclick={openNewNovelModal}>New Novel</button>
		<button class="btn btn-secondary" onclick={openImportModal}>Import .scriv</button>
		<a class="btn btn-secondary" href="/novels/compare">Compare Drafts</a>
		<button class="btn btn-secondary" onclick={openManageModal}>Edit shelves</button>
	</div>

	{#if novels.length > 0 && shelves.length > 2}
		<div class="shelf-toggle" role="tablist" aria-label="Filter novels by owner">
			{#each shelves as shelf}
				<button
					class="shelf-chip"
					class:active={selectedShelf === shelf.key}
					role="tab"
					aria-selected={selectedShelf === shelf.key}
					onclick={() => selectShelf(shelf.key)}
				>{shelf.label}</button>
			{/each}
		</div>
	{/if}

	{#if novels.length === 0}
		<div class="empty-state">
			<p>No novels yet.</p>
			<p class="hint">Create a new novel or import a .scriv project to get started.</p>
		</div>
	{:else if filteredNovels.length === 0}
		<div class="empty-state">
			<p>No novels on this shelf.</p>
		</div>
	{:else}
		<div class="bookshelf">
			{#each topLevels as top (top.id)}
				{#if universeVisible(top)}
					<section class="shelf-section">
						<button
							type="button"
							class="collection-header universe-header"
							class:drop-target={dropTargetKey === top.id}
							onclick={() => toggleCollapse(top.id)}
							ondragover={(e) => onHeaderDragOver(e, top.id)}
							ondragleave={() => onHeaderDragLeave(top.id)}
							ondrop={(e) => onHeaderDrop(e, top.id, top.id)}
						>
							<span class="chevron">{isCollapsed(top.id) ? '▸' : '▾'}</span>
							<span class="collection-title">{top.title}</span>
						</button>
						{#if !isCollapsed(top.id)}
							{#if novelsIn(top.id).length > 0}
								{@render shelf(shelfItems(novelsIn(top.id)), top.id)}
							{/if}
							{#each childrenOf(top.id) as era (era.id)}
								{#if eraVisible(era)}
									<div class="era-block">
										<button
											type="button"
											class="collection-header era-header"
											class:drop-target={dropTargetKey === era.id}
											onclick={() => toggleCollapse(era.id)}
											ondragover={(e) => onHeaderDragOver(e, era.id)}
											ondragleave={() => onHeaderDragLeave(era.id)}
											ondrop={(e) => onHeaderDrop(e, era.id, era.id)}
										>
											<span class="chevron">{isCollapsed(era.id) ? '▸' : '▾'}</span>
											<span class="collection-title">{era.title}</span>
										</button>
										{#if !isCollapsed(era.id) && novelsIn(era.id).length > 0}
											{@render shelf(shelfItems(novelsIn(era.id)), era.id)}
										{/if}
									</div>
								{/if}
							{/each}
						{/if}
					</section>
				{/if}
			{/each}

			{#if novelsIn(null).length > 0}
				<section class="shelf-section">
					<button
						type="button"
						class="collection-header universe-header"
						class:drop-target={dropTargetKey === 'unsorted'}
						onclick={() => toggleCollapse('unsorted')}
						ondragover={(e) => onHeaderDragOver(e, 'unsorted')}
						ondragleave={() => onHeaderDragLeave('unsorted')}
						ondrop={(e) => onHeaderDrop(e, null, 'unsorted')}
					>
						<span class="chevron">{isCollapsed('unsorted') ? '▸' : '▾'}</span>
						<span class="collection-title">Unsorted</span>
					</button>
					{#if !isCollapsed('unsorted')}
						{@render shelf(shelfItems(novelsIn(null)), 'unsorted')}
					{/if}
				</section>
			{/if}
		</div>
	{/if}
</div>

{#snippet shelf(items: any[], collectionKey: string)}
	<div class="shelf">
		<div class="shelf-row">
			{#each items as item (item.type === 'stack' ? 'stack:' + item.label : 'card:' + item.novel.id)}
				{#if item.type === 'card'}
					{@render card(item.novel, collectionKey)}
				{:else}
					{@const key = stackKey(collectionKey, item.label)}
					{#if expandedStacks.has(key)}
						<div class="stack expanded">
							<button type="button" class="stack-chip" onclick={() => toggleStackExpand(key)}>
								{item.label} — {item.novels.length} versions ▾
							</button>
							<div class="stack-members">
								{#each item.novels as member (member.id)}
									{@render card(member, collectionKey)}
								{/each}
							</div>
						</div>
					{:else}
						<div class="stack collapsed">
							<button
								type="button"
								class="stack-cluster"
								onclick={() => toggleStackExpand(key)}
								title="{item.label} — {item.novels.length} versions"
							>
								<span class="stack-edge stack-edge-3" aria-hidden="true"></span>
								<span class="stack-edge stack-edge-2" aria-hidden="true"></span>
								{@render cardFace(item.front)}
							</button>
							<span class="stack-chip">{item.label} — {item.novels.length} versions</span>
						</div>
					{/if}
				{/if}
			{/each}
		</div>
		<div class="shelf-baseline" aria-hidden="true"></div>
	</div>
{/snippet}

<!-- The interactive novel card (link + rename + status + Move-to/Stack menu). -->
{#snippet card(novel: any, collectionKey: string)}
	<div class="card-wrap">
		<a
			class="novel-card"
			href="/novels/{novel.id}"
			draggable="true"
			ondragstart={(e) => onCardDragStart(e, novel.id)}
			ondragend={onCardDragEnd}
			onclick={(e) => suppressCardNav(e, novel.id)}
		>
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
					<button class="menu-btn" onclick={(e) => toggleMenu(e, novel.id)} title="Move to shelf or set version stack">⋯</button>
					<button class="rename-btn" onclick={(e) => { e.preventDefault(); renamingNovelId = novel.id; renamingNovelTitle = novel.title; }} title="Rename novel">✎</button>
				{/if}
			</div>
			{#if novel.subtitle}
				<p class="novel-subtitle">{novel.subtitle}</p>
			{/if}
			<div class="novel-meta">
				<button
					type="button"
					class="status-btn"
					onclick={(e) => cycleNovelStatus(e, novel.id, novel.status)}
					title="Click to change status"
				>{novel.status}</button>
				<span class="word-count">{formatWordCount(novel.total_word_count || 0)}</span>
				{#if selectedShelf === 'all' && novel.owner_username}
					<span class="owner">{novel.owner_username}</span>
				{/if}
			</div>
		</a>

		{#if openMenuNovelId === novel.id}
			<div class="card-menu" role="menu">
				<div class="card-menu-section">
					<p class="card-menu-label">Move to…</p>
					<button class="card-menu-item" onclick={() => assignCollection(novel.id, null)}>Unsorted</button>
					{#each topLevels as top (top.id)}
						<button class="card-menu-item" onclick={() => assignCollection(novel.id, top.id)}>{top.title}</button>
						{#each childrenOf(top.id) as era (era.id)}
							<button class="card-menu-item indented" onclick={() => assignCollection(novel.id, era.id)}>{era.title}</button>
						{/each}
					{/each}
				</div>
				<div class="card-menu-section">
					<p class="card-menu-label">Stack…</p>
					{#each stackLabelsIn(novel.collection_id ?? null) as label (label)}
						<button class="card-menu-item stack-choice" onclick={() => setStackLabel(novel.id, label)}>{label}</button>
					{/each}
					<input
						class="stack-input"
						placeholder="New version-stack label"
						bind:value={stackInput}
						onclick={(e) => e.stopPropagation()}
						onkeydown={(e) => { if (e.key === 'Enter') setStackLabel(novel.id, stackInput); }}
					/>
					<div class="card-menu-actions">
						<button class="btn-link" onclick={() => setStackLabel(novel.id, stackInput)}>Set</button>
						{#if novel.stack_label}
							<button class="btn-link" onclick={() => setStackLabel(novel.id, null)}>Clear stack</button>
						{/if}
					</div>
				</div>
			</div>
		{/if}
	</div>
{/snippet}

<!-- The static face of a card used behind a collapsed stack (no controls). -->
{#snippet cardFace(novel: any)}
	<div class="novel-card stack-face">
		<div class="novel-card-header"><h2>{novel.title}</h2></div>
		{#if novel.subtitle}<p class="novel-subtitle">{novel.subtitle}</p>{/if}
		<div class="novel-meta">
			<span class="status-face">{novel.status}</span>
			<span class="word-count">{formatWordCount(novel.total_word_count || 0)}</span>
			{#if selectedShelf === 'all' && novel.owner_username}
				<span class="owner">{novel.owner_username}</span>
			{/if}
		</div>
	</div>
{/snippet}

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
				{#if isArchivist}
					<label class="owner-field">
						<span>Owner</span>
						<select bind:value={importOwnerId}>
							{#each usersList as u}
								<option value={u.id}>{u.id === currentUser?.id ? `${u.username} (you)` : u.username}</option>
							{/each}
						</select>
					</label>
				{/if}
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

				<hr class="import-section-divider" />

				<!-- Bundle import (W5b Unit D) — sibling flow, shares the owner
				     picker above. Dry-run first; confirm only appears once a dry
				     run report is in hand. -->
				<div class="bundle-section">
					<h3>Import Bundle</h3>
					<p>
						Import a prepared archive bundle — a folder containing
						<code>bundle.json</code> created by an archive-preparation tool.
						Runs a preview first; nothing is imported until you confirm.
					</p>

					{#if bundleError}
						<div class="import-report error">
							<p class="report-error">{bundleError}</p>
						</div>
					{/if}

					<input
						type="text"
						bind:value={bundlePath}
						placeholder="~/Writing/bundle-export"
						disabled={isBundleBusy}
						onkeydown={(e) => e.key === 'Enter' && bundleMode === 'idle' && bundleDryRun()}
					/>

					{#if bundleMode === 'idle'}
						<div class="modal-actions">
							<button class="btn btn-secondary" onclick={bundleDryRun} disabled={!bundlePath.trim()}>
								Dry Run
							</button>
						</div>

					{:else if bundleMode === 'dry_running'}
						<p>Running dry run...</p>

					{:else if bundleMode === 'dry_run_done' && bundleReports}
						<p>Dry run: {bundleReports.length} work{bundleReports.length !== 1 ? 's' : ''} found.</p>
						<div class="batch-results">
							{#each bundleReports as report}
								<div class="batch-result-item" class:failed={report.errors.length > 0}>
									<div class="batch-result-header">
										<span class="project-name">{report.novel_title || report.work_key}</span>
										{#if report.errors.length > 0}
											<span class="badge-error">Failed</span>
										{:else if report.skipped}
											<span class="duplicate-badge">Already imported</span>
										{:else}
											<span class="badge-success">{report.docs_imported} docs</span>
										{/if}
									</div>
									{#if report.errors.length > 0}
										<p class="report-error batch-error-detail">{report.errors.join(', ')}</p>
									{:else}
										<ul>
											<li>{report.docs_imported} document{report.docs_imported !== 1 ? 's' : ''}</li>
											<li>{report.folders_created} folder{report.folders_created !== 1 ? 's' : ''}</li>
											{#if report.variants_imported > 0}
												<li>{report.variants_imported} variant{report.variants_imported !== 1 ? 's' : ''}</li>
											{/if}
											{#if report.total_word_count > 0}
												<li>{formatWordCount(report.total_word_count)}</li>
											{/if}
										</ul>
									{/if}
									{#if report.warnings?.length > 0}
										<details>
											<summary class="batch-warnings-summary">{report.warnings.length} warning{report.warnings.length !== 1 ? 's' : ''}</summary>
											<ul>
												{#each report.warnings as warning}
													<li>{warning}</li>
												{/each}
											</ul>
										</details>
									{/if}
								</div>
							{/each}
						</div>
						<div class="modal-actions">
							<button class="btn btn-secondary" onclick={bundleBack}>Back</button>
							<button class="btn btn-primary" onclick={bundleImport}>
								Import {bundleReports.length} work{bundleReports.length !== 1 ? 's' : ''}
							</button>
						</div>

					{:else if bundleMode === 'importing'}
						<p>Importing {bundleReports?.length ?? ''} work{(bundleReports?.length ?? 0) !== 1 ? 's' : ''}...</p>

					{:else if bundleMode === 'done' && bundleReports}
						<p>Bundle import complete.</p>
						<div class="batch-results">
							{#each bundleReports as report}
								<div class="batch-result-item" class:failed={report.errors.length > 0}>
									<div class="batch-result-header">
										<span class="project-name">{report.novel_title || report.work_key}</span>
										{#if report.errors.length > 0}
											<span class="badge-error">Failed</span>
										{:else if report.skipped}
											<span class="duplicate-badge">Already imported</span>
										{:else}
											<span class="badge-success">{report.docs_imported} docs</span>
										{/if}
									</div>
									{#if report.errors.length > 0}
										<p class="report-error batch-error-detail">{report.errors.join(', ')}</p>
									{:else}
										<ul>
											<li>{report.docs_imported} document{report.docs_imported !== 1 ? 's' : ''}</li>
											<li>{report.folders_created} folder{report.folders_created !== 1 ? 's' : ''}</li>
											{#if report.variants_imported > 0}
												<li>{report.variants_imported} variant{report.variants_imported !== 1 ? 's' : ''}</li>
											{/if}
											{#if report.total_word_count > 0}
												<li>{formatWordCount(report.total_word_count)}</li>
											{/if}
										</ul>
										{#if report.novel_id}
											<div class="batch-result-actions">
												<button class="btn btn-primary btn-sm" onclick={() => goto(`/novels/${report.novel_id}`)}>
													Open
												</button>
											</div>
										{/if}
									{/if}
									{#if report.warnings?.length > 0}
										<details>
											<summary class="batch-warnings-summary">{report.warnings.length} warning{report.warnings.length !== 1 ? 's' : ''}</summary>
											<ul>
												{#each report.warnings as warning}
													<li>{warning}</li>
												{/each}
											</ul>
										</details>
									{/if}
								</div>
							{/each}
						</div>
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
			{#if isArchivist}
				<label class="owner-field">
					<span>Owner</span>
					<select bind:value={newNovelOwnerId}>
						{#each usersList as u}
							<option value={u.id}>{u.id === currentUser?.id ? `${u.username} (you)` : u.username}</option>
						{/each}
					</select>
				</label>
			{/if}
			<div class="modal-actions">
				<button class="btn btn-secondary" onclick={() => showNewNovelModal = false}>Cancel</button>
				<button class="btn btn-primary" onclick={createNovel} disabled={!newNovelTitle.trim()}>Create</button>
			</div>
		</div>
	</div>
{/if}

<!-- Manage Shelves Modal -->
{#if showManageModal}
	<div class="modal-backdrop" onclick={() => showManageModal = false} role="presentation">
		<div class="modal manage-modal" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && (showManageModal = false)} role="dialog" aria-modal="true" tabindex="-1">
			<h2>Edit Shelves</h2>

			<div class="manage-create">
				<input
					type="text"
					bind:value={newCollTitle}
					placeholder="New shelf title"
					onkeydown={(e) => e.key === 'Enter' && createCollection()}
				/>
				<select bind:value={newCollParent} aria-label="Parent shelf">
					<option value="">Top-level (universe)</option>
					{#each topLevels as top (top.id)}
						<option value={top.id}>Under: {top.title}</option>
					{/each}
				</select>
				<button class="btn btn-primary" onclick={createCollection} disabled={!newCollTitle.trim()}>Add</button>
			</div>

			{#if topLevels.length === 0}
				<p class="manage-empty">No shelves yet. Create a universe above, then add eras beneath it.</p>
			{:else}
				<div class="manage-list">
					{#each topLevels as top, ti (top.id)}
						<div class="manage-row universe-row">
							{#if renamingCollId === top.id}
								<!-- svelte-ignore a11y_autofocus -->
								<input
									class="manage-rename-input"
									bind:value={renamingCollTitle}
									onblur={() => renameCollection(top.id)}
									onkeydown={(e) => { if (e.key === 'Enter') renameCollection(top.id); if (e.key === 'Escape') renamingCollId = null; }}
									autofocus
								/>
							{:else}
								<span class="manage-title">{top.title}</span>
							{/if}
							<div class="manage-row-actions">
								<button class="icon-btn" title="Move up" disabled={ti === 0} onclick={() => moveCollection(top, -1)}>↑</button>
								<button class="icon-btn" title="Move down" disabled={ti === topLevels.length - 1} onclick={() => moveCollection(top, 1)}>↓</button>
								<button class="icon-btn" title="Rename" onclick={() => { renamingCollId = top.id; renamingCollTitle = top.title; }}>✎</button>
								<button class="icon-btn danger" title="Delete" onclick={() => deleteConfirmColl = top}>✕</button>
							</div>
						</div>
						{#each childrenOf(top.id) as era, ei (era.id)}
							<div class="manage-row era-row">
								{#if renamingCollId === era.id}
									<!-- svelte-ignore a11y_autofocus -->
									<input
										class="manage-rename-input"
										bind:value={renamingCollTitle}
										onblur={() => renameCollection(era.id)}
										onkeydown={(e) => { if (e.key === 'Enter') renameCollection(era.id); if (e.key === 'Escape') renamingCollId = null; }}
										autofocus
									/>
								{:else}
									<span class="manage-title">{era.title}</span>
								{/if}
								<div class="manage-row-actions">
									<button class="icon-btn" title="Move up" disabled={ei === 0} onclick={() => moveCollection(era, -1)}>↑</button>
									<button class="icon-btn" title="Move down" disabled={ei === childrenOf(top.id).length - 1} onclick={() => moveCollection(era, 1)}>↓</button>
									<button class="icon-btn" title="Rename" onclick={() => { renamingCollId = era.id; renamingCollTitle = era.title; }}>✎</button>
									<button class="icon-btn danger" title="Delete" onclick={() => deleteConfirmColl = era}>✕</button>
								</div>
							</div>
						{/each}
					{/each}
				</div>
			{/if}

			{#if deleteConfirmColl}
				<div class="delete-confirm">
					<p>
						Delete <strong>{deleteConfirmColl.title}</strong>?
						{deleteMemberCount(deleteConfirmColl.id)} novel{deleteMemberCount(deleteConfirmColl.id) !== 1 ? 's' : ''} will fall to Unsorted;
						{deleteChildCount(deleteConfirmColl.id)} era{deleteChildCount(deleteConfirmColl.id) !== 1 ? 's' : ''} will promote to top-level.
					</p>
					<div class="modal-actions">
						<button class="btn btn-secondary" onclick={() => deleteConfirmColl = null}>Cancel</button>
						<button class="btn btn-primary" onclick={confirmDeleteCollection}>Delete shelf</button>
					</div>
				</div>
			{/if}

			<div class="modal-actions manage-footer">
				<button class="btn btn-secondary" onclick={() => showManageModal = false}>Done</button>
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

	.novel-card {
		/* The card is an <a>; inside .card-wrap it is no longer a grid item
		   (which used to blockify it), so it must be block explicitly or the
		   inline box fragments around its block children. */
		display: block;
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

	.novel-card:hover .menu-btn {
		opacity: 1;
	}

	.rename-btn:hover {
		color: var(--accent);
	}

	.menu-btn {
		background: none;
		border: none;
		cursor: pointer;
		font-size: 0.95rem;
		line-height: 1;
		color: var(--text-muted);
		padding: 0.1rem 0.3rem;
		opacity: 0;
		transition: opacity 0.15s;
	}

	.menu-btn:hover {
		color: var(--accent);
	}

	/* Touch devices have no hover — reveal the rename pencil and the Move-to/Stack
	   menu permanently (same pattern as the binder row actions in the workspace). */
	@media (pointer: coarse) {
		.rename-btn {
			opacity: 1;
		}
		.menu-btn {
			opacity: 1;
		}
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

	.status-btn {
		text-transform: capitalize;
		padding: 0.1rem 0.5rem;
		background: var(--bg-elevated);
		border-radius: 3px;
		border: none;
		font: inherit;
		font-size: 0.8rem;
		color: var(--text-muted);
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
	}

	.status-btn:hover {
		background: var(--accent-bg);
		color: var(--accent);
	}

	.owner {
		margin-left: auto;
		color: var(--text-muted);
		font-style: italic;
	}

	/* Bookshelf toggle — thumb-friendly segmented control */
	.shelf-toggle {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		padding-bottom: 0.25rem;
	}

	.shelf-chip {
		flex: 0 0 auto;
		min-height: 44px;
		padding: 0.5rem 1.1rem;
		border-radius: 22px;
		border: 1px solid var(--border-input);
		background: var(--bg-surface);
		color: var(--text-secondary);
		font-size: 0.9rem;
		cursor: pointer;
		white-space: nowrap;
		transition: all 0.15s;
	}

	.shelf-chip:hover {
		background: var(--bg-elevated);
	}

	.shelf-chip.active {
		background: var(--accent);
		color: var(--text-on-accent);
		border-color: var(--accent);
	}

	/* Owner picker in create/import modals */
	.owner-field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin-bottom: 1rem;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.owner-field select {
		width: 100%;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--border-input);
		border-radius: 6px;
		font-size: 0.9rem;
		background: var(--bg-surface);
		color: var(--text);
	}

	.owner-field select:focus {
		outline: none;
		border-color: var(--accent);
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

	/* Bundle import (W5b Unit D) — sits below the .scriv flow in the same modal */
	.import-section-divider {
		border: none;
		border-top: 1px solid var(--border);
		margin: 1.25rem 0;
	}

	.bundle-section h3 {
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-heading);
		margin-bottom: 0.5rem;
	}

	/* ─── Bookshelf: sections, headers, shelves ──────────────────────── */
	.bookshelf {
		display: flex;
		flex-direction: column;
		gap: 1.75rem;
	}

	.shelf-section {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.collection-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		color: var(--text-heading);
		padding: 0.35rem 0.5rem;
		transition: background 0.15s, box-shadow 0.15s;
	}

	.collection-header:hover {
		background: var(--bg-elevated);
	}

	.universe-header {
		font-size: 1.35rem;
		font-weight: 600;
	}

	.era-header {
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-secondary);
		margin-left: 1.25rem;
	}

	.era-block {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.chevron {
		font-size: 0.8em;
		color: var(--text-muted);
		width: 1em;
		flex: 0 0 auto;
	}

	/* Drop target highlight during a drag (desktop enhancement). */
	.collection-header.drop-target {
		background: var(--accent-bg);
		box-shadow: inset 0 0 0 2px var(--accent);
	}

	/* A shelf: a row of cards sitting on a subtle wooden baseline. */
	.shelf {
		margin-left: 0.5rem;
	}

	.era-block .shelf {
		margin-left: 1.75rem;
	}

	.shelf-row {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 1rem;
		/* Top-align so plain cards and stacks (which carry a chip below)
		   share a clean top edge; the baseline below closes the shelf. */
		align-items: start;
	}

	.shelf-baseline {
		height: 8px;
		margin-top: 0.35rem;
		border-radius: 3px;
		background: linear-gradient(
			to bottom,
			var(--border-active) 0%,
			var(--border-strong) 45%,
			var(--border) 100%
		);
		box-shadow: 0 3px 6px var(--shadow-sm), inset 0 1px 0 var(--bg-surface);
	}

	.card-wrap {
		position: relative;
	}

	/* ─── Version stacks ─────────────────────────────────────────────── */
	.stack {
		position: relative;
	}

	.stack-cluster {
		position: relative;
		display: block;
		width: 100%;
		padding: 0;
		border: none;
		background: none;
		cursor: pointer;
		text-align: left;
		/* A <button> imposes its own UA font and color; without these the
		   card face inside renders dimmer and smaller than sibling cards. */
		font: inherit;
		color: inherit;
	}

	/* Offset card edges peeking out behind the front card. */
	.stack-edge {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-elevated);
		box-shadow: 0 1px 4px var(--shadow-sm);
	}

	.stack-edge-2 {
		transform: translate(6px, 6px);
		z-index: 0;
	}

	.stack-edge-3 {
		transform: translate(12px, 12px);
		z-index: 0;
		opacity: 0.8;
	}

	.stack-cluster .novel-card {
		position: relative;
		z-index: 1;
	}

	.stack-face {
		pointer-events: none;
	}

	.status-face {
		text-transform: capitalize;
		padding: 0.1rem 0.5rem;
		background: var(--bg-elevated);
		border-radius: 3px;
		font-size: 0.8rem;
		color: var(--text-muted);
	}

	.stack-chip {
		display: inline-block;
		margin-top: 0.6rem;
		font-size: 0.78rem;
		color: var(--text-secondary);
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 0.2rem 0.7rem;
		cursor: pointer;
	}

	.stack.expanded {
		grid-column: 1 / -1;
	}

	.stack-members {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 1rem;
		margin-top: 0.5rem;
		padding: 0.75rem;
		border: 1px dashed var(--border-strong);
		border-radius: 8px;
		background: var(--tree-hover);
	}

	/* ─── Per-card Move-to / Stack menu ──────────────────────────────── */
	.card-menu {
		position: absolute;
		top: 2.5rem;
		right: 0;
		z-index: 20;
		width: 15rem;
		max-height: 22rem;
		overflow-y: auto;
		background: var(--bg-surface);
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		box-shadow: 0 8px 24px var(--shadow-lg);
		padding: 0.5rem;
	}

	.card-menu-section + .card-menu-section {
		border-top: 1px solid var(--border);
		margin-top: 0.4rem;
		padding-top: 0.4rem;
	}

	.card-menu-label {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
		margin: 0.15rem 0.25rem 0.35rem;
	}

	.card-menu-item {
		display: block;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		border-radius: 5px;
		padding: 0.4rem 0.5rem;
		font-size: 0.85rem;
		color: var(--text);
		cursor: pointer;
	}

	.card-menu-item:hover {
		background: var(--accent-bg);
		color: var(--accent);
	}

	.card-menu-item.indented {
		padding-left: 1.25rem;
		color: var(--text-secondary);
	}

	.card-menu-item.stack-choice {
		color: var(--text-secondary);
		font-style: italic;
	}

	.stack-input {
		width: 100%;
		padding: 0.4rem 0.5rem;
		margin: 0.25rem 0;
		border: 1px solid var(--border-input);
		border-radius: 5px;
		font-size: 0.85rem;
		background: var(--bg-surface);
		color: var(--text);
	}

	.stack-input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.card-menu-actions {
		display: flex;
		gap: 0.75rem;
		padding: 0.25rem;
	}

	/* ─── Manage shelves modal ───────────────────────────────────────── */
	.manage-modal {
		max-width: 560px;
	}

	.manage-create {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 1rem;
		flex-wrap: wrap;
	}

	.manage-create input {
		flex: 1 1 10rem;
		margin-bottom: 0;
	}

	.manage-create select {
		flex: 1 1 8rem;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--border-input);
		border-radius: 6px;
		font-size: 0.9rem;
		background: var(--bg-surface);
		color: var(--text);
	}

	.manage-empty {
		color: var(--text-secondary);
		font-style: italic;
	}

	.manage-list {
		max-height: 340px;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: 6px;
	}

	.manage-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--border);
	}

	.manage-row:last-child {
		border-bottom: none;
	}

	.universe-row .manage-title {
		font-weight: 600;
		color: var(--text-heading);
	}

	.era-row {
		padding-left: 1.75rem;
		background: var(--bg-elevated);
	}

	.era-row .manage-title {
		color: var(--text-secondary);
	}

	.manage-rename-input {
		flex: 1;
		padding: 0.3rem 0.5rem;
		border: 1px solid var(--accent);
		border-radius: 4px;
		background: var(--bg-surface);
		color: var(--text);
		font-size: 0.9rem;
	}

	.manage-rename-input:focus {
		outline: none;
	}

	.manage-row-actions {
		display: flex;
		gap: 0.2rem;
		flex: 0 0 auto;
	}

	.icon-btn {
		background: none;
		border: none;
		cursor: pointer;
		font-size: 0.85rem;
		color: var(--text-muted);
		padding: 0.2rem 0.4rem;
		border-radius: 4px;
	}

	.icon-btn:hover:not(:disabled) {
		background: var(--bg-active);
		color: var(--accent);
	}

	.icon-btn:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}

	.icon-btn.danger:hover:not(:disabled) {
		color: var(--error-text);
	}

	.delete-confirm {
		margin-top: 1rem;
		padding: 1rem;
		border: 1px solid var(--error-text);
		border-radius: 6px;
		background: var(--error-bg);
	}

	.delete-confirm p {
		color: var(--text);
	}

	.manage-footer {
		margin-top: 1rem;
	}

	@media (max-width: 600px) {
		.library {
			padding: 1rem;
		}

		.shelf-row,
		.stack-members {
			grid-template-columns: 1fr;
		}
	}
</style>

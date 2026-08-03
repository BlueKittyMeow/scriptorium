<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Editor, Extension } from '@tiptap/core';
	import StarterKit from '@tiptap/starter-kit';
	import Placeholder from '@tiptap/extension-placeholder';
	import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
	import { Decoration, DecorationSet } from '@tiptap/pm/view';
	import type { Node as PMNode } from '@tiptap/pm/model';
	import { findOffsets } from '$lib/find-matches';

	let {
		docId,
		initialContent = '',
		title = '',
		onsave,
		searchTerm = null,
		onSearchHighlightDone,
		onSnapshotsToggle,
		onManualSnapshot,
		registerFlush,
		contentVersion = 0,
		onrename
	}: {
		docId: string;
		initialContent: string;
		title: string;
		onsave: (content: string, docId: string) => Promise<void>;
		searchTerm?: string | null;
		onSearchHighlightDone?: () => void;
		onSnapshotsToggle?: () => void;
		onManualSnapshot?: () => Promise<void>;
		registerFlush?: (flush: () => Promise<void>) => void;
		contentVersion?: number;
		onrename?: (title: string) => void;
	} = $props();

	// Doc-title rename state (pencil button next to the header title)
	let editingTitle = $state(false);
	let titleDraft = $state('');
	let titleInputEl = $state<HTMLInputElement | undefined>(undefined);

	let element: HTMLDivElement;
	let scrollContainer: HTMLDivElement;
	let editor: Editor | null = $state(null);
	let wordCount = $state(0);
	let selectionWordCount = $state(0);
	let saveStatus: 'saved' | 'saving' | 'unsaved' = $state('saved');
	let saveTimeout: any = null;
	let currentDocId = $state('');
	let spellcheck = $state(
		typeof localStorage !== 'undefined'
			? localStorage.getItem('scriptorium-spellcheck') !== 'false'
			: true
	);
	// Read/Edit mode. A global preference, NOT per document — switching docs
	// leaves it alone. Defaults to 'read': in read mode the editor isn't
	// contenteditable, so tapping to select or copy text on a phone doesn't
	// summon the on-screen keyboard.
	let mode = $state<'read' | 'edit'>(
		typeof localStorage !== 'undefined' &&
			localStorage.getItem('scriptorium-editor-mode') === 'edit'
			? 'edit'
			: 'read'
	);

	// ProseMirror decoration plugin for search highlights
	const highlightKey = new PluginKey('searchHighlight');
	const SearchHighlight = Extension.create({
		name: 'searchHighlight',
		addProseMirrorPlugins() {
			return [
				new Plugin({
					key: highlightKey,
					state: {
						init: () => DecorationSet.empty,
						apply: (tr, decoSet) => {
							const meta = tr.getMeta(highlightKey);
							if (meta !== undefined) return meta;
							return decoSet.map(tr.mapping, tr.doc);
						}
					},
					props: {
						decorations: (state) => highlightKey.getState(state)
					}
				})
			];
		}
	});

	// Find within the open document. A second, independent decoration plugin —
	// the cross-document search above keeps its own key and its own decoration
	// set, so the two never stomp each other.
	const findKey = new PluginKey('findInDocument');
	const FindInDocument = Extension.create({
		name: 'findInDocument',
		addProseMirrorPlugins() {
			return [
				new Plugin({
					key: findKey,
					state: {
						init: () => DecorationSet.empty,
						apply: (tr, decoSet) => {
							const meta = tr.getMeta(findKey);
							if (meta !== undefined) return meta;
							return decoSet.map(tr.mapping, tr.doc);
						}
					},
					props: {
						decorations: (state) => findKey.getState(state)
					}
				})
			];
		}
	});

	let findOpen = $state(false);
	let findTerm = $state('');
	let findMatches = $state<{ from: number; to: number }[]>([]);
	let findIndex = $state(0);
	let findInputEl = $state<HTMLInputElement | undefined>(undefined);
	let findRefreshQueued = false;

	let findStatus = $derived(
		findTerm.trim() === ''
			? ''
			: findMatches.length === 0
				? 'No matches'
				: `${findIndex + 1} of ${findMatches.length}`
	);

	/**
	 * Every match of `term`, walked one text block at a time.
	 *
	 * Each block is flattened to a single string alongside a parallel array of
	 * ProseMirror positions, one per character. That's what makes a match work
	 * across mark boundaries — a word half in italics is still one run of text
	 * here — while a match can never straddle two blocks.
	 */
	function collectMatches(term: string): { from: number; to: number }[] {
		if (!editor) return [];
		const out: { from: number; to: number }[] = [];
		editor.state.doc.descendants((node, pos) => {
			if (!node.isTextblock) return true;
			let text = '';
			const positions: number[] = [];
			node.forEach((child, offset) => {
				const base = pos + 1 + offset;
				if (child.isText && child.text) {
					for (let i = 0; i < child.text.length; i++) {
						text += child.text[i];
						positions.push(base + i);
					}
				} else {
					// Inline leaves (a hard break, say) stand in as a newline so a
					// typed term can't match straight through them.
					text += '\n';
					positions.push(base);
				}
			});
			for (const idx of findOffsets(text, term)) {
				const from = positions[idx];
				const last = positions[idx + term.length - 1];
				if (from === undefined || last === undefined) continue;
				out.push({ from, to: last + 1 });
			}
			return false;
		});
		return out;
	}

	function findDecorations(doc: PMNode): DecorationSet {
		return DecorationSet.create(
			doc,
			findMatches.map((m, i) =>
				Decoration.inline(m.from, m.to, {
					class: i === findIndex ? 'find-match find-match-current' : 'find-match'
				})
			)
		);
	}

	/** Recompute matches and repaint the highlights. A no-op while the bar is closed. */
	function refreshFind(resetIndex = false) {
		if (!findOpen || !editor || editor.isDestroyed) return;
		findMatches = collectMatches(findTerm);
		if (resetIndex || findIndex >= findMatches.length) findIndex = 0;
		editor.view.dispatch(
			editor.state.tr.setMeta(findKey, findDecorations(editor.state.doc))
		);
	}

	/**
	 * Recompute after the document changed under us. Deferred a tick so we're
	 * never dispatching from inside ProseMirror's own dispatch, and skipped
	 * entirely while the bar is closed so typing costs nothing.
	 */
	function queueFindRefresh() {
		if (!findOpen || findRefreshQueued) return;
		findRefreshQueued = true;
		setTimeout(() => {
			findRefreshQueued = false;
			refreshFind();
		}, 0);
	}

	/**
	 * Select and scroll to a match, wrapping at both ends. Never focuses the
	 * editor — same reasoning as copyDocument below: focus would summon the
	 * on-screen keyboard, and the caret belongs in the find input anyway.
	 */
	function gotoMatch(index: number) {
		if (!editor || editor.isDestroyed || findMatches.length === 0) return;
		const count = findMatches.length;
		findIndex = ((index % count) + count) % count;
		const match = findMatches[findIndex];
		const tr = editor.state.tr;
		const size = tr.doc.content.size;
		// The position may be stale if an edit landed between recomputes — clamp,
		// and fall back to a recompute rather than throwing.
		const from = Math.min(match.from, size);
		const to = Math.min(match.to, size);
		try {
			tr.setSelection(TextSelection.create(tr.doc, from, to));
			tr.setMeta(findKey, findDecorations(tr.doc));
		} catch {
			refreshFind(true);
			return;
		}
		tr.scrollIntoView();
		editor.view.dispatch(tr);
	}

	function nextMatch() { gotoMatch(findIndex + 1); }
	function prevMatch() { gotoMatch(findIndex - 1); }

	/** Term changed: recompute from the top and land on the first match. */
	function runFind(term: string) {
		findTerm = term;
		refreshFind(true);
		if (findMatches.length > 0) gotoMatch(0);
	}

	function openFind() {
		findOpen = true;
		// Focus the find INPUT, never the editor. Same autofocus-after-click
		// caveat as the title rename field, hence the timeout.
		setTimeout(() => {
			findInputEl?.focus();
			findInputEl?.select();
		}, 0);
	}

	function closeFind() {
		findOpen = false;
		findTerm = '';
		findMatches = [];
		findIndex = 0;
		if (editor) editor.view.dispatch(editor.state.tr.setMeta(findKey, DecorationSet.empty));
	}

	function handleWindowKeydown(e: KeyboardEvent) {
		// Stay out of the way while the doc-title rename input is open.
		if (editingTitle) return;
		if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
			// Deliberately replaces the browser's native find: ours knows about
			// the editor's own scroll container.
			e.preventDefault();
			openFind();
		} else if (e.key === 'Escape' && findOpen) {
			closeFind();
		}
	}

	function countWords(text: string): number {
		return text.trim().split(/\s+/).filter(Boolean).length;
	}

	function updateWordCount() {
		if (editor) {
			wordCount = countWords(editor.getText());
			updateSelectionWordCount();
		}
	}

	/** Lightweight selection-only count — safe to call on every transaction */
	function updateSelectionWordCount() {
		if (editor) {
			const { from, to } = editor.state.selection;
			if (from !== to) {
				selectionWordCount = countWords(editor.state.doc.textBetween(from, to, ' '));
			} else {
				selectionWordCount = 0;
			}
		}
	}

	async function triggerSave() {
		if (!editor || !onsave) return;
		// Capture the target doc id BEFORE any await — the content in the editor
		// belongs to currentDocId, which may change if the user switches docs mid-save.
		const target = currentDocId;
		saveStatus = 'saving';
		try {
			await onsave(editor.getHTML(), target);
			saveStatus = 'saved';
		} catch {
			saveStatus = 'unsaved';
		}
	}

	function scheduleSave() {
		saveStatus = 'unsaved';
		clearTimeout(saveTimeout);
		saveTimeout = setTimeout(triggerSave, 2000);
	}

	/** Flush any pending save immediately. Returns when save completes. */
	async function flushSave() {
		clearTimeout(saveTimeout);
		if (saveStatus === 'unsaved' && editor) {
			await triggerSave();
		}
	}

	let snapshotFlash = $state(false);

	async function handleManualSnapshot() {
		if (!onManualSnapshot) return;
		await flushSave();
		await onManualSnapshot();
		snapshotFlash = true;
		setTimeout(() => { snapshotFlash = false; }, 2000);
	}

	onMount(() => {
		editor = new Editor({
			element,
			extensions: [
				StarterKit.configure({
					heading: { levels: [1, 2, 3] }
				}),
				Placeholder.configure({
					placeholder: 'Begin writing...'
				}),
				SearchHighlight,
				FindInDocument
			],
			content: initialContent,
			// Construct with the mode already applied so a read-mode document is
			// never editable for even a frame.
			editable: mode === 'edit',
			editorProps: {
				attributes: {
					spellcheck: String(spellcheck)
				}
			},
			onUpdate: () => {
				updateWordCount();
				scheduleSave();
			},
			onTransaction: ({ transaction }) => {
				editor = editor;
				updateSelectionWordCount();
				// Editing with the find bar open must not leave stale highlights.
				// Only on a real content change — a decoration-only transaction
				// would otherwise queue itself forever.
				if (transaction.docChanged) queueFindRefresh();
			}
		});
		// Belt and braces alongside the `editable` constructor option: setMode is
		// the only other path that touches editability, and it runs after mount.
		// emitUpdate MUST stay false — see setMode.
		editor.setEditable(mode === 'edit', false);
		updateWordCount();
		registerFlush?.(flushSave);
	});

	onDestroy(() => {
		clearTimeout(saveTimeout);
		clearTimeout(copyTimeout);
		clearTimeout(titleCopyTimeout);
		if (editor && saveStatus !== 'saved' && currentDocId) {
			// Use keepalive to ensure the save completes even during page unload
			fetch(`/api/documents/${currentDocId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: editor.getHTML() }),
				keepalive: true
			});
		}
		editor?.destroy();
	});

	// Handle doc changes — save old content before switching
	$effect(() => {
		const newDocId = docId;
		if (newDocId !== currentDocId && editor) {
			switchDocument(newDocId);
		} else if (!currentDocId) {
			currentDocId = newDocId;
		}
	});

	async function switchDocument(newDocId: string) {
		// Always cancel any pending debounced save so it can't fire against the new doc.
		clearTimeout(saveTimeout);
		if (currentDocId && saveStatus === 'unsaved' && editor) {
			// Capture the outgoing doc id BEFORE the await — the editor still holds its content.
			const target = currentDocId;
			try {
				await onsave(editor.getHTML(), target);
			} catch { /* best effort */ }
		}
		if (!editor) return;
		editor.commands.setContent(initialContent);
		currentDocId = newDocId;
		saveStatus = 'saved';
		updateWordCount();
	}

	// Handle content reload (e.g. after restore) — triggered by contentVersion bump
	let trackedVersion = 0;
	$effect(() => {
		const v = contentVersion;
		if (v > trackedVersion && editor) {
			trackedVersion = v;
			clearTimeout(saveTimeout);
			editor.commands.setContent(initialContent);
			saveStatus = 'saved';
			updateWordCount();
		}
	});

	// Handle search term → scroll to match + highlight
	$effect(() => {
		const term = searchTerm;
		if (term && editor && element) {
			// Wait a tick for content to render
			setTimeout(() => scrollToMatch(term), 100);
		}
	});

	function startTitleRename() {
		titleDraft = title;
		editingTitle = true;
	}

	function commitTitleRename() {
		const trimmed = titleDraft.trim();
		editingTitle = false;
		if (!trimmed || trimmed === title) return;
		// Don't set the displayed title from local state — `title` is a prop
		// and will update once the parent's rename request completes.
		onrename?.(trimmed);
	}

	// Autofocus the title-rename input — same reasoning as the workspace
	// page's rename/search/new-item autofocus effects: the field is opened
	// via a button click, and plain `autofocus` doesn't reliably grab focus
	// in that case.
	$effect(() => {
		if (editingTitle && titleInputEl) {
			setTimeout(() => titleInputEl?.focus(), 0);
		}
	});

	function scrollToMatch(term: string) {
		if (!editor) {
			onSearchHighlightDone?.();
			return;
		}

		const { doc } = editor.state;
		const lowerTerm = term.toLowerCase();
		let matchFrom = -1;
		let matchTo = -1;

		// Search through ProseMirror document text nodes
		doc.descendants((node, pos) => {
			if (matchFrom >= 0) return false;
			if (node.isText && node.text) {
				const idx = node.text.toLowerCase().indexOf(lowerTerm);
				if (idx >= 0) {
					matchFrom = pos + idx;
					matchTo = matchFrom + term.length;
					return false;
				}
			}
		});

		if (matchFrom >= 0) {
			// Add highlight decoration via ProseMirror plugin
			const deco = Decoration.inline(matchFrom, matchTo, { class: 'search-highlight' });
			const decoSet = DecorationSet.create(doc, [deco]);
			editor.view.dispatch(
				editor.state.tr.setMeta(highlightKey, decoSet)
			);

			// Scroll to the match
			editor.chain()
				.setTextSelection(matchFrom)
				.scrollIntoView()
				.run();

			// Remove decoration after animation completes (6s animation + buffer)
			setTimeout(() => {
				if (editor) {
					editor.view.dispatch(
						editor.state.tr.setMeta(highlightKey, DecorationSet.empty)
					);
				}
			}, 7000);
		}

		onSearchHighlightDone?.();
	}

	/** Switch between read and edit mode, persisting the choice. */
	async function setMode(next: 'read' | 'edit') {
		if (next === mode) return;
		// Leaving edit mode: flush whatever the debounce hasn't written yet, so
		// no keystrokes are lost on the way out.
		if (mode === 'edit') await flushSave();
		mode = next;
		try { localStorage.setItem('scriptorium-editor-mode', mode); } catch { /* quota exceeded */ }
		// emitUpdate=false: TipTap's setEditable emits an update by default, which
		// our onUpdate reads as "the writer typed something" and schedules a save.
		// Merely looking at a document would then rewrite it and bump updated_at.
		editor?.setEditable(mode === 'edit', false);
	}

	let copyFlash: 'idle' | 'copied' | 'failed' = $state('idle');
	let copyTimeout: any = null;

	/**
	 * Copy the whole document to the clipboard in two flavours, so a paste into
	 * a word processor keeps italics and headings. Deliberately never focuses
	 * the editor — that would pop the on-screen keyboard on a phone.
	 */
	async function copyDocument() {
		if (!editor) return;
		const html = editor.getHTML();
		const plain = editor.getText({ blockSeparator: '\n\n' });
		let copied = false;
		try {
			if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
				await navigator.clipboard.write([
					new ClipboardItem({
						'text/html': new Blob([html], { type: 'text/html' }),
						'text/plain': new Blob([plain], { type: 'text/plain' })
					})
				]);
			} else {
				// Older/locked-down browsers: plain text is better than nothing.
				await navigator.clipboard.writeText(plain);
			}
			copied = true;
		} catch { /* clipboard blocked or unavailable */ }
		copyFlash = copied ? 'copied' : 'failed';
		clearTimeout(copyTimeout);
		copyTimeout = setTimeout(() => { copyFlash = 'idle'; }, 2000);
	}

	let titleCopyFlash: 'idle' | 'copied' | 'failed' = $state('idle');
	let titleCopyTimeout: any = null;

	/**
	 * Copy just the document title. The header opts out of text selection so a
	 * selection dragged out of the prose can't swallow it, which also means the
	 * title can no longer be swiped by hand — this button is how you get it.
	 * Plain text only: a title has no formatting to preserve.
	 */
	async function copyTitle() {
		let copied = false;
		try {
			await navigator.clipboard.writeText(title);
			copied = true;
		} catch { /* clipboard blocked or unavailable */ }
		titleCopyFlash = copied ? 'copied' : 'failed';
		clearTimeout(titleCopyTimeout);
		titleCopyTimeout = setTimeout(() => { titleCopyFlash = 'idle'; }, 2000);
	}

	function toggleSpellcheck() {
		spellcheck = !spellcheck;
		try { localStorage.setItem('scriptorium-spellcheck', String(spellcheck)); } catch { /* quota exceeded */ }
		if (editor) {
			editor.setOptions({
				editorProps: {
					attributes: {
						spellcheck: String(spellcheck)
					}
				}
			});
			// Force the browser to re-evaluate spellcheck on the contenteditable
			const el = element.querySelector('.tiptap') as HTMLElement;
			if (el) {
				el.setAttribute('spellcheck', String(spellcheck));
				// Briefly toggle contenteditable to force browser re-check
				el.blur();
				setTimeout(() => el.focus(), 0);
			}
		}
	}

	// Toolbar commands
	function toggleBold() { editor?.chain().focus().toggleBold().run(); }
	function toggleItalic() { editor?.chain().focus().toggleItalic().run(); }
	function toggleHeading(level: 1 | 2 | 3) { editor?.chain().focus().toggleHeading({ level }).run(); }
	function toggleBulletList() { editor?.chain().focus().toggleBulletList().run(); }
	function toggleOrderedList() { editor?.chain().focus().toggleOrderedList().run(); }
	function toggleBlockquote() { editor?.chain().focus().toggleBlockquote().run(); }
	function undo() { editor?.chain().focus().undo().run(); }
	function redo() { editor?.chain().focus().redo().run(); }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="editor-container">
	<div class="editor-header">
		<div class="title-row">
			{#if editingTitle}
				<!-- svelte-ignore a11y_autofocus -->
				<input
					class="doc-title-input"
					bind:this={titleInputEl}
					bind:value={titleDraft}
					onblur={commitTitleRename}
					onkeydown={(e) => {
						if (e.key === 'Enter') { e.preventDefault(); commitTitleRename(); }
						if (e.key === 'Escape') { editingTitle = false; }
					}}
					autofocus
				/>
			{:else}
				<!-- title attribute so a long name truncated by the ellipsis is still
				     readable on hover -->
				<h1 class="doc-title" title={title}>{title}</h1>
				{#if onrename}
					<button class="rename-btn" onclick={startTitleRename} title="Rename document" aria-label="Rename document">✎</button>
				{/if}
				<button
					class="title-copy-btn"
					class:flashing={titleCopyFlash !== 'idle'}
					onclick={copyTitle}
					title={titleCopyFlash === 'failed' ? 'Copy failed' : 'Copy the document title'}
					aria-label="Copy the document title"
				>{titleCopyFlash === 'copied' ? '✓' : titleCopyFlash === 'failed' ? '✕' : '⧉'}</button>
			{/if}
		</div>
		<div class="editor-toolbar">
			<div class="mode-toggle">
				<button class="tb-btn" class:active={mode === 'read'} aria-pressed={mode === 'read'} onclick={() => setMode('read')} title="Read mode — select and copy without the keyboard">Read</button>
				<button class="tb-btn" class:active={mode === 'edit'} aria-pressed={mode === 'edit'} onclick={() => setMode('edit')} title="Edit mode — write and format">Edit</button>
			</div>
			<span class="tb-sep"></span>
			{#if mode === 'edit'}
				<button class="tb-btn" class:active={editor?.isActive('bold')} onclick={toggleBold} title="Bold (Ctrl+B)"><strong>B</strong></button>
				<button class="tb-btn" class:active={editor?.isActive('italic')} onclick={toggleItalic} title="Italic (Ctrl+I)"><em>I</em></button>
				<span class="tb-sep"></span>
				<button class="tb-btn" class:active={editor?.isActive('heading', { level: 1 })} onclick={() => toggleHeading(1)} title="Heading 1">H1</button>
				<button class="tb-btn" class:active={editor?.isActive('heading', { level: 2 })} onclick={() => toggleHeading(2)} title="Heading 2">H2</button>
				<button class="tb-btn" class:active={editor?.isActive('heading', { level: 3 })} onclick={() => toggleHeading(3)} title="Heading 3">H3</button>
				<span class="tb-sep"></span>
				<button class="tb-btn" class:active={editor?.isActive('bulletList')} onclick={toggleBulletList} title="Bullet list">•</button>
				<button class="tb-btn" class:active={editor?.isActive('orderedList')} onclick={toggleOrderedList} title="Numbered list">1.</button>
				<button class="tb-btn" class:active={editor?.isActive('blockquote')} onclick={toggleBlockquote} title="Block quote">"</button>
				<span class="tb-sep"></span>
				<button class="tb-btn" onclick={undo} title="Undo (Ctrl+Z)">↩</button>
				<button class="tb-btn" onclick={redo} title="Redo (Ctrl+Shift+Z)">↪</button>
				<span class="tb-sep"></span>
				<button class="tb-btn" class:active={spellcheck} onclick={toggleSpellcheck} title="Toggle spellcheck">ABC</button>
				<span class="tb-sep"></span>
			{/if}
			<button class="tb-btn" onclick={copyDocument} title="Copy the whole document">
				{copyFlash === 'copied' ? 'Copied' : copyFlash === 'failed' ? 'Copy failed' : 'Copy'}
			</button>
			<button class="tb-btn" class:active={findOpen} onclick={() => findOpen ? closeFind() : openFind()} title="Find in this document (Ctrl+F)" aria-label="Find in this document">Find</button>
		</div>
		{#if findOpen}
			<div class="find-bar">
				<input
					class="find-input"
					bind:this={findInputEl}
					value={findTerm}
					placeholder="Find in document"
					aria-label="Find in document"
					oninput={(e) => runFind(e.currentTarget.value)}
					onkeydown={(e) => {
						if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) prevMatch(); else nextMatch(); }
						if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
					}}
				/>
				<span class="find-count">{findStatus}</span>
				<button class="tb-btn" onclick={prevMatch} disabled={findMatches.length === 0} title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button>
				<button class="tb-btn" onclick={nextMatch} disabled={findMatches.length === 0} title="Next match (Enter)" aria-label="Next match">↓</button>
				<button class="tb-btn" onclick={closeFind} title="Close find (Escape)" aria-label="Close find">✕</button>
			</div>
		{/if}
	</div>

	<div class="editor-scroll" bind:this={scrollContainer}>
		<div class="editor-content" bind:this={element}></div>
	</div>

	<div class="editor-footer">
		<span class="word-count">{#if selectionWordCount > 0}{selectionWordCount.toLocaleString()} / {/if}{wordCount.toLocaleString()} words</span>
		<span class="footer-right">
			{#if onManualSnapshot}
				<button class="footer-btn" onclick={handleManualSnapshot} disabled={saveStatus === 'saving'} title="Create manual snapshot">
					{snapshotFlash ? 'Snapshot saved' : 'Snapshot'}
				</button>
			{/if}
			{#if onSnapshotsToggle}
				<button class="footer-btn" onclick={onSnapshotsToggle} title="Toggle snapshot timeline">
					Snapshots
				</button>
			{/if}
			{#if mode === 'edit'}
				<span class="spellcheck-indicator">{spellcheck ? 'Spellcheck on' : 'Spellcheck off'}</span>
			{/if}
			<span class="save-status" class:saved={saveStatus === 'saved'} class:saving={saveStatus === 'saving'} class:unsaved={saveStatus === 'unsaved'}>
				{#if saveStatus === 'saved'}Saved{:else if saveStatus === 'saving'}Saving...{:else}Unsaved changes{/if}
			</span>
		</span>
	</div>
</div>

<style>
	.editor-container {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	/* Chrome, not prose. Selecting inside the document and then dragging (or
	   scrolling, on a phone, where the selection extends as the page moves)
	   past the top of the text used to swallow the document title and the
	   toolbar labels into the selection. Nothing here is ever worth copying,
	   so it opts out entirely — the .editor-content rule below keeps the prose
	   itself selectable, and the inputs re-enable selection for themselves. */
	.editor-header {
		border-bottom: 1px solid var(--border);
		background: var(--bg-surface);
		-webkit-user-select: none;
		user-select: none;
	}

	.title-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1.5rem 0;
		/* Keep clear of the fixed top bar overhead — it floats over this corner
		   with z-index 200, so anything reaching under it is unusable. The width
		   is measured in +layout.svelte (it grows with the username) and is 0
		   wherever the bar isn't overhead, which collapses this to the 1.5rem. */
		padding-right: calc(var(--top-bar-width, 0px) + 1.5rem);
	}

	.doc-title {
		/* Sized to its text, not stretched to fill the row. Stretching pushed
		   the rename and copy buttons to the row's right edge, where they
		   landed underneath the fixed top bar (z-index 200) and tangled with
		   Sign Out / ? / the theme toggle. They belong beside the title. */
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 1.3rem;
		font-weight: 600;
		color: var(--text-heading);
	}

	.doc-title-input {
		flex: 1;
		min-width: 0;
		font-size: 1.3rem;
		font-weight: 600;
		color: var(--text-heading);
		border: 1px solid var(--accent);
		border-radius: 4px;
		padding: 0.1rem 0.4rem;
		background: var(--bg-surface);
		/* Opt back in — a text field inheriting user-select:none loses its
		   selection handles and caret dragging on iOS. */
		-webkit-user-select: text;
		user-select: text;
	}

	.doc-title-input:focus {
		outline: none;
	}

	.rename-btn,
	.title-copy-btn {
		background: none;
		border: 1px solid transparent;
		border-radius: 4px;
		cursor: pointer;
		padding: 0.25rem 0.5rem;
		font-size: 0.9rem;
		color: var(--text-faint);
		flex-shrink: 0;
	}

	.rename-btn:hover,
	.title-copy-btn:hover {
		background: var(--bg-elevated);
		border-color: var(--border-input);
		color: var(--text-heading);
	}

	/* Holds the tick (or cross) legible for the two seconds it shows. */
	.title-copy-btn.flashing {
		color: var(--accent);
	}

	.editor-toolbar {
		display: flex;
		gap: 2px;
		padding: 0.5rem 1.5rem;
		flex-wrap: wrap;
	}

	/* Segmented Read/Edit control at the head of the toolbar */
	.mode-toggle {
		display: flex;
		gap: 2px;
	}

	.tb-btn {
		background: none;
		border: 1px solid transparent;
		border-radius: 4px;
		cursor: pointer;
		padding: 0.25rem 0.5rem;
		font-size: 0.8rem;
		color: var(--text-faint);
		min-width: 28px;
		text-align: center;
	}

	.tb-btn:hover {
		background: var(--bg-elevated);
		border-color: var(--border-input);
	}

	.tb-btn.active {
		background: var(--bg-active);
		border-color: var(--border-active);
		color: var(--text-heading);
	}

	.tb-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	/* Find bar — sits below the toolbar row, inside the header. It's already
	   clear of the fixed mobile hamburger button, which overlaps the title row
	   above it, so it needs no gutter of its own. */
	.find-bar {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0 1.5rem 0.5rem;
	}

	.find-input {
		flex: 1;
		min-width: 0;
		max-width: 22rem;
		font-size: 0.85rem;
		font-family: inherit;
		color: var(--text);
		background: var(--bg);
		border: 1px solid var(--border-input);
		border-radius: 4px;
		padding: 0.25rem 0.5rem;
		/* See .doc-title-input — the header opts out of selection, fields opt in. */
		-webkit-user-select: text;
		user-select: text;
	}

	.find-input:focus {
		outline: none;
		border-color: var(--border-active);
	}

	.find-count {
		font-size: 0.75rem;
		color: var(--text-muted);
		min-width: 5rem;
	}

	.tb-sep {
		width: 1px;
		background: var(--border);
		margin: 0 0.25rem;
		align-self: stretch;
	}

	.editor-scroll {
		flex: 1;
		overflow-y: auto;
		background: var(--bg-surface);
	}

	.editor-content {
		max-width: 700px;
		margin: 0 auto;
		padding: 2rem 1.5rem;
		min-height: 100%;
		/* The one region that is meant to be selected, stated explicitly so it
		   survives any future user-select:none on an ancestor. */
		-webkit-user-select: text;
		user-select: text;
	}

	/* TipTap editor styling */
	:global(.editor-content .tiptap) {
		outline: none;
		font-family: Georgia, 'Times New Roman', serif;
		font-size: 1.05rem;
		line-height: 1.75;
		color: var(--text);
	}

	:global(.editor-content .tiptap p) {
		margin-bottom: 0.75rem;
	}

	:global(.editor-content .tiptap h1) {
		font-size: 1.75rem;
		font-weight: 600;
		margin: 1.5rem 0 0.75rem;
		color: var(--text-heading);
	}

	:global(.editor-content .tiptap h2) {
		font-size: 1.4rem;
		font-weight: 600;
		margin: 1.25rem 0 0.5rem;
		color: var(--text-heading);
	}

	:global(.editor-content .tiptap h3) {
		font-size: 1.15rem;
		font-weight: 600;
		margin: 1rem 0 0.5rem;
		color: var(--text-heading);
	}

	:global(.editor-content .tiptap blockquote) {
		border-left: 3px solid var(--border-input);
		padding-left: 1rem;
		margin: 0.75rem 0;
		color: var(--text-faint);
		font-style: italic;
	}

	:global(.editor-content .tiptap ul),
	:global(.editor-content .tiptap ol) {
		margin: 0.5rem 0;
		padding-left: 1.5rem;
	}

	:global(.editor-content .tiptap li) {
		margin-bottom: 0.25rem;
	}

	:global(.editor-content .tiptap code) {
		background: var(--bg-elevated);
		padding: 0.1rem 0.3rem;
		border-radius: 3px;
		font-size: 0.9em;
	}

	:global(.editor-content .tiptap pre) {
		background: var(--bg-elevated);
		padding: 0.75rem 1rem;
		border-radius: 6px;
		margin: 0.75rem 0;
		overflow-x: auto;
	}

	:global(.editor-content .tiptap p.is-editor-empty:first-child::before) {
		content: attr(data-placeholder);
		color: var(--text-placeholder);
		pointer-events: none;
		float: left;
		height: 0;
	}

	/* Search highlight — CSS animation so ProseMirror can't interfere */
	:global(.search-highlight) {
		border-radius: 2px;
		animation: search-fade 6s ease-out forwards;
	}

	@keyframes search-fade {
		0%, 50% { background: var(--search-highlight); }
		100% { background: transparent; }
	}

	/* Find-in-document highlights. Unlike .search-highlight these are painted
	   by a decoration set that we own and repaint, so they simply persist —
	   no animation, no fade — until the term changes or the bar closes. */
	:global(.find-match) {
		background: var(--find-match);
		border-radius: 2px;
	}

	:global(.find-match-current) {
		background: var(--find-match-current);
	}

	/* Same story as .editor-header: a selection dragged off the bottom of the
	   prose must not pick up the word count or the save status. */
	.editor-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.4rem 1.5rem;
		background: var(--bg-elevated);
		border-top: 1px solid var(--border);
		font-size: 0.8rem;
		color: var(--text-secondary);
		-webkit-user-select: none;
		user-select: none;
	}

	.footer-right {
		display: flex;
		gap: 1rem;
		align-items: center;
	}

	.footer-btn {
		background: none;
		border: 1px solid var(--border-input);
		border-radius: 4px;
		padding: 0.15rem 0.5rem;
		font-size: 0.75rem;
		color: var(--accent);
		cursor: pointer;
	}

	.footer-btn:hover {
		background: var(--bg-elevated);
	}

	.footer-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.spellcheck-indicator {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.save-status.saved { color: var(--saved); }
	.save-status.saving { color: var(--saving); }
	.save-status.unsaved { color: var(--unsaved); }

	@media (max-width: 768px) {
		.title-row {
			/* Left gutter clears the fixed mobile hamburger button (.binder-reopen
			   in the workspace page: 0.5rem offset + 2.25rem square + gap) so the
			   title (and the rename pencil beside it) don't render underneath it.
			   Applied unconditionally — the button lives in a different
			   component, so a conditional gutter would cause layout shift every
			   time the drawer opens/closes. */
			padding: 0.5rem 1rem 0 3.5rem;
		}

		.doc-title,
		.doc-title-input {
			font-size: 1.1rem;
		}

		.rename-btn,
		.title-copy-btn {
			min-width: 2rem;
			min-height: 2rem;
		}

		.editor-toolbar {
			padding: 0.25rem 1rem;
		}

		.mode-toggle button {
			min-height: 2rem;
			padding: 0.25rem 0.6rem;
		}

		.find-bar {
			padding: 0 1rem 0.5rem;
			flex-wrap: wrap;
		}

		.find-input {
			/* 16px exactly — anything smaller makes iOS zoom the page on focus. */
			font-size: 16px;
		}

		.find-bar .tb-btn {
			min-width: 2rem;
			min-height: 2rem;
		}

		.editor-content {
			padding: 1rem;
		}

		.editor-footer {
			padding: 0.3rem 1rem;
		}
	}
</style>

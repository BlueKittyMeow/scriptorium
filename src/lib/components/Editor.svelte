<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Editor, Extension } from '@tiptap/core';
	import StarterKit from '@tiptap/starter-kit';
	import Placeholder from '@tiptap/extension-placeholder';
	import { Plugin, PluginKey } from '@tiptap/pm/state';
	import { Decoration, DecorationSet } from '@tiptap/pm/view';

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
		contentVersion = 0
	}: {
		docId: string;
		initialContent: string;
		title: string;
		onsave: (content: string) => Promise<void>;
		searchTerm?: string | null;
		onSearchHighlightDone?: () => void;
		onSnapshotsToggle?: () => void;
		onManualSnapshot?: () => Promise<void>;
		registerFlush?: (flush: () => Promise<void>) => void;
		contentVersion?: number;
	} = $props();

	let element: HTMLDivElement;
	let scrollContainer: HTMLDivElement;
	let editor: Editor | null = $state(null);
	let wordCount = $state(0);
	let saveStatus: 'saved' | 'saving' | 'unsaved' = $state('saved');
	let saveTimeout: any = null;
	let currentDocId = $state('');
	let spellcheck = $state(
		typeof localStorage !== 'undefined'
			? localStorage.getItem('scriptorium-spellcheck') !== 'false'
			: true
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

	function countWords(text: string): number {
		return text.trim().split(/\s+/).filter(Boolean).length;
	}

	function updateWordCount() {
		if (editor) {
			wordCount = countWords(editor.getText());
		}
	}

	async function triggerSave() {
		if (!editor || !onsave) return;
		saveStatus = 'saving';
		try {
			await onsave(editor.getHTML());
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
				SearchHighlight
			],
			content: initialContent,
			editorProps: {
				attributes: {
					spellcheck: String(spellcheck)
				}
			},
			onUpdate: () => {
				updateWordCount();
				scheduleSave();
			},
			onTransaction: () => {
				editor = editor;
			}
		});
		updateWordCount();
		registerFlush?.(flushSave);
	});

	onDestroy(() => {
		clearTimeout(saveTimeout);
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
		if (currentDocId && saveStatus === 'unsaved' && editor) {
			clearTimeout(saveTimeout);
			try {
				await onsave(editor.getHTML());
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

<div class="editor-container">
	<div class="editor-header">
		<h1 class="doc-title">{title}</h1>
		<div class="editor-toolbar">
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
		</div>
	</div>

	<div class="editor-scroll" bind:this={scrollContainer}>
		<div class="editor-content" bind:this={element}></div>
	</div>

	<div class="editor-footer">
		<span class="word-count">{wordCount.toLocaleString()} words</span>
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
			<span class="spellcheck-indicator">{spellcheck ? 'Spellcheck on' : 'Spellcheck off'}</span>
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

	.editor-header {
		border-bottom: 1px solid var(--border);
		background: var(--bg-surface);
	}

	.doc-title {
		font-size: 1.3rem;
		font-weight: 600;
		padding: 0.75rem 1.5rem 0;
		color: var(--text-heading);
	}

	.editor-toolbar {
		display: flex;
		gap: 2px;
		padding: 0.5rem 1.5rem;
		flex-wrap: wrap;
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

	.editor-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.4rem 1.5rem;
		background: var(--bg-elevated);
		border-top: 1px solid var(--border);
		font-size: 0.8rem;
		color: var(--text-secondary);
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
		.doc-title {
			font-size: 1.1rem;
			padding: 0.5rem 1rem 0;
		}

		.editor-toolbar {
			padding: 0.25rem 1rem;
		}

		.editor-content {
			padding: 1rem;
		}

		.editor-footer {
			padding: 0.3rem 1rem;
		}
	}
</style>

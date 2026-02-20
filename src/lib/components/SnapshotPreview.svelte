<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Editor } from '@tiptap/core';
	import StarterKit from '@tiptap/starter-kit';

	let { content }: { content: string } = $props();

	let element: HTMLDivElement;
	let editor: Editor | null = $state(null);

	onMount(() => {
		editor = new Editor({
			element,
			extensions: [
				StarterKit.configure({
					heading: { levels: [1, 2, 3] }
				})
			],
			content,
			editable: false
		});
	});

	onDestroy(() => editor?.destroy());
</script>

<div class="preview-content" bind:this={element}></div>

<style>
	.preview-content {
		max-width: 700px;
		margin: 0 auto;
		padding: 2rem 1.5rem;
		min-height: 100%;
	}

	/* Read-only TipTap styling — matches Editor.svelte */
	:global(.preview-content .tiptap) {
		outline: none;
		font-family: Georgia, 'Times New Roman', serif;
		font-size: 1.05rem;
		line-height: 1.75;
		color: var(--text);
	}

	:global(.preview-content .tiptap p) {
		margin-bottom: 0.75rem;
	}

	:global(.preview-content .tiptap h1) {
		font-size: 1.75rem;
		font-weight: 600;
		margin: 1.5rem 0 0.75rem;
		color: var(--text-heading);
	}

	:global(.preview-content .tiptap h2) {
		font-size: 1.4rem;
		font-weight: 600;
		margin: 1.25rem 0 0.5rem;
		color: var(--text-heading);
	}

	:global(.preview-content .tiptap h3) {
		font-size: 1.15rem;
		font-weight: 600;
		margin: 1rem 0 0.5rem;
		color: var(--text-heading);
	}

	:global(.preview-content .tiptap blockquote) {
		border-left: 3px solid var(--border-input);
		padding-left: 1rem;
		margin: 0.75rem 0;
		color: var(--text-faint);
		font-style: italic;
	}

	:global(.preview-content .tiptap ul),
	:global(.preview-content .tiptap ol) {
		margin: 0.5rem 0;
		padding-left: 1.5rem;
	}

	:global(.preview-content .tiptap li) {
		margin-bottom: 0.25rem;
	}

	@media (max-width: 768px) {
		.preview-content {
			padding: 1rem;
		}
	}
</style>

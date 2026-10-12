<script lang="ts">
	import { onMount } from 'svelte';
	import Editor from '$lib/components/Editor.svelte';
	import { readingOrder, chapterNumbers } from '$lib/chapters.js';
	import { localAccount, localWorks, localDrafts, getLocalDocument, getDraft, saveDraft, syncDraft, clearLocalCopies, type LocalWork, type LocalDocument, type Draft } from '$lib/offline.js';
	let account = $state<{ id: string; username: string }>();
	let works: LocalWork[] = $state([]);
	let drafts: Draft[] = $state([]);
	let work = $state<LocalWork>();
	let active = $state<LocalDocument>();
	let message = $state('Loading device copies…');
	let busy = $state(false);
	let flush: (() => Promise<boolean>) | undefined;
	let generation = 0;
	let writes: Promise<void> = Promise.resolve();
	let localError: Error | undefined;
	const chapters = $derived(work ? readingOrder(work.tree) : []);
	const numbers = $derived(work ? chapterNumbers(work.tree, !!work.novel.numbering_enabled) : new Map<string, number>());
	const index = $derived(chapters.findIndex(n => n.id === active?.id));
	async function refresh() {
		if (!account) return;
		works = await localWorks(account.id); drafts = await localDrafts(account.id);
	}
	onMount(() => {
		(async () => {
			try { account = await localAccount(); await refresh(); message = account ? 'Device copies are ready. Changes sync only to the matching signed-in account.' : 'Sign in online once to unlock this account’s saved device copies.'; }
			catch (e) { message = String(e); }
		})();
		const reconnect = () => { void sync(); };
		window.addEventListener('online', reconnect);
		const retry = setInterval(() => { if (navigator.onLine && drafts.length && !message.includes('Conflict:')) void sync(); }, 15000);
		return () => { window.removeEventListener('online', reconnect); clearInterval(retry); };
	});
	async function select(id: string) {
		if (flush && !(await flush())) return;
		if (!account) return;
		try {
			const draft = await getDraft(account.id, id);
			const doc = draft?.dirty ? draft.document : await getLocalDocument(account.id, id);
			if (!doc) { message = 'This chapter has not been downloaded on this device.'; return; }
			generation = draft?.generation ?? 0; localError = undefined;
			active = { ...doc, content: draft?.dirty ? draft.content : doc.content };
		} catch (e) { message = String(e); }
	}
	function draft(content: string, id: string) {
		if (!account || !active || active.id !== id) return;
		const userId = account.id, document = $state.snapshot(active);
		writes = writes.then(async () => {
			try { const saved = await saveDraft(userId, document, content, generation); generation = saved.generation; localError = undefined; await refresh(); }
			catch (e) { localError = e as Error; message = String(e); }
		});
	}
	async function save(content: string, id: string) {
		draft(content, id); await writes;
		if (localError) throw localError;
	}
	async function chooseWork(id: string) {
		if (flush && !(await flush())) return;
		work = works.find(w => w.id === id); active = undefined; flush = undefined;
		const first = work && readingOrder(work.tree)[0]; if (first) await select(first.id);
	}
	async function sync() {
		if (busy || !account) return;
		busy = true;
		try {
			if (flush && !(await flush())) return;
			await writes;
			for (const d of await localDrafts(account.id)) await syncDraft(d);
			await refresh();
			if (active) {
				const server = await getLocalDocument(account.id, active.id);
				const pending = await getDraft(account.id, active.id);
				generation = pending?.generation ?? 0;
				if (server) active = { ...server, content: active.content };
			}
			message = 'All device changes are synced to the server.';
		} catch (e) { message = String(e); await refresh(); }
		finally { busy = false; }
	}
	function download() {
		const blob = new Blob([JSON.stringify({ works, drafts }, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob), link = document.createElement('a');
		link.href = url; link.download = 'scriptorium-device-drafts.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	async function clear() {
		if (!account || !confirm('Remove downloaded copies from this device? Server copies stay unchanged. Unsynced drafts must be synced first.')) return;
		try { if (flush && !(await flush())) return; await clearLocalCopies(account.id); active = undefined; work = undefined; await refresh(); message = 'Downloaded copies removed from this device.'; }
		catch { message = 'Unsynced writing remains on this device. Sync it before removing downloaded copies.'; }
	}
</script>
<svelte:head><title>Device copies — Scriptorium</title></svelte:head>
<div class="offline-workspace">
	<header>
		<a href="/" data-sveltekit-reload>← Online library</a>
		<h1>On this device{account ? ` · ${account.username}` : ''}</h1>
		<p role="status">{message}</p>
		<p>{drafts.length} chapter{drafts.length === 1 ? '' : 's'} waiting to sync.</p>
		<div class="controls">
			<button onclick={sync} disabled={busy || !account}>{busy ? 'Syncing…' : 'Sync now'}</button>
			<button onclick={download} disabled={!drafts.length}>Download unsynced drafts</button>
			<button onclick={clear} disabled={busy || !works.length || !!drafts.length}>Remove device copies</button>
		</div>
		<label>Work <select aria-label="Work" onchange={e => chooseWork(e.currentTarget.value)} value={work?.id ?? ''} disabled={busy}><option value="">Choose a downloaded work</option>{#each works as w}<option value={w.id}>{w.novel.title}</option>{/each}</select></label>
		{#if work}<label>Chapter <select aria-label="Chapter" onchange={e => select(e.currentTarget.value)} value={active?.id ?? ''} disabled={busy}>{#each chapters as c}<option value={c.id}>{numbers.has(c.id) ? `${numbers.get(c.id)}. ` : ''}{c.title}</option>{/each}</select></label>{/if}
		{#if !works.length && account}<p>No complete works downloaded yet. Open a work online and choose “Keep on this device.” Unsynced chapters below remain recoverable.</p>{/if}
		{#if drafts.length}<details><summary>Unsynced chapters and conflict recovery</summary><p>For a conflict, download your draft before opening the server copy. Sync never silently replaces a changed server chapter.</p>{#each drafts as d}<button onclick={() => select(d.id)} disabled={busy}>{d.document.title}</button>{/each}</details>{/if}
	</header>
	{#if active}<div class="writing" inert={busy}>
		<Editor docId={active.id} title={active.title} initialContent={active.content} onsave={save} ondraft={draft} savedLabel="Saved on this device" registerFlush={f => flush = f}
			chapterNumber={numbers.get(active.id)} onprevious={index > 0 ? () => select(chapters[index - 1].id) : undefined} onnext={index >= 0 && index < chapters.length - 1 ? () => select(chapters[index + 1].id) : undefined}/>
	</div>{/if}
</div>
<style>
	.offline-workspace { max-width: 1100px; margin: auto; padding: 1rem; }
	header { padding-right: var(--top-bar-width, 0px); }
	h1 { font: 1.4rem Georgia, serif; } p { font-size: .9rem; }
	.controls { display: flex; flex-wrap: wrap; gap: .5rem; }
	button, select { font: inherit; padding: .65rem; min-height: 44px; max-width: 100%; }
	label { display: block; margin: .75rem 0; } select { width: 100%; }
	.writing { height: 75dvh; min-height: 420px; }
</style>

<script lang="ts">
	import { page } from '$app/stores';
</script>

<main>
	<h1>{$page.status === 404 ? 'This page could not be found' : 'Scriptorium could not open this page'}</h1>
	<p>{$page.error?.message || 'The server is temporarily unavailable. Please try again shortly.'}</p>
	<p>If you have unsaved writing in another tab, keep that tab open.</p>
	<a href="/">Return to the library</a>
</main>

<style>
	main { max-width: 42rem; margin: 5rem auto; padding: 1.5rem; line-height: 1.6; }
	h1 { font-size: 1.5rem; }
	a { color: var(--accent); }
</style>

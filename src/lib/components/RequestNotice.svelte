<script lang="ts">
	import { apiFailure } from '$lib/api.js';
</script>

{#if $apiFailure}
	<aside class="request-notice" role="alert" aria-live="assertive">
		<p>{$apiFailure.message}</p>
		<div>
			{#if $apiFailure.signIn}
				<a href="/login" target="_blank" rel="noopener noreferrer">Sign in in a new tab</a>
			{/if}
			<button onclick={() => apiFailure.set(null)} aria-label="Dismiss error message">Dismiss</button>
		</div>
	</aside>
{/if}

<style>
	.request-notice { position: fixed; z-index: 10000; top: 3.5rem; right: 1rem; max-width: 34rem; max-height: 40dvh; overflow: auto; padding: 1rem; border: 1px solid var(--error-text); border-radius: 6px; background: var(--error-bg); color: var(--error-text); box-shadow: 0 2px 10px var(--shadow-sm); }
	p { margin: 0 0 .75rem; line-height: 1.5; }
	div { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
	a { color: inherit; text-decoration: underline; }
	button { font: inherit; color: inherit; background: transparent; border: 1px solid currentColor; border-radius: 4px; padding: .4rem .7rem; cursor: pointer; }
	@media (max-width: 768px) { .request-notice { top: .5rem; left: .5rem; right: .5rem; } }
</style>

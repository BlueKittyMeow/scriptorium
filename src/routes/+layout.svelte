<script lang="ts">
	let { children } = $props();
</script>

<div class="app">
	{@render children()}
</div>

<style>
	:global(*) {
		margin: 0;
		padding: 0;
		box-sizing: border-box;
	}

	:global(body) {
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		color: #2c2c2c;
		background: #faf9f7;
		min-height: 100vh;
	}

	:global(a) {
		color: #5c4a3a;
	}

	.app {
		min-height: 100vh;
	}
</style>

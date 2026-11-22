<!-- ─── App Root ────────────────────────────────────────────────────────────── -->
<!-- Root component with client-side routing. Renders the appropriate page -->
<!-- based on the current URL path. -->

<script lang="ts">
	import DisplayRecovery from "./components/shared/DisplayRecovery.svelte";
	import { recordDisplayError } from "./utils/display-error.js";
	import { getCurrentRoute } from "./stores/router.svelte.js";
	import ChatLayout from "./components/layout/ChatLayout.svelte";
	import PinPage from "./pages/PinPage.svelte";
	import DashboardPage from "./pages/DashboardPage.svelte";
	import SetupPage from "./pages/SetupPage.svelte";
	import ConfirmModal from "./components/overlays/ConfirmModal.svelte";

	const route = $derived(getCurrentRoute());
</script>

<svelte:boundary onerror={recordDisplayError}>
{#if route.page === "chat"}
	<ChatLayout />
{:else if route.page === "dashboard"}
	<DashboardPage />
{:else if route.page === "auth"}
	<PinPage />
{:else if route.page === "setup"}
	<SetupPage />
{/if}

<ConfirmModal />

{#snippet failed(_error, reset)}
	<DisplayRecovery retry={reset} />
{/snippet}
</svelte:boundary>

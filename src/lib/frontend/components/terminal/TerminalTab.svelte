<!--
  TerminalTab — Single terminal instance.
  Creates an XtermAdapter on mount, wires input→pty_input, subscribes to PTY output
  via the non-reactive callback pattern, replays scrollback on mount, and handles
  its own resize via ResizeObserver on the container element.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import {
		onOutput,
		getScrollback,
		registerTerminalAdapter,
		unregisterTerminalAdapter,
	} from "../../stores/terminal.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import { XtermAdapter, ANSI_THEME } from "../../utils/xterm-adapter.js";
	import {
		themeState,
		getCurrentTheme,
		computeTerminalTheme,
	} from "../../stores/theme.svelte.js";

	let {
		ptyId,
		active,
		fontSize,
	}: {
		ptyId: string;
		active: boolean;
		fontSize?: number;
	} = $props();

	let containerEl: HTMLDivElement;
	let adapter = $state<XtermAdapter | null>(null);

	onMount(() => {
		const xterm = new XtermAdapter(fontSize ? { fontSize } : undefined);
		adapter = xterm;
		xterm.mount(containerEl);
		// Toolbar actions (Paste) reach this terminal through the store registry.
		registerTerminalAdapter(ptyId, xterm);

		// Apply current theme immediately on mount (before any data is written)
		const currentTheme = getCurrentTheme();
		if (currentTheme) {
			xterm.setTheme(computeTerminalTheme(currentTheme));
		}

		// Coalesce typing bursts into one upstream write. OpenCode persists each
		// input frame; sending one frame per character makes pastes/fast typing lag.
		let inputBuffer = "";
		let inputTimer: ReturnType<typeof setTimeout> | undefined;
		function flushInput() {
			clearTimeout(inputTimer);
			inputTimer = undefined;
			if (!inputBuffer) return;
			const data = inputBuffer;
			inputBuffer = "";
			wsSend({ type: "pty_input", ptyId, data });
		}
		xterm.onData((data: string) => {
			inputBuffer += data;
			// Enter, interrupts and escape sequences should take effect immediately.
			if (["\r", "\n", "\x03", "\x1b"].some((key) => data.includes(key)) || inputBuffer.length >= 32768) {
				flushInput();
			} else if (inputTimer === undefined) {
				inputTimer = setTimeout(flushInput, 8);
			}
		});

		// Wire resize → server
		xterm.onResize((size: { cols: number; rows: number }) => {
			if (active) {
				wsSend({ type: "pty_resize", ptyId, cols: size.cols, rows: size.rows });
			}
		});

		// Replay scrollback buffer (reconnection / tab remount)
		const buffer = getScrollback(ptyId);
		if (buffer.length) xterm.write(buffer.join(""));

		// Subscribe to live PTY output (high-throughput, bypasses Svelte reactivity)
		const unsubOutput = onOutput(ptyId, (data: string) => {
			xterm.write(data);
		});

		// Send initial dimensions to server
		wsSend({
			type: "pty_resize",
			ptyId,
			cols: xterm.cols,
			rows: xterm.rows,
		});

		// Focus if this is the active tab
		if (active) xterm.focus();

		// Own resize handling — fit terminal when container dimensions change
		let resizeFrame = 0;
		const ro = new ResizeObserver(() => {
			if (!active || resizeFrame) return;
			resizeFrame = requestAnimationFrame(() => {
				resizeFrame = 0;
				if (active) xterm.resize();
			});
		});
		ro.observe(containerEl);

		// ─── Touch scrolling ──────────────────────────────────────────────────
		// Translate vertical swipe gestures into xterm scrollLines() calls
		// so users can scroll the terminal scrollback on touch devices.
		let touchStartY: number | null = null;
		let touchAccum = 0; // accumulated px not yet converted to lines
		const LINE_HEIGHT_PX = 16; // approximate; close enough for scrolling feel

		function onTouchStart(e: TouchEvent) {
			if (e.touches.length === 1) {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
				touchStartY = e.touches[0]!.clientY;
				touchAccum = 0;
			}
		}

		function onTouchMove(e: TouchEvent) {
			if (touchStartY === null || e.touches.length !== 1) return;
			e.preventDefault(); // prevent page scroll while swiping terminal
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			const currentY = e.touches[0]!.clientY;
			const deltaY = touchStartY - currentY; // positive = swiped up
			touchStartY = currentY;
			touchAccum += deltaY;

			const lines = Math.trunc(touchAccum / LINE_HEIGHT_PX);
			if (lines !== 0) {
				xterm.scrollLines(lines);
				touchAccum -= lines * LINE_HEIGHT_PX;
			}
		}

		function onTouchEnd() {
			touchStartY = null;
			touchAccum = 0;
		}

		containerEl.addEventListener("touchstart", onTouchStart, {
			passive: true,
		});
		containerEl.addEventListener("touchmove", onTouchMove, {
			passive: false,
		});
		containerEl.addEventListener("touchend", onTouchEnd);

		return () => {
			flushInput();
			containerEl.removeEventListener("touchstart", onTouchStart);
			containerEl.removeEventListener("touchmove", onTouchMove);
			containerEl.removeEventListener("touchend", onTouchEnd);
			cancelAnimationFrame(resizeFrame);
			ro.disconnect();
			unsubOutput();
			unregisterTerminalAdapter(ptyId);
			xterm.dispose();
			adapter = null;
		};
	});

	// When tab becomes active: re-fit (container may have had zero dimensions
	// when hidden) and focus the terminal.
	$effect(() => {
		if (active && adapter) {
			adapter.resize();
			adapter.focus();
		}
	});

	// When font size changes, update the adapter and notify parent of new dimensions
	$effect(() => {
		if (active && fontSize && adapter) {
			adapter.setFontSize(fontSize);
		}
	});

	// When theme changes, update the terminal theme
	$effect(() => {
		const _themeId = themeState.currentThemeId;
		if (!adapter) return;
		const currentTheme = getCurrentTheme();
		if (currentTheme) {
			adapter.setTheme(computeTerminalTheme(currentTheme));
		} else {
			// Default theme — reset terminal to built-in ANSI colors
			adapter.setTheme(ANSI_THEME);
		}
	});
</script>

<div
	bind:this={containerEl}
	class="term-tab-content absolute inset-0"
	class:hidden={!active}
	data-pty-id={ptyId}
></div>

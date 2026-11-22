/**
 * Shared typed mock factories for test dependency objects.
 *
 * Eliminates `as unknown as` double-casts by providing fully-typed mocks
 * with sensible defaults for every field. Each factory accepts a
 * Partial<T> override to customize per-test.
 */
import { vi } from "vitest";
import type { ClientInitDeps } from "../../src/lib/bridges/client-init.js";
import type { HandlerDeps } from "../../src/lib/handlers/types.js";
import { createSilentLogger } from "../../src/lib/logger.js";
import { PendingUserMessages } from "../../src/lib/relay/pending-user-messages.js";
import type { ProjectRelay } from "../../src/lib/relay/relay-stack.js";
import type { SSEWiringDeps } from "../../src/lib/relay/sse-wiring.js";
import { ToolContentStore } from "../../src/lib/relay/tool-content-store.js";

// ─── Sub-component factories ────────────────────────────────────────────────

function createMockWsHandlerFull(): HandlerDeps["wsHandler"] {
	return {
		broadcast: vi.fn(),
		sendTo: vi.fn(),
		setClientSession: vi.fn(),
		getClientSession: vi.fn(),
		getClientsForSession: vi.fn().mockReturnValue([]),
		sendToSession: vi.fn(),
	};
}

function createMockClient(): HandlerDeps["client"] {
	// We cast to HandlerDeps["client"] because OpenCodeClient is a class
	// with many methods — we stub every method tests actually call.
	// The cast is contained here so no test file needs it.
	return {
		sendMessageAsync: vi.fn().mockResolvedValue(undefined),
		abortSession: vi.fn().mockResolvedValue(undefined),
		replyPermission: vi.fn().mockResolvedValue(undefined),
		replyQuestion: vi.fn().mockResolvedValue(undefined),
		rejectQuestion: vi.fn().mockResolvedValue(undefined),
		listPendingQuestions: vi.fn().mockResolvedValue([]),
		getSession: vi
			.fn()
			.mockResolvedValue({ id: "s1", modelID: "gpt-4", providerID: "openai" }),
		getMessages: vi.fn().mockResolvedValue([]),
		getMessage: vi
			.fn()
			.mockResolvedValue({ id: "msg-1", time: { created: 0 } }),
		getMessagesPage: vi.fn().mockResolvedValue([]),
		listSessions: vi.fn().mockResolvedValue([]),
		listAgents: vi.fn().mockResolvedValue([]),
		listProviders: vi.fn().mockResolvedValue({
			providers: [],
			defaults: {},
			connected: [],
		}),
		listCommands: vi.fn().mockResolvedValue([]),
		listProjects: vi.fn().mockResolvedValue([]),
		listDirectory: vi.fn().mockResolvedValue([]),
		getFileContent: vi
			.fn()
			.mockResolvedValue({ content: "file content", binary: false }),
		createPty: vi
			.fn()
			.mockResolvedValue({ id: "pty-1", title: "Terminal", pid: 42 }),
		deletePty: vi.fn().mockResolvedValue(undefined),
		resizePty: vi.fn().mockResolvedValue(undefined),
		listPtys: vi.fn().mockResolvedValue([]),
		// Persistent PTY (v2 experimental)
		listSessionTerminals: vi.fn().mockResolvedValue([]),
		createSessionTerminal: vi.fn().mockResolvedValue({
			id: "pty-1",
			title: "Terminal",
			command: "bash",
			args: [],
			cwd: "/tmp",
			status: "running",
			pid: 42,
			sessionID: "session-1",
			foregroundProcess: null,
			size: { cols: 80, rows: 24 },
			output: { head: 0, tail: 0 },
		}),
		getPersistentPty: vi
			.fn()
			.mockResolvedValue({ id: "pty-1", status: "running" }),
		updatePersistentPty: vi
			.fn()
			.mockResolvedValue({ id: "pty-1", status: "running" }),
		deletePersistentPty: vi.fn().mockResolvedValue(undefined),
		getPersistentPtySnapshot: vi.fn().mockResolvedValue({
			info: { id: "pty-1", status: "running" },
			text: "",
			checkpoint: "",
			cursor: { x: 0, y: 0 },
		}),
		readSessionTerminal: vi.fn().mockResolvedValue(null),
		// Session inbox (queue vs steer)
		listSessionInbox: vi.fn().mockResolvedValue([]),
		cancelInboxItem: vi.fn().mockResolvedValue(undefined),
		updateInboxItem: vi.fn().mockResolvedValue(undefined),
		// Skills
		listSkills: vi.fn().mockResolvedValue([]),
		activateSkill: vi.fn().mockResolvedValue(undefined),
		// MCP servers
		listMcpServers: vi.fn().mockResolvedValue([]),
		listMcpResources: vi
			.fn()
			.mockResolvedValue({ resources: [], templates: [] }),
		addMcpServer: vi.fn().mockResolvedValue(undefined),
		removeMcpServer: vi.fn().mockResolvedValue(undefined),
		connectMcpServer: vi.fn().mockResolvedValue(undefined),
		disconnectMcpServer: vi.fn().mockResolvedValue(undefined),
		// Integration credentials
		listCredentials: vi.fn().mockResolvedValue([]),
		createCredential: vi.fn().mockResolvedValue({
			id: "cred-1",
			integrationID: "anthropic",
			label: "",
			active: true,
			value: { type: "key", key: "sk-1" },
		}),
		updateCredential: vi.fn().mockResolvedValue(undefined),
		deleteCredential: vi.fn().mockResolvedValue(undefined),
		activateCredential: vi.fn().mockResolvedValue(undefined),
		// Integrations (connect flows)
		listIntegrations: vi.fn().mockResolvedValue([]),
		getIntegration: vi.fn().mockResolvedValue(undefined),
		integrationConnectKey: vi.fn().mockResolvedValue(undefined),
		integrationConnectOAuth: vi.fn().mockResolvedValue({
			attemptID: "att-1",
			url: "https://example.com/auth",
		}),
		integrationOAuthStatus: vi.fn().mockResolvedValue({ status: "pending" }),
		integrationOAuthComplete: vi.fn().mockResolvedValue(undefined),
		integrationCancelOAuth: vi.fn().mockResolvedValue(undefined),
		integrationConnectCommand: vi
			.fn()
			.mockResolvedValue({ attemptID: "att-1" }),
		integrationCommandStatus: vi.fn().mockResolvedValue({ status: "pending" }),
		integrationCancelCommand: vi.fn().mockResolvedValue(undefined),
		// Plugins
		listPlugins: vi.fn().mockResolvedValue([]),
		checkPlugins: vi.fn().mockResolvedValue([]),
		updatePlugins: vi.fn().mockResolvedValue(undefined),
		// References
		listReferences: vi.fn().mockResolvedValue([]),
		// Server info / config
		getServerInfo: vi.fn().mockResolvedValue({
			version: "2.0.24",
			pid: 1234,
			urls: ["http://localhost:4096"],
			paths: { tmp: "/tmp" },
		}),
		reloadConfig: vi.fn().mockResolvedValue(undefined),
		revertSession: vi.fn().mockResolvedValue(undefined),
		forkSession: vi.fn().mockResolvedValue({ id: "ses_forked" }),
		createSession: vi.fn().mockResolvedValue({ id: "session-new" }),
		deleteSession: vi.fn().mockResolvedValue(undefined),
		getAuthHeaders: vi.fn().mockReturnValue({}),
		getHealth: vi.fn().mockResolvedValue({ ok: true }),
		switchModel: vi.fn().mockResolvedValue(undefined),
		listPendingPermissions: vi.fn().mockResolvedValue([]),
		getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
		getConfig: vi.fn().mockResolvedValue({}),
		summarizeSession: vi.fn().mockResolvedValue(undefined),
		moveSession: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockImplementation((path: string) => ({ path })),
		getVcs: vi.fn().mockResolvedValue({
			provider: "git",
			branch: "main",
			defaultBranch: "main",
		}),
		listVcsBranches: vi.fn().mockResolvedValue(["main"]),
		getVcsDiff: vi.fn().mockResolvedValue([]),
		getFileStatus: vi.fn().mockResolvedValue([]),
	} as unknown as HandlerDeps["client"];
}

function createMockSessionMgr(): HandlerDeps["sessionMgr"] {
	return {
		getDefaultSessionId: vi.fn().mockResolvedValue("session-1"),
		createSession: vi.fn().mockResolvedValue({ id: "session-new" }),
		deleteSession: vi.fn().mockResolvedValue(undefined),
		renameSession: vi.fn().mockResolvedValue(undefined),
		listSessions: vi
			.fn()
			.mockResolvedValue([
				{ id: "s1", title: "Session 1", updatedAt: 0, messageCount: 0 },
			]),
		sendDualSessionLists: vi.fn().mockImplementation(async (send) => {
			send({
				type: "session_list",
				sessions: [
					{ id: "s1", title: "Session 1", updatedAt: 0, messageCount: 0 },
				],
				roots: true,
			});
			send({
				type: "session_list",
				sessions: [
					{ id: "s1", title: "Session 1", updatedAt: 0, messageCount: 0 },
				],
				roots: false,
			});
		}),
		searchSessions: vi.fn().mockResolvedValue([]),
		searchSessionsPage: vi.fn().mockResolvedValue({
			sessions: [],
			cursor: { previous: null, next: null },
		}),
		loadHistory: vi.fn().mockResolvedValue({
			messages: [],
			hasMore: false,
			total: 0,
		}),
		loadPreRenderedHistory: vi.fn().mockResolvedValue({
			messages: [],
			hasMore: false,
			total: 0,
		}),
		recordMessageActivity: vi.fn(),
		getSessionParentMap: vi.fn().mockReturnValue(new Map()),
		getLastMessageAtMap: vi.fn().mockReturnValue(new Map()),
		getLastKnownSessionCount: vi.fn().mockReturnValue(0),
		initialize: vi.fn().mockResolvedValue("session-1"),
		incrementPendingQuestionCount: vi.fn(),
		decrementPendingQuestionCount: vi.fn(),
		setPendingQuestionCounts: vi.fn(),
		clearPaginationCursor: vi.fn(),
		getForkEntry: vi.fn().mockReturnValue(undefined),
	} as unknown as HandlerDeps["sessionMgr"];
}

function createMockMessageCache(): HandlerDeps["messageCache"] {
	return {
		recordEvent: vi.fn(),
		getEvents: vi.fn().mockReturnValue(null),
		remove: vi.fn(),
		evictOldestSession: vi.fn().mockReturnValue(null),
		sessionCount: vi.fn().mockReturnValue(0),
		setOpenCodeUpdatedAt: vi.fn(),
		getOpenCodeUpdatedAt: vi.fn().mockReturnValue(undefined),
	} as unknown as HandlerDeps["messageCache"];
}

function createMockPermissionBridge(): HandlerDeps["permissionBridge"] {
	return {
		onPermissionResponse: vi.fn().mockReturnValue(null),
		onPermissionRequest: vi.fn(),
		onPermissionReplied: vi.fn(),
		getPending: vi.fn().mockReturnValue([]),
		checkTimeouts: vi.fn().mockReturnValue([]),
		findPendingForSession: vi.fn().mockReturnValue([]),
		recoverPending: vi.fn(),
	} as unknown as HandlerDeps["permissionBridge"];
}

function createMockOverrides(): HandlerDeps["overrides"] {
	return {
		agent: undefined,
		model: undefined,
		variant: "",
		defaultModel: undefined,
		defaultVariant: "",
		modelUserSelected: false,
		setAgent: vi.fn(),
		setModel: vi.fn(),
		setModelDefault: vi.fn(),
		setDefaultModel: vi.fn(),
		setVariant: vi.fn(),
		setSystemPrompt: vi.fn(),
		getModel: vi.fn().mockReturnValue(undefined),
		getAgent: vi.fn().mockReturnValue(undefined),
		getVariant: vi.fn().mockReturnValue(""),
		getSystemPrompt: vi.fn().mockReturnValue(undefined),
		getSessionVariant: vi.fn().mockReturnValue(undefined),
		isModelUserSelected: vi.fn().mockReturnValue(false),
		clear: vi.fn(),
		clearSession: vi.fn(),
		startProcessingTimeout: vi.fn(),
		clearProcessingTimeout: vi.fn(),
		resetProcessingTimeout: vi.fn(),
		dispose: vi.fn(),
	} as unknown as HandlerDeps["overrides"];
}

function createMockPtyManager(): HandlerDeps["ptyManager"] {
	return {
		sendInput: vi.fn(),
		closeSession: vi.fn(),
		hasSession: vi.fn().mockReturnValue(false),
		listSessions: vi.fn().mockReturnValue([]),
		getScrollback: vi.fn().mockReturnValue(""),
		getSession: vi.fn().mockReturnValue(undefined),
		registerSession: vi.fn(),
		setDimensions: vi.fn(),
		sessionCount: 0,
	} as unknown as HandlerDeps["ptyManager"];
}

function createMockConfig(): HandlerDeps["config"] {
	return {
		httpServer: {} as HandlerDeps["config"]["httpServer"],
		opencodeUrl: "http://localhost:4096",
		projectDir: "/test/project",
		slug: "test-project",
	} as unknown as HandlerDeps["config"];
}

function createMockTranslator(): SSEWiringDeps["translator"] {
	return {
		translate: vi.fn().mockReturnValue({ ok: false, reason: "mock" }),
		reset: vi.fn(),
		getSeenParts: vi.fn().mockReturnValue(new Map()),
		rebuildStateFromHistory: vi.fn(),
	} as SSEWiringDeps["translator"];
}

// ─── Top-level factories ────────────────────────────────────────────────────

export function createMockHandlerDeps(
	overrides?: Partial<HandlerDeps>,
): HandlerDeps {
	return {
		wsHandler: createMockWsHandlerFull(),
		client: createMockClient(),
		sessionMgr: createMockSessionMgr(),
		messageCache: createMockMessageCache(),
		pendingUserMessages: new PendingUserMessages(),
		permissionBridge: createMockPermissionBridge(),
		overrides: createMockOverrides(),
		ptyManager: createMockPtyManager(),
		toolContentStore: new ToolContentStore(),
		config: createMockConfig(),
		log: createSilentLogger(),
		connectPtyUpstream: vi.fn().mockResolvedValue(undefined),
		statusPoller: { isProcessing: vi.fn().mockReturnValue(false) },
		registry: {
			hasViewers: vi.fn().mockReturnValue(false),
			addViewer: vi.fn(),
			removeClient: vi.fn(),
		} as unknown as HandlerDeps["registry"],
		pollerManager: {
			isPolling: vi.fn().mockReturnValue(true),
			startPolling: vi.fn(),
		},
		forkMeta: {
			setForkEntry: vi.fn(),
			getForkEntry: vi.fn().mockReturnValue(undefined),
		},
		...overrides,
	};
}

export function createMockSSEWiringDeps(
	overrides?: Partial<SSEWiringDeps>,
): SSEWiringDeps {
	return {
		translator: createMockTranslator(),
		sessionMgr:
			createMockSessionMgr() as unknown as SSEWiringDeps["sessionMgr"],
		messageCache:
			createMockMessageCache() as unknown as SSEWiringDeps["messageCache"],
		pendingUserMessages: new PendingUserMessages(),
		permissionBridge:
			createMockPermissionBridge() as unknown as SSEWiringDeps["permissionBridge"],
		overrides: createMockOverrides() as unknown as SSEWiringDeps["overrides"],
		toolContentStore: new ToolContentStore(),
		wsHandler: {
			broadcast: vi.fn(),
			sendToSession: vi.fn(),
			getClientsForSession: vi.fn().mockReturnValue(["c1"]),
		},
		log: createSilentLogger(),
		pipelineLog: createSilentLogger(),
		slug: "test-project",
		...overrides,
	};
}

export function createMockClientInitDeps(
	overrides?: Partial<ClientInitDeps>,
): ClientInitDeps {
	return {
		wsHandler: {
			broadcast: vi.fn(),
			sendTo: vi.fn(),
			setClientSession: vi.fn(),
		},
		client: createMockClient() as unknown as ClientInitDeps["client"],
		sessionMgr:
			createMockSessionMgr() as unknown as ClientInitDeps["sessionMgr"],
		messageCache:
			createMockMessageCache() as unknown as ClientInitDeps["messageCache"],
		overrides: createMockOverrides() as unknown as ClientInitDeps["overrides"],
		ptyManager:
			createMockPtyManager() as unknown as ClientInitDeps["ptyManager"],
		permissionBridge: {
			getPending: vi.fn().mockReturnValue([]),
			recoverPending: vi.fn().mockReturnValue([]),
		},
		log: createSilentLogger(),
		...overrides,
	};
}

// ─── ProjectRelay mock factory ──────────────────────────────────────────────

export function createMockProjectRelay(
	overrides?: Partial<ProjectRelay>,
): ProjectRelay {
	return {
		wsHandler:
			createMockWsHandlerFull() as unknown as ProjectRelay["wsHandler"],
		sseConsumer: {
			connect: vi.fn(),
			disconnect: vi.fn(),
		} as unknown as ProjectRelay["sseConsumer"],
		client: createMockClient() as unknown as ProjectRelay["client"],
		sessionMgr: createMockSessionMgr() as unknown as ProjectRelay["sessionMgr"],
		translator: {} as unknown as ProjectRelay["translator"],
		permissionBridge:
			createMockPermissionBridge() as unknown as ProjectRelay["permissionBridge"],
		messageCache:
			createMockMessageCache() as unknown as ProjectRelay["messageCache"],
		isAnySessionProcessing: vi.fn().mockReturnValue(false),
		stop: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

// ─── Relay factory helpers for ProjectRegistry tests ────────────────────────

/** Factory that resolves immediately with a mock relay */
export function immediateRelayFactory(
	relay?: ProjectRelay,
): (signal: AbortSignal) => Promise<ProjectRelay> {
	return async () => relay ?? createMockProjectRelay();
}

/** Factory that rejects with the given error message */
export function failingRelayFactory(
	errorMsg: string,
): (signal: AbortSignal) => Promise<ProjectRelay> {
	return async () => {
		throw new Error(errorMsg);
	};
}

/** Factory controlled by a Deferred — resolves/rejects when you tell it to */
export interface DeferredRelay {
	factory: (signal: AbortSignal) => Promise<ProjectRelay>;
	resolve: (relay?: ProjectRelay) => void;
	reject: (error: Error) => void;
}

export function deferredRelayFactory(): DeferredRelay {
	let resolvePromise!: (relay: ProjectRelay) => void;
	let rejectPromise!: (error: Error) => void;

	const factory: (signal: AbortSignal) => Promise<ProjectRelay> = (signal) =>
		new Promise<ProjectRelay>((res, rej) => {
			resolvePromise = res;
			rejectPromise = rej;
			signal.addEventListener("abort", () =>
				rej(new DOMException("Aborted", "AbortError")),
			);
		});

	return {
		factory,
		resolve: (relay?: ProjectRelay) =>
			resolvePromise(relay ?? createMockProjectRelay()),
		reject: (error: Error) => rejectPromise(error),
	};
}

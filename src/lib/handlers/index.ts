// ─── Message Handlers ────────────────────────────────────────────────────────
// Re-exports all handler functions and builds the MESSAGE_HANDLERS dispatch
// table. This module replaces the monolithic message-handlers.ts.

// ─── Types ───────────────────────────────────────────────────────────────────

export type { PayloadMap } from "./payloads.js";
export type { HandlerDeps, MessageHandler } from "./types.js";

// ─── Session resolution ──────────────────────────────────────────────────────

export { resolveSession, resolveSessionForLog } from "./resolve-session.js";

// ─── Handler modules ─────────────────────────────────────────────────────────

export { filterAgents, handleGetAgents, handleSwitchAgent } from "./agent.js";
export {
	handleApplyAgents,
	handleDeleteAgent,
	handleExportAgents,
	handleImportAgents,
	handleListAgentLibrary,
	handleRemoveAppliedAgents,
	handleSaveAgent,
} from "./agent-library.js";
export {
	handleActivateCredential,
	handleCreateCredential,
	handleDeleteCredential,
	handleListCredentials,
	handleUpdateCredential,
} from "./credential.js";
export {
	handleGetFileContent,
	handleGetFileList,
	handleGetFileTree,
	handleGetVcs,
	handleGetVcsDiff,
	handleSaveFile,
} from "./files.js";
export {
	handleCancelInbox,
	handleListInbox,
	handleSetInboxDelivery,
} from "./inbox.js";
export {
	handleInstanceAdd,
	handleInstanceRemove,
	handleInstanceRename,
	handleInstanceStart,
	handleInstanceStop,
	handleInstanceUpdate,
	handleProxyDetect,
	handleScanNow,
	handleSetProjectInstance,
} from "./instance.js";
export {
	handleCheckPlugins,
	handleIntegrationCancelCommand,
	handleIntegrationCancelOAuth,
	handleIntegrationCommandStatus,
	handleIntegrationConnectCommand,
	handleIntegrationConnectKey,
	handleIntegrationConnectOAuth,
	handleIntegrationOAuthComplete,
	handleIntegrationOAuthStatus,
	handleListIntegrations,
	handleListPlugins,
	handleUpdatePlugins,
} from "./integration.js";
export {
	handleListMcp,
	handleListMcpResources,
	handleMcpAdd,
	handleMcpConnect,
	handleMcpDisconnect,
	handleMcpRemove,
} from "./mcp.js";
export {
	handleGetModels,
	handleSetDefaultModel,
	handleSetModelDefault,
	handleSetSubagentModel,
	handleSetVariantLock,
	handleSwitchModel,
	handleSwitchVariant,
} from "./model.js";
export {
	handleAskUserResponse,
	handlePermissionResponse,
	handleQuestionReject,
} from "./permissions.js";
export {
	clearSessionInputDraft,
	getSessionInputDraft,
	handleCancel,
	handleInputSync,
	handleMessage,
	handleRewind,
	handleRunCommand,
} from "./prompt.js";
export { handleGetReferences } from "./reference.js";
export { handleGetServerInfo, handleReloadConfig } from "./server.js";
export {
	handleDeleteSession,
	handleForkSession,
	handleListSessions,
	handleLoadMoreHistory,
	handleMoveSession,
	handleNewSession,
	handleRenameSession,
	handleSearchSessions,
	handleSummarizeSession,
	handleSwitchSession,
	handleViewSession,
} from "./session.js";
export {
	handleAddProject,
	handleGetCommands,
	handleGetProjects,
	handleListDirectories,
	handleRemoveProject,
	handleRenameProject,
} from "./settings.js";
export { handleActivateSkill, handleGetSkills } from "./skill.js";
export { handleSetSystemPrompt } from "./system-prompt.js";
export {
	handlePtyClose,
	handlePtyCreate,
	handlePtyInput,
	handlePtyResize,
	handleTerminalCommand,
} from "./terminal.js";
export { handleGetToolContent } from "./tool-content.js";

// ─── Dispatch Table ──────────────────────────────────────────────────────────

import { RelayError } from "../errors.js";
import { handleGetAgents, handleSwitchAgent } from "./agent.js";
import {
	handleApplyAgents,
	handleDeleteAgent,
	handleExportAgents,
	handleImportAgents,
	handleListAgentLibrary,
	handleRemoveAppliedAgents,
	handleSaveAgent,
} from "./agent-library.js";
import {
	handleActivateCredential,
	handleCreateCredential,
	handleDeleteCredential,
	handleListCredentials,
	handleUpdateCredential,
} from "./credential.js";
import {
	handleGetFileContent,
	handleGetFileList,
	handleGetFileTree,
	handleGetVcs,
	handleGetVcsDiff,
	handleSaveFile,
} from "./files.js";
import {
	handleCancelInbox,
	handleListInbox,
	handleSetInboxDelivery,
} from "./inbox.js";
import {
	handleInstanceAdd,
	handleInstanceRemove,
	handleInstanceRename,
	handleInstanceStart,
	handleInstanceStop,
	handleInstanceUpdate,
	handleProxyDetect,
	handleScanNow,
	handleSetProjectInstance,
} from "./instance.js";
import {
	handleCheckPlugins,
	handleIntegrationCancelCommand,
	handleIntegrationCancelOAuth,
	handleIntegrationCommandStatus,
	handleIntegrationConnectCommand,
	handleIntegrationConnectKey,
	handleIntegrationConnectOAuth,
	handleIntegrationOAuthComplete,
	handleIntegrationOAuthStatus,
	handleListIntegrations,
	handleListPlugins,
	handleUpdatePlugins,
} from "./integration.js";
import {
	handleListMcp,
	handleListMcpResources,
	handleMcpAdd,
	handleMcpConnect,
	handleMcpDisconnect,
	handleMcpRemove,
} from "./mcp.js";
import {
	handleGetModels,
	handleSetDefaultModel,
	handleSetModelDefault,
	handleSetSubagentModel,
	handleSetVariantLock,
	handleSwitchModel,
	handleSwitchVariant,
} from "./model.js";
import { handleNodecode } from "./nodecode.js";
import type { PayloadMap } from "./payloads.js";
import {
	handleAskUserResponse,
	handlePermissionResponse,
	handleQuestionReject,
} from "./permissions.js";
import {
	handleCancel,
	handleInputSync,
	handleMessage,
	handleRewind,
	handleRunCommand,
} from "./prompt.js";
import { handleGetReferences } from "./reference.js";
import { resolveSessionForLog } from "./resolve-session.js";
import { handleGetServerInfo, handleReloadConfig } from "./server.js";
import {
	handleDeleteSession,
	handleForkSession,
	handleListSessions,
	handleLoadMoreHistory,
	handleMoveSession,
	handleNewSession,
	handleRenameSession,
	handleSearchSessions,
	handleSummarizeSession,
	handleSwitchSession,
	handleViewSession,
} from "./session.js";
import {
	handleAddProject,
	handleGetCommands,
	handleGetProjects,
	handleListDirectories,
	handleRemoveProject,
	handleRenameProject,
} from "./settings.js";
import { handleActivateSkill, handleGetSkills } from "./skill.js";
import { handleSetSystemPrompt } from "./system-prompt.js";
import {
	handlePtyClose,
	handlePtyCreate,
	handlePtyInput,
	handlePtyResize,
	handleTerminalCommand,
} from "./terminal.js";
import { handleGetToolContent } from "./tool-content.js";
import type { HandlerDeps, MessageHandler } from "./types.js";
import { validatePayload } from "./validation.js";

// The dispatch table maps handler names to handler functions. Each handler
// accepts a specific PayloadMap type, but the table stores them as the
// default MessageHandler (union payload). This is safe because dispatchMessage
// only calls a handler with the payload matching its key. The cast is the
// single trust boundary — Phase 2 will add Valibot runtime validation here.
export const MESSAGE_HANDLERS: Record<keyof PayloadMap, MessageHandler> = {
	message: handleMessage as MessageHandler,
	run_command: handleRunCommand as MessageHandler,
	permission_response: handlePermissionResponse as MessageHandler,
	ask_user_response: handleAskUserResponse as MessageHandler,
	question_reject: handleQuestionReject as MessageHandler,
	new_session: handleNewSession as MessageHandler,
	switch_session: handleSwitchSession as MessageHandler,
	view_session: handleViewSession as MessageHandler,
	delete_session: handleDeleteSession as MessageHandler,
	rename_session: handleRenameSession as MessageHandler,
	fork_session: handleForkSession as MessageHandler,
	summarize_session: handleSummarizeSession as MessageHandler,
	move_session: handleMoveSession as MessageHandler,
	list_sessions: handleListSessions as MessageHandler,
	search_sessions: handleSearchSessions as MessageHandler,
	load_more_history: handleLoadMoreHistory as MessageHandler,
	get_agents: handleGetAgents as MessageHandler,
	switch_agent: handleSwitchAgent as MessageHandler,
	set_system_prompt: handleSetSystemPrompt as MessageHandler,
	list_agent_library: handleListAgentLibrary as MessageHandler,
	save_agent: handleSaveAgent as MessageHandler,
	delete_agent: handleDeleteAgent as MessageHandler,
	import_agents: handleImportAgents as MessageHandler,
	export_agents: handleExportAgents as MessageHandler,
	apply_agents: handleApplyAgents as MessageHandler,
	remove_applied_agents: handleRemoveAppliedAgents as MessageHandler,
	get_models: handleGetModels as MessageHandler,
	switch_model: handleSwitchModel as MessageHandler,
	set_default_model: handleSetDefaultModel as MessageHandler,
	set_subagent_model: handleSetSubagentModel as MessageHandler,
	set_model_default: handleSetModelDefault as MessageHandler,
	set_variant_lock: handleSetVariantLock as MessageHandler,
	switch_variant: handleSwitchVariant as MessageHandler,
	get_commands: handleGetCommands as MessageHandler,
	get_skills: handleGetSkills as MessageHandler,
	activate_skill: handleActivateSkill as MessageHandler,
	list_inbox: handleListInbox as MessageHandler,
	cancel_inbox: handleCancelInbox as MessageHandler,
	set_inbox_delivery: handleSetInboxDelivery as MessageHandler,
	get_projects: handleGetProjects as MessageHandler,
	add_project: handleAddProject as MessageHandler,
	list_directories: handleListDirectories as MessageHandler,
	remove_project: handleRemoveProject as MessageHandler,
	rename_project: handleRenameProject as MessageHandler,
	get_file_list: handleGetFileList as MessageHandler,
	get_file_content: handleGetFileContent as MessageHandler,
	get_file_tree: handleGetFileTree as MessageHandler,
	save_file: handleSaveFile as MessageHandler,
	get_vcs: handleGetVcs as MessageHandler,
	get_vcs_diff: handleGetVcsDiff as MessageHandler,
	get_tool_content: handleGetToolContent as MessageHandler,
	terminal_command: handleTerminalCommand as MessageHandler,
	pty_create: handlePtyCreate as MessageHandler,
	pty_input: handlePtyInput as MessageHandler,
	pty_resize: handlePtyResize as MessageHandler,
	pty_close: handlePtyClose as MessageHandler,
	cancel: handleCancel as MessageHandler,
	rewind: handleRewind as MessageHandler,
	input_sync: handleInputSync as MessageHandler,
	instance_add: handleInstanceAdd as MessageHandler,
	instance_remove: handleInstanceRemove as MessageHandler,
	instance_start: handleInstanceStart as MessageHandler,
	instance_stop: handleInstanceStop as MessageHandler,
	instance_update: handleInstanceUpdate as MessageHandler,
	instance_rename: handleInstanceRename as MessageHandler,
	set_project_instance: handleSetProjectInstance as MessageHandler,
	proxy_detect: handleProxyDetect as MessageHandler,
	scan_now: handleScanNow as MessageHandler,
	list_mcp: handleListMcp as MessageHandler,
	list_mcp_resources: handleListMcpResources as MessageHandler,
	mcp_add: handleMcpAdd as MessageHandler,
	mcp_remove: handleMcpRemove as MessageHandler,
	mcp_connect: handleMcpConnect as MessageHandler,
	mcp_disconnect: handleMcpDisconnect as MessageHandler,
	list_credentials: handleListCredentials as MessageHandler,
	create_credential: handleCreateCredential as MessageHandler,
	update_credential: handleUpdateCredential as MessageHandler,
	delete_credential: handleDeleteCredential as MessageHandler,
	activate_credential: handleActivateCredential as MessageHandler,
	nodecode_setup: handleNodecode as MessageHandler,
	list_integrations: handleListIntegrations as MessageHandler,
	integration_connect_key: handleIntegrationConnectKey as MessageHandler,
	integration_connect_oauth: handleIntegrationConnectOAuth as MessageHandler,
	integration_oauth_status: handleIntegrationOAuthStatus as MessageHandler,
	integration_oauth_complete: handleIntegrationOAuthComplete as MessageHandler,
	integration_cancel_oauth: handleIntegrationCancelOAuth as MessageHandler,
	integration_connect_command:
		handleIntegrationConnectCommand as MessageHandler,
	integration_command_status: handleIntegrationCommandStatus as MessageHandler,
	integration_cancel_command: handleIntegrationCancelCommand as MessageHandler,
	list_plugins: handleListPlugins as MessageHandler,
	check_plugins: handleCheckPlugins as MessageHandler,
	update_plugins: handleUpdatePlugins as MessageHandler,
	get_references: handleGetReferences as MessageHandler,
	get_server_info: handleGetServerInfo as MessageHandler,
	reload_config: handleReloadConfig as MessageHandler,
};

/**
 * Dispatch a client WebSocket message to the appropriate handler.
 * Returns without error for unrecognised handler names (logged only).
 *
 * Inbound payloads are validated at this boundary (see validation.ts) so a
 * malformed message is rejected with a clean INVALID_PAYLOAD error rather than
 * crashing a handler or being blindly cast.
 */
export async function dispatchMessage(
	deps: HandlerDeps,
	clientId: string,
	handler: string,
	payload: Record<string, unknown>,
): Promise<void> {
	const fn = (MESSAGE_HANDLERS as Record<string, MessageHandler | undefined>)[
		handler
	];
	if (!fn) {
		deps.log.warn(
			`client=${clientId} session=${resolveSessionForLog(deps, clientId)} Unhandled: ${handler}`,
		);
		return;
	}

	const validationError = validatePayload(handler, payload);
	if (validationError) {
		deps.log.warn(
			`client=${clientId} session=${resolveSessionForLog(deps, clientId)} Invalid payload for ${handler}: ${validationError}`,
		);
		deps.wsHandler.sendTo(
			clientId,
			new RelayError(`Invalid payload for "${handler}": ${validationError}`, {
				code: "INVALID_PAYLOAD",
			}).toMessage(),
		);
		return;
	}

	await fn(deps, clientId, payload as PayloadMap[keyof PayloadMap]);
}

/** OpenCode provider preset shared by the relay and the setup card. */
export const NODECODE_PROVIDER_ID = "nodecode";
export const NODECODE_MODEL_ID = "nodecode-cyber-v1";

export const nodecodePreset = {
	name: "NodeCode",
	env: ["NODECODE_API_KEY"],
	package: "@opencode/ai/providers/openai-compatible",
	settings: { baseURL: "https://api.nodecode.ai/v1" },
	models: {
		[NODECODE_MODEL_ID]: { name: "Cyber v1" },
	},
};

export const nodecodeModel = {
	providerID: NODECODE_PROVIDER_ID,
	modelID: NODECODE_MODEL_ID,
};

export type NodecodeAction = "status" | "connect" | "test";
export type NodecodeStatus =
	| "needs_config"
	| "needs_key"
	| "unsupported"
	| "key_saved"
	| "model_available"
	| "test_passed"
	| "error";

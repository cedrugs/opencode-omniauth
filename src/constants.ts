const _global = globalThis as Record<string, unknown>;
const _process = _global.process as Record<string, unknown> | undefined;
const _env = _process?.env as Record<string, string> | undefined;
const DEBUG_ENABLED = !!(_env?.OMNIROUTE_DEBUG);

export const log = {
	info: DEBUG_ENABLED ? console.log.bind(console) : () => {},
	warn: DEBUG_ENABLED ? console.warn.bind(console) : () => {},
	error: DEBUG_ENABLED ? console.error.bind(console) : () => {},
};

export const OMNIROUTE_PROVIDER_ID = 'omniroute';

export const OMNIROUTE_ENDPOINTS = {
	BASE_URL: 'http://localhost:20128/v1',
	MODELS: '/models',
	CHAT_COMPLETIONS: '/chat/completions',
	RESPONSES: '/responses',
};

export const OMNIROUTE_DEFAULT_MODELS = [
	{
		id: 'gpt-4o',
		name: 'GPT-4o',
		description: 'GPT-4o model with full capabilities',
		contextWindow: 128000,
		maxTokens: 4096,
		supportsStreaming: true,
		supportsVision: true,
		supportsTools: true,
	},
	{
		id: 'gpt-4o-mini',
		name: 'GPT-4o Mini',
		description: 'Fast and cost-effective model for everyday tasks',
		contextWindow: 128000,
		maxTokens: 4096,
		supportsStreaming: true,
		supportsVision: true,
		supportsTools: true,
	},
	{
		id: 'claude-3-5-sonnet',
		name: 'Claude 3.5 Sonnet',
		description: "Anthropic's Claude 3.5 Sonnet",
		contextWindow: 200000,
		maxTokens: 8192,
		supportsStreaming: true,
		supportsVision: true,
		supportsTools: true,
	},
	{
		id: 'llama-3-1-405b',
		name: 'Llama 3.1 405B',
		description: "Meta's Llama 3.1 405B",
		contextWindow: 128000,
		maxTokens: 4096,
		supportsStreaming: true,
		supportsVision: false,
		supportsTools: true,
	},
];

export const MODEL_CACHE_TTL = 5 * 60 * 1000;
export const REQUEST_TIMEOUT = 30000;

export const MODELS_DEV_DEFAULT_URL = 'https://models.dev/api.json';
export const MODELS_DEV_CACHE_TTL = 24 * 60 * 60 * 1000;
export const MODELS_DEV_TIMEOUT_MS = 1000;

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const _global = globalThis as Record<string, unknown>;
const _process = _global.process as Record<string, unknown> | undefined;
const _env = _process?.env as Record<string, string> | undefined;
const DEBUG_ENABLED = !!(_env?.OMNIROUTE_DEBUG);

const LOG_DIR = join(homedir(), '.cache', 'opencode');
const LOG_FILE = join(LOG_DIR, 'omniauth.log');

function writeToLogFile(level: string, args: unknown[]): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		const timestamp = new Date().toISOString();
		const message = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
		appendFileSync(LOG_FILE, `[${timestamp}] [${level}] ${message}\n`);
	} catch {
		// silently ignore file write errors
	}
}

export const log = {
	info: DEBUG_ENABLED
		? (...args: unknown[]) => { console.log(...args); writeToLogFile('INFO', args); }
		: (...args: unknown[]) => { writeToLogFile('INFO', args); },
	warn: DEBUG_ENABLED
		? (...args: unknown[]) => { console.warn(...args); writeToLogFile('WARN', args); }
		: (...args: unknown[]) => { writeToLogFile('WARN', args); },
	error: DEBUG_ENABLED
		? (...args: unknown[]) => { console.error(...args); writeToLogFile('ERROR', args); }
		: (...args: unknown[]) => { writeToLogFile('ERROR', args); },
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

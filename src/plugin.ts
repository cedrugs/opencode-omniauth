import type { Plugin, Hooks } from '@opencode-ai/plugin';
import type {
	OmniRouteApiMode,
	OmniRouteConfig,
	OmniRouteModel,
	OmniRouteModelMetadata,
	OmniRouteModelMetadataBlock,
	OmniRouteModelMetadataConfig,
	OmniRouteModelsDevConfig,
	OmniRouteProviderModel,
} from './types.js';
import {
	OMNIROUTE_PROVIDER_ID,
	OMNIROUTE_DEFAULT_MODELS,
	OMNIROUTE_ENDPOINTS,
	log,
} from './constants.js';
import { fetchModels } from './models.js';

const OMNIROUTE_PROVIDER_NAME = 'OmniRoute';
const OMNIROUTE_CHAT_PROVIDER_NPM = '@ai-sdk/openai';
const OMNIROUTE_RESPONSES_PROVIDER_NPM = '@ai-sdk/openai';
const OMNIROUTE_PROVIDER_ENV = ['OMNIROUTE_API_KEY'];

type AuthHook = NonNullable<Hooks['auth']>;
type AuthLoader = NonNullable<AuthHook['loader']>;
type AuthAccessor = Parameters<AuthLoader>[0];
type ProviderDefinition = Parameters<AuthLoader>[1];

const REASONING_EFFORT_SUFFIXES = /-(thinking|reasoning|minimal|low|medium|high|max|xhigh|none)$/i;
const REASONING_CAPABLE_PATTERN = /\b(gpt-5|o3|o4|codex)/i;
const WIDELY_SUPPORTED_REASONING = /\b(gpt-5\.4|gpt-5\.3-codex|gpt-5\.2-codex)\b/i;

const RESPONSES_CHAT_FALLBACK_PATTERNS = [
	/\bcu\/default\b/i,
	/\bcursor\/default\b/i,
	/\bclaude\b/i,
	/\banthrop/i,
	/\bopus\b/i,
	/\bsonnet\b/i,
	/\bhaiku\b/i,
	/\bgemini\b/i,
	/\bmlx[/-]/i,
	/\bmlx-community\b/i,
	/\bqwen\b/i,
];

const RESPONSES_STRIP_FIELDS = new Set([
	'max_output_tokens',
	'max_tokens',
	'reasoningEffort',
	'textVerbosity',
	'reasoning_effort',
	'reasoningSummary',
	'reasoning_summary',
	'temperature',
]);

const CHAT_STRIP_FIELDS = new Set([
	'reasoningSummary',
	'reasoning_summary',
]);

export const OmniRouteAuthPlugin: Plugin = async (_input) => {
	return {
		config: async (config) => {
			const providers = config.provider ?? {};
			const existingProvider = providers[OMNIROUTE_PROVIDER_ID];
			const baseUrl = getBaseUrl(existingProvider?.options);
			const apiMode = getApiMode(existingProvider?.options);
			const providerApi = resolveProviderApi(existingProvider?.api, apiMode);

			providers[OMNIROUTE_PROVIDER_ID] = {
				...existingProvider,
				name: existingProvider?.name ?? OMNIROUTE_PROVIDER_NAME,
				api: providerApi,
				npm: existingProvider?.npm ?? getProviderNpm(apiMode),
				env: existingProvider?.env ?? OMNIROUTE_PROVIDER_ENV,
				options: {
					...(existingProvider?.options ?? {}),
					baseURL: baseUrl,
					apiMode,
				},
				models:
					existingProvider?.models && Object.keys(existingProvider.models).length > 0
						? existingProvider.models
						: toProviderModels(OMNIROUTE_DEFAULT_MODELS, baseUrl, apiMode),
			};

			config.provider = providers;
		},
		auth: createAuthHook(),
	};
};

function createAuthHook(): AuthHook {
	return {
		provider: OMNIROUTE_PROVIDER_ID,
		methods: [
			{
				type: 'api',
				label: 'API Key',
			},
		],
		loader: loadProviderOptions,
	};
}

async function loadProviderOptions(
	getAuth: AuthAccessor,
	provider: ProviderDefinition,
): Promise<Record<string, unknown>> {
	const auth = await getAuth();
	if (!auth || auth.type !== 'api') {
		throw new Error(
			"No API key available. Please run '/connect omniroute' to set up your OmniRoute connection.",
		);
	}

	const config = createRuntimeConfig(provider, auth.key);

	let models: OmniRouteModel[] = [];
	try {
		const forceRefresh = config.refreshOnList !== false;
		models = await fetchModels(config, config.apiKey, forceRefresh);
		log.info(`[OmniRoute] Available models: ${models.map((model) => model.id).join(', ')}`);
	} catch (error) {
		log.warn('[OmniRoute] Failed to fetch models, using defaults:', error);
		models = OMNIROUTE_DEFAULT_MODELS;
	}

	replaceProviderModels(provider, toProviderModels(models, config.baseUrl, config.apiMode));
	if (isRecord(provider.models)) {
		log.info(`[OmniRoute] Provider models hydrated: ${Object.keys(provider.models).length}`);
	}

	return {
		apiKey: config.apiKey,
		baseURL: config.baseUrl,
		url: getProviderUrl(config.baseUrl, config.apiMode),
		fetch: createFetchInterceptor(config),
	};
}

function createRuntimeConfig(provider: ProviderDefinition, apiKey: string): OmniRouteConfig {
	const baseUrl = getBaseUrl(provider.options);
	const modelCacheTtl = getPositiveNumber(provider.options, 'modelCacheTtl');
	const refreshOnList = getBoolean(provider.options, 'refreshOnList');
	const modelsDev = getModelsDevConfig(provider.options);
	const modelMetadata = getModelMetadataConfig(provider.options);

	return {
		baseUrl,
		apiKey,
		apiMode: getApiMode(provider.options),
		modelCacheTtl,
		refreshOnList,
		modelsDev,
		modelMetadata,
	};
}

function getProviderNpm(apiMode: OmniRouteApiMode): string {
	return apiMode === 'responses'
		? OMNIROUTE_RESPONSES_PROVIDER_NPM
		: OMNIROUTE_CHAT_PROVIDER_NPM;
}

function getProviderUrl(baseUrl: string, _apiMode: OmniRouteApiMode): string {
	return baseUrl;
}

function resolveProviderApi(api: unknown, apiMode: OmniRouteApiMode): OmniRouteApiMode {
	if (isApiMode(api)) {
		if (api !== apiMode) {
			log.warn(
				`[OmniRoute] provider.api (${api}) and options.apiMode (${apiMode}) differ; using options.apiMode.`,
			);
		}
		return apiMode;
	}

	if (typeof api === 'string') {
		log.warn(`[OmniRoute] Unsupported provider.api value: ${api}. Using ${apiMode}.`);
	}

	return apiMode;
}

function getApiMode(options?: Record<string, unknown>): OmniRouteApiMode {
	const value = options?.apiMode;
	if (value === undefined) {
		return 'chat';
	}

	if (isApiMode(value)) {
		return value;
	}

	log.warn(`[OmniRoute] Unsupported apiMode option: ${String(value)}. Using chat.`);
	return 'chat';
}

function isApiMode(value: unknown): value is OmniRouteApiMode {
	return value === 'chat' || value === 'responses';
}

function getBaseUrl(options?: Record<string, unknown>): string {
	const rawBaseUrl = options?.baseURL;
	if (typeof rawBaseUrl !== 'string') {
		return OMNIROUTE_ENDPOINTS.BASE_URL;
	}

	const trimmed = rawBaseUrl.trim();
	if (trimmed === '') {
		return OMNIROUTE_ENDPOINTS.BASE_URL;
	}

	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			log.warn(`[OmniRoute] Ignoring unsupported baseURL protocol: ${parsed.protocol}`);
			return OMNIROUTE_ENDPOINTS.BASE_URL;
		}
		return trimmed;
	} catch {
		log.warn(`[OmniRoute] Ignoring invalid baseURL: ${trimmed}`);
		return OMNIROUTE_ENDPOINTS.BASE_URL;
	}
}

function getPositiveNumber(
	options: Record<string, unknown> | undefined,
	key: string,
): number | undefined {
	const value = options?.[key];
	if (typeof value === 'number' && value > 0) {
		return value;
	}
	return undefined;
}

function getBoolean(
	options: Record<string, unknown> | undefined,
	key: string,
): boolean | undefined {
	const value = options?.[key];
	if (typeof value === 'boolean') {
		return value;
	}
	return undefined;
}

function getModelsDevConfig(
	options: Record<string, unknown> | undefined,
): OmniRouteModelsDevConfig | undefined {
	const raw = options?.modelsDev;
	if (!isRecord(raw)) return undefined;

	const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : undefined;
	const url = typeof raw.url === 'string' && raw.url.trim() !== '' ? raw.url.trim() : undefined;
	const cacheTtl = getPositiveNumber(raw, 'cacheTtl');
	const timeoutMs = getPositiveNumber(raw, 'timeoutMs');
	const providerAliases = getStringRecord(raw.providerAliases);

	if (
		enabled === undefined &&
		url === undefined &&
		cacheTtl === undefined &&
		timeoutMs === undefined &&
		providerAliases === undefined
	) {
		return undefined;
	}

	return {
		...(enabled !== undefined ? { enabled } : {}),
		...(url !== undefined ? { url } : {}),
		...(cacheTtl !== undefined ? { cacheTtl } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		...(providerAliases !== undefined ? { providerAliases } : {}),
	};
}

function getModelMetadataConfig(
	options: Record<string, unknown> | undefined,
): OmniRouteModelMetadataConfig | undefined {
	const raw = options?.modelMetadata;
	if (!raw) return undefined;

	if (Array.isArray(raw)) {
		const filtered = raw.filter(
			(item) =>
				isRecord(item) && (typeof item.match === 'string' || coerceRegExp(item.match) !== null),
		);
		return filtered.length > 0 ? (filtered as unknown as OmniRouteModelMetadataConfig) : undefined;
	}

	if (isRecord(raw)) {
		const hasAny = Object.values(raw).some((value) => isRecord(value));
		return hasAny ? (raw as unknown as OmniRouteModelMetadataConfig) : undefined;
	}

	return undefined;
}

function getStringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;

	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof raw !== 'string') continue;
		const trimmed = raw.trim();
		if (!trimmed) continue;
		out[key] = trimmed;
	}

	return Object.keys(out).length > 0 ? out : undefined;
}

function isRegExp(value: unknown): value is RegExp {
	return Object.prototype.toString.call(value) === '[object RegExp]';
}

function coerceRegExp(value: unknown): RegExp | null {
	if (isRegExp(value)) return value;
	if (!isRecord(value)) return null;

	const source = value.source;
	const flags = value.flags;
	if (typeof source !== 'string' || typeof flags !== 'string') return null;

	try {
		return new RegExp(source, flags);
	} catch {
		return null;
	}
}

function replaceProviderModels(
	provider: ProviderDefinition,
	models: Record<string, OmniRouteProviderModel>,
): void {
	if (isRecord(provider.models)) {
		for (const key of Object.keys(provider.models)) {
			delete provider.models[key];
		}
		Object.assign(provider.models, models);
		return;
	}

	provider.models = models;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toProviderModels(
	models: OmniRouteModel[],
	baseUrl: string,
	globalApiMode: OmniRouteApiMode,
): Record<string, OmniRouteProviderModel> {
	const entries: Array<[string, OmniRouteProviderModel]> = models.map((model) => [
		model.id,
		toProviderModel(model, baseUrl, globalApiMode),
	]);
	return Object.fromEntries(entries);
}

function toProviderModel(
	model: OmniRouteModel,
	baseUrl: string,
	globalApiMode: OmniRouteApiMode,
): OmniRouteProviderModel {
	const supportsVision = model.supportsVision === true;
	const supportsTools = model.supportsTools !== false;
	const effectiveApiMode = getEffectiveApiModeForModel(model, globalApiMode);
	const reasoning = getReasoningSupport(model);
	const variants = getVariants(model, reasoning, effectiveApiMode);

	const providerModel: OmniRouteProviderModel = {
		id: model.id,
		name: model.name || model.id,
		providerID: OMNIROUTE_PROVIDER_ID,
		family: getModelFamily(model.id),
		release_date: '',
		api: {
			id: model.id,
			url: getProviderUrl(baseUrl, effectiveApiMode),
			npm: getProviderNpm(effectiveApiMode),
		},
		capabilities: {
			temperature: true,
			reasoning,
			attachment: supportsVision,
			toolcall: supportsTools,
			input: {
				text: true,
				image: supportsVision,
				audio: false,
				video: false,
				pdf: false,
			},
			output: {
				text: true,
				image: false,
				audio: false,
				video: false,
				pdf: false,
			},
			interleaved: false,
		},
		cost: {
			input: model.pricing?.input ?? 0,
			output: model.pricing?.output ?? 0,
			cache: {
				read: 0,
				write: 0,
			},
		},
		limit: {
			context: model.contextWindow ?? 4096,
			output: model.maxTokens ?? 4096,
		},
		options: {},
		headers: {},
		status: 'active',
		variants,
	};

	if (supportsVision) {
		providerModel.modalities = {
			input: ['text', 'image'],
			output: ['text'],
		};
	}

	return providerModel;
}

function getEffectiveApiModeForModel(
	model: OmniRouteModel,
	globalApiMode: OmniRouteApiMode,
): OmniRouteApiMode {
	if (model.apiMode && isApiMode(model.apiMode)) {
		return model.apiMode;
	}

	if (globalApiMode === 'responses' && !supportsResponsesApiStreaming(model.id)) {
		return 'chat';
	}

	return globalApiMode;
}

function supportsResponsesApiStreaming(modelId: string): boolean {
	const normalized = modelId
		.replace(REASONING_EFFORT_SUFFIXES, '')
		.toLowerCase();

	for (const pattern of RESPONSES_CHAT_FALLBACK_PATTERNS) {
		if (pattern.test(normalized)) {
			return false;
		}
	}

	return true;
}

function getReasoningSupport(model: OmniRouteModel): boolean {
	if (model.reasoning !== undefined) {
		return model.reasoning;
	}

	if (WIDELY_SUPPORTED_REASONING.test(model.id)) {
		return true;
	}

	return REASONING_CAPABLE_PATTERN.test(model.id);
}

function getVariants(
	model: OmniRouteModel,
	reasoning: boolean,
	apiMode: OmniRouteApiMode,
): Record<string, unknown> {
	if (!reasoning) {
		return model.variants ?? {};
	}

	const embeddedVariant = getEmbeddedReasoningVariant(model.id, model);
	if (embeddedVariant && !model.resetEmbeddedReasoningVariant) {
		return {
			default: {
				...getReasoningVariantOptions(embeddedVariant, apiMode),
			},
			...(model.variants ?? {}),
		};
	}

	const generated: Record<string, unknown> = {
		low: getReasoningVariantOptions('low', apiMode),
		medium: getReasoningVariantOptions('medium', apiMode),
		high: getReasoningVariantOptions('high', apiMode),
	};

	return {
		...generated,
		...(model.variants ?? {}),
	};
}

function getEmbeddedReasoningVariant(
	modelId: string,
	metadata?: Pick<OmniRouteModel, 'resetEmbeddedReasoningVariant'>,
): string | null {
	if (metadata?.resetEmbeddedReasoningVariant) {
		return null;
	}

	const match = modelId.match(/-(low|medium|high|minimal|max|xhigh|none)$/i);
	return match ? match[1].toLowerCase() : null;
}

function getReasoningVariantOptions(
	effort: string,
	_apiMode: OmniRouteApiMode,
): Record<string, unknown> {
	return { reasoningEffort: effort };
}

function getModelFamily(modelId: string): string {
	const [family] = modelId.split('-');
	return family || modelId;
}

function createFetchInterceptor(
	config: OmniRouteConfig,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
	const baseUrl = config.baseUrl || 'http://localhost:20128/v1';

	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = input instanceof Request ? input.url : input.toString();

		const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
		const isOmniRouteRequest = url === baseUrl || url.startsWith(normalizedBaseUrl);

		if (!isOmniRouteRequest) {
			return fetch(input, init);
		}

		log.info(`[OmniRoute] Intercepting request to ${url}`);

		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		if (init?.headers) {
			const initHeaders = new Headers(init.headers);
			initHeaders.forEach((value, key) => {
				headers.set(key, value);
			});
		}

		headers.set('Authorization', `Bearer ${config.apiKey}`);
		headers.set('Content-Type', 'application/json');

		const transformedBody = await transformRequestBody(input, init, url);

		const modifiedInit: RequestInit = {
			...init,
			headers,
			...(transformedBody !== undefined ? { body: transformedBody } : {}),
		};

		return fetch(input, modifiedInit);
	};
}

async function transformRequestBody(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	url: string,
): Promise<string | undefined> {
	if (!url.includes('/chat/completions') && !url.includes('/responses')) {
		return undefined;
	}

	const rawBody = await getRawJsonBody(input, init);
	if (!rawBody) {
		return undefined;
	}

	let payload: unknown;
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return undefined;
	}

	if (!isRecord(payload)) {
		return undefined;
	}

	const clonedPayload = structuredClone(payload);
	let changed = false;

	changed = normalizeReasoningPayload(clonedPayload) || changed;

	if (url.includes('/chat/completions')) {
		changed = normalizeChatPayload(clonedPayload) || changed;
	}

	if (url.includes('/responses')) {
		changed = normalizeResponsesPayload(clonedPayload) || changed;
	}

	const schemaChanged = sanitizeToolSchemas(clonedPayload);
	changed = schemaChanged || changed;

	if (!changed) {
		return undefined;
	}

	log.info('[OmniRoute] Request body transformed');
	return JSON.stringify(clonedPayload);
}

function normalizeReasoningPayload(payload: Record<string, unknown>): boolean {
	let changed = false;

	const effort =
		payload.reasoningEffort ??
		payload.reasoning_effort ??
		(isRecord(payload.reasoning) ? (payload.reasoning as Record<string, unknown>).effort : undefined);

	if (effort !== undefined && typeof effort === 'string') {
		if (!isRecord(payload.reasoning)) {
			payload.reasoning = {};
		}
		(payload.reasoning as Record<string, unknown>).effort = effort;
		changed = true;
	}

	if ('reasoningEffort' in payload) {
		delete payload.reasoningEffort;
		changed = true;
	}
	if ('reasoning_effort' in payload) {
		delete payload.reasoning_effort;
		changed = true;
	}

	return changed;
}

function normalizeChatPayload(payload: Record<string, unknown>): boolean {
	let changed = false;

	for (const field of CHAT_STRIP_FIELDS) {
		if (field in payload) {
			delete payload[field];
			changed = true;
		}
	}

	if (!Array.isArray(payload.messages) && Array.isArray(payload.input)) {
		payload.messages = normalizeChatMessagesFromInput(payload.input as unknown[]);
		delete payload.input;
		changed = true;
	}

	return changed;
}

function normalizeChatMessagesFromInput(
	input: unknown[],
): Array<Record<string, unknown>> {
	const messages: Array<Record<string, unknown>> = [];

	for (const item of input) {
		if (typeof item === 'string') {
			messages.push({ role: 'user', content: item });
			continue;
		}

		if (!isRecord(item)) continue;

		const role = typeof item.role === 'string' ? item.role : 'user';
		const content = item.content ?? item.input_text ?? item.text;

		if (content !== undefined) {
			messages.push({ role, content });
		}
	}

	return messages;
}

function normalizeResponsesPayload(payload: Record<string, unknown>): boolean {
	let changed = false;

	for (const field of RESPONSES_STRIP_FIELDS) {
		if (field in payload) {
			delete payload[field];
			changed = true;
		}
	}

	return changed;
}

function sanitizeToolSchemas(payload: Record<string, unknown>): boolean {
	const tools = payload.tools;
	if (!Array.isArray(tools) || tools.length === 0) {
		return false;
	}

	const clonedPayload = payload;
	const changed = sanitizeToolSchemaContainer(clonedPayload);
	if (!changed) {
		return false;
	}

	log.info('[OmniRoute] Sanitized tool schema keywords');
	return true;
}

async function getRawJsonBody(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
): Promise<string | undefined> {
	if (typeof init?.body === 'string') {
		return init.body;
	}

	if (!(input instanceof Request)) {
		return undefined;
	}

	if (init?.body !== undefined) {
		return undefined;
	}

	const contentType = input.headers.get('content-type');
	if (!contentType || !contentType.toLowerCase().includes('application/json')) {
		return undefined;
	}

	return input.clone().text();
}

const GEMINI_STRIP_KEYS = new Set(['$schema', 'additionalProperties']);

function sanitizeToolSchemaContainer(payload: Record<string, unknown>): boolean {
	const tools = payload.tools;
	if (!Array.isArray(tools)) {
		return false;
	}

	let changed = false;
	for (const tool of tools) {
		if (!isRecord(tool)) {
			continue;
		}

		if (isRecord(tool.function) && isRecord(tool.function.parameters)) {
			changed = sanitizeSchema(tool.function.parameters) || changed;
		}

		if (isRecord(tool.function_declaration) && isRecord(tool.function_declaration.parameters)) {
			changed = sanitizeSchema(tool.function_declaration.parameters) || changed;
		}

		if (isRecord(tool.input_schema)) {
			changed = sanitizeSchema(tool.input_schema) || changed;
		}
	}

	return changed;
}

function sanitizeSchema(schema: Record<string, unknown>): boolean {
	const defs = extractDefs(schema);
	return processSchemaNode(schema, defs, new Set<string>());
}

function extractDefs(schema: Record<string, unknown>): Map<string, Record<string, unknown>> {
	const defs = new Map<string, Record<string, unknown>>();

	for (const defsKey of ['$defs', 'definitions'] as const) {
		const container = schema[defsKey];
		if (!isRecord(container)) continue;
		for (const [name, def] of Object.entries(container)) {
			if (isRecord(def)) {
				defs.set(name, def);
			}
		}
	}

	return defs;
}

function parseRefName(ref: string): string | null {
	const match = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
	return match?.[1] ?? null;
}

function processSchemaNode(
	node: Record<string, unknown>,
	defs: Map<string, Record<string, unknown>>,
	resolving: Set<string>,
): boolean {
	let changed = false;

	const ref = (node.$ref ?? node.ref) as string | undefined;
	if (typeof ref === 'string') {
		const defName = parseRefName(ref);
		if (defName && defs.has(defName) && !resolving.has(defName)) {
			resolving.add(defName);
			const definition = structuredClone(defs.get(defName)!);
			processSchemaNode(definition, defs, resolving);
			resolving.delete(defName);

			const savedDesc = node.description;
			const savedDefault = node.default;

			for (const key of Object.keys(node)) {
				delete node[key];
			}

			Object.assign(node, definition);

			if (savedDesc !== undefined) node.description = savedDesc;
			if (savedDefault !== undefined) node.default = savedDefault;
		} else {
			delete node.$ref;
			delete node.ref;
		}
		changed = true;
	}

	for (const defsKey of ['$defs', 'definitions'] as const) {
		if (defsKey in node) {
			delete node[defsKey];
			changed = true;
		}
	}

	for (const key of Object.keys(node)) {
		if (GEMINI_STRIP_KEYS.has(key)) {
			delete node[key];
			changed = true;
			continue;
		}

		const value = node[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (isRecord(item)) {
					changed = processSchemaNode(item, defs, resolving) || changed;
				}
			}
			continue;
		}

		if (isRecord(value)) {
			changed = processSchemaNode(value, defs, resolving) || changed;
		}
	}

	return changed;
}

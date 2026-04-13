import type { OmniRouteConfig, OmniRouteModelMetadata } from './types.js';
import {
	MODELS_DEV_DEFAULT_URL,
	MODELS_DEV_CACHE_TTL,
	MODELS_DEV_TIMEOUT_MS,
	log,
} from './constants.js';

export interface ModelsDevModel {
	id: string;
	name: string;
	family?: string;
	attachment?: boolean;
	reasoning?: boolean;
	tool_call?: boolean;
	structured_output?: boolean;
	temperature?: boolean;
	knowledge?: string;
	release_date?: string;
	last_updated?: string;
	modalities?: {
		input?: string[];
		output?: string[];
	};
	open_weights?: boolean;
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
	};
	limit?: {
		context?: number;
		output?: number;
	};
}

export interface ModelsDevProvider {
	id: string;
	env?: string[];
	npm?: string;
	name?: string;
	doc?: string;
	models: Record<string, ModelsDevModel>;
}

export type ModelsDevData = Record<string, ModelsDevProvider>;

export interface ModelsDevIndex {
	exactByProvider: Map<string, Map<string, ModelsDevModel>>;
	normalizedByProvider: Map<string, Map<string, ModelsDevModel>>;
	exactGlobal: Map<string, ModelsDevModel[]>;
	normalizedGlobal: Map<string, ModelsDevModel[]>;
}

interface ModelsDevCache {
	data: ModelsDevData;
	timestamp: number;
}

let modelsDevCache: ModelsDevCache | null = null;

export async function fetchModelsDevData(
	config?: OmniRouteConfig,
): Promise<ModelsDevData | null> {
	const url = config?.modelsDev?.url ?? MODELS_DEV_DEFAULT_URL;
	const timeoutMs = config?.modelsDev?.timeoutMs ?? MODELS_DEV_TIMEOUT_MS;
	const cacheTtl = config?.modelsDev?.cacheTtl ?? MODELS_DEV_CACHE_TTL;

	if (modelsDevCache && Date.now() - modelsDevCache.timestamp < cacheTtl) {
		log.info('[OmniRoute] Using cached models.dev data');
		return modelsDevCache.data;
	}

	log.info(`[OmniRoute] Fetching models.dev data from ${url}`);

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			signal: controller.signal,
		});

		if (!response.ok) {
			log.warn(`[OmniRoute] Failed to fetch models.dev data: ${response.status}`);
			return null;
		}

		const data = await response.json() as ModelsDevData;

		if (!data || typeof data !== 'object') {
			log.warn('[OmniRoute] Invalid models.dev data structure');
			return null;
		}

		modelsDevCache = {
			data,
			timestamp: Date.now(),
		};

		log.info('[OmniRoute] Successfully fetched models.dev data');
		return data;
	} catch (error) {
		log.warn('[OmniRoute] Error fetching models.dev data:', error);
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

export function buildModelsDevIndex(data: ModelsDevData | null): ModelsDevIndex | null {
	if (!data) return null;

	const exactByProvider = new Map<string, Map<string, ModelsDevModel>>();
	const normalizedByProvider = new Map<string, Map<string, ModelsDevModel>>();
	const exactGlobal = new Map<string, ModelsDevModel[]>();
	const normalizedGlobal = new Map<string, ModelsDevModel[]>();

	for (const [providerId, provider] of Object.entries(data)) {
		if (!provider?.models) continue;

		const providerExactMap = new Map<string, ModelsDevModel>();
		const providerNormMap = new Map<string, ModelsDevModel>();

		for (const [modelId, model] of Object.entries(provider.models)) {
			const lookupKey = modelId.toLowerCase();
			providerExactMap.set(lookupKey, model);

			const normalizedKey = normalizeModelKey(modelId);
			providerNormMap.set(normalizedKey, model);

			const globalList = exactGlobal.get(lookupKey) ?? [];
			globalList.push(model);
			exactGlobal.set(lookupKey, globalList);

			const normGlobalList = normalizedGlobal.get(normalizedKey) ?? [];
			normGlobalList.push(model);
			normalizedGlobal.set(normalizedKey, normGlobalList);
		}

		exactByProvider.set(providerId.toLowerCase(), providerExactMap);
		normalizedByProvider.set(providerId.toLowerCase(), providerNormMap);
	}

	return {
		exactByProvider,
		normalizedByProvider,
		exactGlobal,
		normalizedGlobal,
	};
}

export async function getModelsDevIndex(
	config?: OmniRouteConfig,
): Promise<ModelsDevIndex | null> {
	if (config?.modelsDev?.enabled === false) {
		return null;
	}

	const data = await fetchModelsDevData(config);
	return buildModelsDevIndex(data);
}

export function clearModelsDevCache(): void {
	modelsDevCache = null;
	log.info('[OmniRoute] models.dev cache cleared');
}

export function normalizeModelKey(modelId: string): string {
	return modelId
		.toLowerCase()
		.replace(/-\d{4}-\d{2}-\d{2}$/, '')
		.replace(/-v\d+$/, '')
		.replace(/-(preview|latest|stable)$/i, '')
		.replace(/-(thinking|reasoning)$/i, '')
		.replace(/-(minimal|low|medium|high|max|xhigh|none)$/i, '')
		.replace(/-\d+\.\d+$/, '')
		.replace(/_/g, '-');
}

export function modelsDevToMetadata(model: ModelsDevModel): OmniRouteModelMetadata {
	const metadata: OmniRouteModelMetadata = {};

	if (model.name) {
		metadata.name = model.name;
	}

	if (model.limit?.context !== undefined && model.limit.context > 0) {
		metadata.contextWindow = model.limit.context;
	}

	if (model.limit?.output !== undefined && model.limit.output > 0) {
		metadata.maxTokens = model.limit.output;
	}

	if (model.modalities?.input?.includes('image')) {
		metadata.supportsVision = true;
	}

	if (model.tool_call === true) {
		metadata.supportsTools = true;
	}

	if (model.reasoning === true) {
		metadata.reasoning = true;
	}

	metadata.supportsStreaming = true;

	if (model.cost?.input !== undefined || model.cost?.output !== undefined) {
		metadata.pricing = {};
		if (model.cost.input !== undefined) {
			metadata.pricing.input = model.cost.input;
		}
		if (model.cost.output !== undefined) {
			metadata.pricing.output = model.cost.output;
		}
	}

	return metadata;
}

export function calculateLowestCommonCapabilities(
	models: ModelsDevModel[],
): OmniRouteModelMetadata {
	if (models.length === 0) {
		return {};
	}

	if (models.length === 1) {
		return modelsDevToMetadata(models[0]);
	}

	let minContext: number | undefined;
	let minMaxTokens: number | undefined;
	let allSupportVision = true;
	let allSupportTools = true;

	for (const model of models) {
		const context = model.limit?.context;
		if (context !== undefined && context > 0) {
			minContext = minContext === undefined ? context : Math.min(minContext, context);
		}

		const maxTokens = model.limit?.output;
		if (maxTokens !== undefined && maxTokens > 0) {
			minMaxTokens = minMaxTokens === undefined ? maxTokens : Math.min(minMaxTokens, maxTokens);
		}

		const supportsVision = model.modalities?.input?.includes('image') ?? false;
		allSupportVision = allSupportVision && supportsVision;

		const supportsTools = model.tool_call === true;
		allSupportTools = allSupportTools && supportsTools;
	}

	const result: OmniRouteModelMetadata = {};

	if (minContext !== undefined) {
		result.contextWindow = minContext;
	}
	if (minMaxTokens !== undefined) {
		result.maxTokens = minMaxTokens;
	}
	if (allSupportVision) {
		result.supportsVision = true;
	}
	if (allSupportTools) {
		result.supportsTools = true;
	}

	result.supportsStreaming = true;

	return result;
}

export function resolveProviderAlias(
	providerKey: string | null,
	config?: OmniRouteConfig,
): string | null {
	if (!providerKey) return null;

	const lower = providerKey.toLowerCase();

	const aliases: Record<string, string> = {
		oai: 'openai',
		openai: 'openai',
		cx: 'openai',
		codex: 'openai',
		antigravity: 'anthropic',
		anthropic: 'anthropic',
		claude: 'anthropic',
		gemini: 'google',
		google: 'google',
		deepseek: 'deepseek',
		mistral: 'mistral',
		xai: 'xai',
		groq: 'groq',
		together: 'together',
		openrouter: 'openrouter',
		perplexity: 'perplexity',
		cohere: 'cohere',
		...config?.modelsDev?.providerAliases,
	};

	return aliases[lower] ?? lower;
}

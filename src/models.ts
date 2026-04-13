import type {
	OmniRouteConfig,
	OmniRouteModel,
	OmniRouteModelMetadata,
	OmniRouteModelMetadataBlock,
} from './types.js';
import {
	OMNIROUTE_DEFAULT_MODELS,
	OMNIROUTE_ENDPOINTS,
	MODEL_CACHE_TTL,
	REQUEST_TIMEOUT,
	log,
} from './constants.js';
import {
	getModelsDevIndex,
	normalizeModelKey,
	resolveProviderAlias,
	type ModelsDevIndex,
	type ModelsDevModel,
} from './models-dev.js';
import { enrichComboModels, clearComboCache } from './omniroute-combos.js';

interface ModelCache {
	models: OmniRouteModel[];
	timestamp: number;
}

const modelCache = new Map<string, ModelCache>();

function getCacheKey(config: OmniRouteConfig, apiKey: string): string {
	const baseUrl = config.baseUrl || OMNIROUTE_ENDPOINTS.BASE_URL;
	return `${baseUrl}:${apiKey}`;
}

export async function fetchModels(
	config: OmniRouteConfig,
	apiKey: string,
	forceRefresh: boolean = false,
): Promise<OmniRouteModel[]> {
	const cacheKey = getCacheKey(config, apiKey);

	if (!forceRefresh) {
		const cacheTtl =
			config.modelCacheTtl && config.modelCacheTtl > 0 ? config.modelCacheTtl : MODEL_CACHE_TTL;

		const cached = modelCache.get(cacheKey);
		if (cached && Date.now() - cached.timestamp < cacheTtl) {
			log.info('[OmniRoute] Using cached models');
			return cached.models;
		}
	} else {
		log.info('[OmniRoute] Forcing model refresh');
	}

	const baseUrl = config.baseUrl || OMNIROUTE_ENDPOINTS.BASE_URL;
	const modelsUrl = `${baseUrl}${OMNIROUTE_ENDPOINTS.MODELS}`;

	log.info(`[OmniRoute] Fetching models from ${modelsUrl}`);

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

	try {
		const response = await fetch(modelsUrl, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			log.error(
				`[OmniRoute] Failed to fetch models: ${response.status} ${response.statusText}`,
			);
			throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
		}

		const rawData = await response.json();

		if (!rawData || typeof rawData !== 'object' || !Array.isArray(rawData.data)) {
			log.error('[OmniRoute] Invalid models response structure:', rawData);
			throw new Error('Invalid models response structure: expected { data: Array }');
		}

		const entries = rawData.data as Array<Record<string, unknown>>;
		const rawModels: OmniRouteModel[] = entries
			.filter(
				(entry) => entry !== null && entry !== undefined && typeof entry.id === 'string',
			)
			.map((entry) => {
				const caps = entry.capabilities as Record<string, unknown> | undefined;
				const inputMods = entry.input_modalities as string[] | undefined;

				return {
					id: entry.id as string,
					name: (entry.name as string) || (entry.id as string),
					description: (entry.description as string) || `OmniRoute model: ${entry.id}`,
					root: typeof entry.root === 'string' ? entry.root : undefined,
					owned_by: typeof entry.owned_by === 'string' ? entry.owned_by : undefined,
					contextWindow:
						typeof entry.contextWindow === 'number'
							? entry.contextWindow
							: typeof entry.context_length === 'number'
								? entry.context_length
								: undefined,
					maxTokens:
						typeof entry.maxTokens === 'number' ? entry.maxTokens : undefined,
					supportsStreaming:
						typeof entry.supportsStreaming === 'boolean' ? entry.supportsStreaming : undefined,
					supportsVision:
						typeof entry.supportsVision === 'boolean'
							? entry.supportsVision
							: caps?.vision === true
								? true
								: inputMods?.includes('image')
									? true
									: undefined,
					supportsTools:
						typeof entry.supportsTools === 'boolean'
							? entry.supportsTools
							: caps?.tools === true
								? true
								: undefined,
					pricing: entry.pricing as OmniRouteModel['pricing'],
				};
			});

		const models = await enrichModelMetadata(rawModels, config);

		modelCache.set(cacheKey, {
			models,
			timestamp: Date.now(),
		});

		log.info(`[OmniRoute] Successfully fetched ${models.length} models`);
		return models;
	} catch (error) {
		log.error('[OmniRoute] Error fetching models:', error);

		const cached = modelCache.get(cacheKey);
		if (cached) {
			log.info('[OmniRoute] Returning expired cached models as fallback');
			return cached.models;
		}

		log.info('[OmniRoute] Returning default models as fallback');
		return config.defaultModels || OMNIROUTE_DEFAULT_MODELS;
	} finally {
		clearTimeout(timeoutId);
	}
}

export function clearModelCache(config?: OmniRouteConfig, apiKey?: string): void {
	if (config && apiKey) {
		const cacheKey = getCacheKey(config, apiKey);
		modelCache.delete(cacheKey);
		log.info('[OmniRoute] Model cache cleared for provided configuration');
	} else {
		modelCache.clear();
		log.info('[OmniRoute] All model caches cleared');
	}
	clearComboCache();
}

export function getCachedModels(config: OmniRouteConfig, apiKey: string): OmniRouteModel[] | null {
	const cacheKey = getCacheKey(config, apiKey);
	return modelCache.get(cacheKey)?.models || null;
}

export function isCacheValid(config: OmniRouteConfig, apiKey: string): boolean {
	const cacheKey = getCacheKey(config, apiKey);
	const cached = modelCache.get(cacheKey);
	if (!cached) return false;
	const ttl = config.modelCacheTtl || MODEL_CACHE_TTL;
	return Date.now() - cached.timestamp < ttl;
}

export function refreshModels(
	config: OmniRouteConfig,
	apiKey: string,
): Promise<OmniRouteModel[]> {
	clearModelCache();
	return fetchModels(config, apiKey, true);
}

async function enrichModelMetadata(
	models: OmniRouteModel[],
	config: OmniRouteConfig,
): Promise<OmniRouteModel[]> {
	const modelsDevIndex = await getModelsDevIndex(config);

	const withModelsDev =
		modelsDevIndex === null
			? models
			: models.map((model) => applyModelsDevMetadata(model, config, modelsDevIndex));

	const withOverrides = applyConfiguredModelMetadata(withModelsDev, config, modelsDevIndex);

	const withComboCapabilities = await enrichComboModels(withOverrides, config, modelsDevIndex);

	return withComboCapabilities;
}

function applyModelsDevMetadata(
	model: OmniRouteModel,
	config: OmniRouteConfig,
	index: ModelsDevIndex,
): OmniRouteModel {
	const candidates = getModelsDevLookupCandidates(model, config);
	const best = findBestModelsDevMatch(candidates, index);

	if (!best) return model;

	return mergeModelMetadata(model, metadataFromModelsDev(best));
}

function findBestModelsDevMatch(
	candidates: Array<{ providerAlias: string | null; modelKey: string }>,
	index: ModelsDevIndex,
): ModelsDevModel | undefined {
	for (const candidate of candidates) {
		const lookupKey = candidate.modelKey.toLowerCase();
		const normalizedKey = normalizeModelKey(candidate.modelKey);

		const providerExact = candidate.providerAlias
			? index.exactByProvider.get(candidate.providerAlias)?.get(lookupKey)
			: undefined;
		if (providerExact) return providerExact;

		const providerNorm = candidate.providerAlias
			? index.normalizedByProvider.get(candidate.providerAlias)?.get(normalizedKey)
			: undefined;
		if (providerNorm) return providerNorm;

		const globalExactList = index.exactGlobal.get(lookupKey);
		if (globalExactList?.length === 1) return globalExactList[0];

		const globalNormList = index.normalizedGlobal.get(normalizedKey);
		if (globalNormList?.length === 1) return globalNormList[0];
	}

	return undefined;
}

function getModelsDevLookupCandidates(
	model: OmniRouteModel,
	config: OmniRouteConfig,
): Array<{ providerAlias: string | null; modelKey: string }> {
	const { providerKey, modelKey } = splitOmniRouteModelForLookup(model.id);
	const providerAlias = resolveProviderAlias(providerKey, config);
	const candidates: Array<{ providerAlias: string | null; modelKey: string }> = [];
	const seen = new Set<string>();

	const addCandidate = (
		nextProviderAlias: string | null,
		nextModelKey: string | null | undefined,
	): void => {
		if (!nextModelKey) return;
		const trimmedModelKey = nextModelKey.trim();
		if (!trimmedModelKey) return;

		const normalizedProvider = nextProviderAlias ? nextProviderAlias.toLowerCase() : 'global';
		const signature = `${normalizedProvider}:${trimmedModelKey.toLowerCase()}`;
		if (seen.has(signature)) return;
		seen.add(signature);
		candidates.push({ providerAlias: nextProviderAlias, modelKey: trimmedModelKey });
	};

	const lookupRoots = [model.root, modelKey].filter(
		(value): value is string => typeof value === 'string' && value.trim() !== '',
	);

	for (const lookupRoot of lookupRoots) {
		addCandidate(providerAlias, lookupRoot);
		addCandidate(null, lookupRoot);

		for (const derived of deriveModelsDevFamilies(lookupRoot, providerAlias, model.owned_by)) {
			addCandidate(derived.providerAlias, derived.modelKey);
			addCandidate(null, derived.modelKey);
		}
	}

	return candidates;
}

function deriveModelsDevFamilies(
	modelKey: string,
	providerAlias: string | null,
	ownedBy?: string,
): Array<{ providerAlias: string; modelKey: string }> {
	const lower = modelKey.toLowerCase();
	const stripped = stripVariantSuffixes(modelKey);
	const strippedLower = stripped.toLowerCase();
	const matches: Array<{ providerAlias: string; modelKey: string }> = [];
	const slashFamily = extractSlashModelFamily(modelKey);
	const strippedSlashFamily = slashFamily ? stripVariantSuffixes(slashFamily) : null;
	const slashFamilyLower = slashFamily?.toLowerCase();
	const strippedSlashFamilyLower = strippedSlashFamily?.toLowerCase();

	const add = (alias: string, key: string): void => {
		matches.push({ providerAlias: alias, modelKey: key });
	};

	if (strippedLower.startsWith('gemini-')) {
		add('google', stripped);
	}
	if (strippedLower.startsWith('claude-')) {
		add('anthropic', stripped);
	}

	if (providerAlias) {
		add(providerAlias, modelKey);
		if (strippedLower !== lower) add(providerAlias, stripped);
		if (slashFamily && slashFamilyLower !== lower) add(providerAlias, slashFamily);
		if (
			strippedSlashFamily &&
			strippedSlashFamilyLower !== slashFamilyLower &&
			strippedSlashFamilyLower !== lower
		) {
			add(providerAlias, strippedSlashFamily);
		}
	}

	if (ownedBy) {
		const ownedByLower = ownedBy.toLowerCase();
		add(ownedByLower, modelKey);
		if (strippedLower !== lower) add(ownedByLower, stripped);
		if (slashFamily && slashFamilyLower !== lower) add(ownedByLower, slashFamily);
		if (
			strippedSlashFamily &&
			strippedSlashFamilyLower !== slashFamilyLower &&
			strippedSlashFamilyLower !== lower
		) {
			add(ownedByLower, strippedSlashFamily);
		}
	}

	if (lower.startsWith('claude-')) {
		add('anthropic', modelKey);
		if (strippedLower !== lower) add('anthropic', stripped);
	}
	if (lower.startsWith('gemini-')) {
		add('google', modelKey);
		if (strippedLower !== lower) add('google', stripped);
	}
	if (
		lower.startsWith('gpt-') ||
		lower.startsWith('o1') ||
		lower.startsWith('o3') ||
		lower.startsWith('o4') ||
		lower.startsWith('oai-') ||
		lower.startsWith('codex-') ||
		lower.startsWith('gpt-oss-')
	) {
		add('openai', modelKey);
		if (strippedLower !== lower) add('openai', stripped);
		if (slashFamily && slashFamilyLower !== lower) add('openai', slashFamily);
		if (
			strippedSlashFamily &&
			strippedSlashFamilyLower !== slashFamilyLower &&
			strippedSlashFamilyLower !== lower
		) {
			add('openai', strippedSlashFamily);
		}
	}

	return matches;
}

function extractSlashModelFamily(modelKey: string): string | null {
	const trimmed = modelKey.trim();
	if (!trimmed.includes('/')) return null;

	const segments = trimmed.split('/').filter((segment) => segment.trim() !== '');
	if (segments.length < 2) return null;

	return segments[segments.length - 1] ?? null;
}

function stripVariantSuffixes(modelKey: string): string {
	let normalized = modelKey;

	while (true) {
		const next = normalized
			.replace(/-(?:\d+(?:\.\d+)*)-(minimal|low|medium|high|max|xhigh|none)$/i, '')
			.replace(/-(thinking|reasoning)$/i, '')
			.replace(/-(minimal|low|medium|high|max|xhigh|none)$/i, '');

		if (next === normalized) {
			return next;
		}

		normalized = next;
	}
}

function splitOmniRouteModelForLookup(
	modelId: string,
): { providerKey: string | null; modelKey: string } {
	const trimmed = modelId.trim();
	const withoutPrefix = trimmed.replace(/^omniroute\//, '');
	const parts = withoutPrefix.split('/').filter((p) => p.trim() !== '');

	if (parts.length >= 2) {
		return {
			providerKey: parts[0] ?? null,
			modelKey: parts.slice(1).join('/'),
		};
	}

	return { providerKey: null, modelKey: withoutPrefix };
}

function metadataFromModelsDev(model: ModelsDevModel): OmniRouteModelMetadata {
	return {
		...(model.limit?.context !== undefined ? { contextWindow: model.limit.context } : {}),
		...(model.limit?.output !== undefined ? { maxTokens: model.limit.output } : {}),
		...(model.modalities?.input?.includes('image') ? { supportsVision: true } : {}),
		...(model.tool_call === true ? { supportsTools: true } : {}),
		...(model.reasoning === true ? { reasoning: true } : {}),
		supportsStreaming: true,
	};
}

function mergeModelMetadata(
	model: OmniRouteModel,
	metadata: OmniRouteModelMetadata,
): OmniRouteModel {
	return {
		...model,
		...(metadata.name !== undefined ? { name: metadata.name } : {}),
		...(metadata.description !== undefined ? { description: metadata.description } : {}),
		...(metadata.contextWindow !== undefined ? { contextWindow: metadata.contextWindow } : {}),
		...(metadata.maxTokens !== undefined ? { maxTokens: metadata.maxTokens } : {}),
		...(metadata.supportsStreaming !== undefined ? { supportsStreaming: metadata.supportsStreaming } : {}),
		...(metadata.supportsVision !== undefined ? { supportsVision: metadata.supportsVision } : {}),
		...(metadata.supportsTools !== undefined ? { supportsTools: metadata.supportsTools } : {}),
		...(metadata.apiMode !== undefined ? { apiMode: metadata.apiMode } : {}),
		...(metadata.reasoning !== undefined ? { reasoning: metadata.reasoning } : {}),
		...(metadata.resetEmbeddedReasoningVariant !== undefined
			? { resetEmbeddedReasoningVariant: metadata.resetEmbeddedReasoningVariant }
			: {}),
		...(metadata.variants !== undefined ? { variants: metadata.variants } : {}),
		...(metadata.pricing !== undefined ? { pricing: { ...model.pricing, ...metadata.pricing } } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceMatcherToRegExp(value: unknown): RegExp | null {
	if (value instanceof RegExp) return value;
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

function applyConfiguredModelMetadata(
	models: OmniRouteModel[],
	config: OmniRouteConfig,
	modelsDevIndex: ModelsDevIndex | null,
): OmniRouteModel[] {
	const metadataConfig = config.modelMetadata;
	if (!metadataConfig) return models;

	let output = [...models];

	if (Array.isArray(metadataConfig)) {
		for (const block of metadataConfig as OmniRouteModelMetadataBlock[]) {
			const matcher = typeof block.match === 'string'
				? block.match
				: coerceMatcherToRegExp(block.match);
			const metadata = metadataWithoutMatcher(block);

			if (typeof matcher === 'string') {
				const existingIndex = output.findIndex((model) => model.id === matcher);
				if (existingIndex >= 0) {
					output[existingIndex] = mergeModelMetadata(output[existingIndex], metadata);
				} else if (block.addIfMissing) {
					output.push(createSyntheticModel(matcher, metadata, modelsDevIndex, config));
				}
				continue;
			}

			if (!matcher) continue;
			output = output.map((model) =>
				matcher.test(model.id) ? mergeModelMetadata(model, metadata) : model,
			);
		}

		return output;
	}

	for (const [modelId, metadata] of Object.entries(metadataConfig)) {
		const existingIndex = output.findIndex((model) => model.id === modelId);
		if (existingIndex >= 0) {
			output[existingIndex] = mergeModelMetadata(output[existingIndex], metadata);
		} else {
			output.push(createSyntheticModel(modelId, metadata, modelsDevIndex, config));
		}
	}

	return output;
}

function metadataWithoutMatcher(block: OmniRouteModelMetadataBlock): OmniRouteModelMetadata {
	const { match: _match, addIfMissing: _addIfMissing, ...rest } = block;
	return rest;
}

function createSyntheticModel(
	modelId: string,
	metadata: OmniRouteModelMetadata,
	modelsDevIndex: ModelsDevIndex | null,
	config: OmniRouteConfig,
): OmniRouteModel {
	const base: OmniRouteModel = {
		id: modelId,
		name: metadata.name || modelId,
		description: metadata.description || `OmniRoute model: ${modelId}`,
	};

	if (modelsDevIndex) {
		const candidates = getModelsDevLookupCandidates(base, config);
		const devMatch = findBestModelsDevMatch(candidates, modelsDevIndex);
		if (devMatch) {
			const enriched = mergeModelMetadata(base, metadataFromModelsDev(devMatch));
			return mergeModelMetadata(enriched, metadata);
		}
	}

	return mergeModelMetadata(base, metadata);
}

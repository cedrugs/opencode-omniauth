import type { OmniRouteConfig, OmniRouteModel, OmniRouteModelMetadata } from './types.js';
import type { ModelsDevIndex, ModelsDevModel } from './models-dev.js';
import {
	modelsDevToMetadata,
	calculateLowestCommonCapabilities,
	resolveProviderAlias,
	normalizeModelKey,
} from './models-dev.js';
import { REQUEST_TIMEOUT, log } from './constants.js';

export interface OmniRouteCombo {
	id: string;
	name: string;
	models: string[];
	strategy: 'priority' | 'weighted' | 'round-robin' | 'random' | 'least-used' | 'cost-optimized';
	config: {
		maxRetries?: number;
		retryDelayMs?: number;
		concurrencyPerModel?: number;
	};
	createdAt: string;
	updatedAt: string;
}

export interface OmniRouteCombosResponse {
	combos: OmniRouteCombo[];
}

interface ComboCache {
	combos: Map<string, OmniRouteCombo>;
	timestamp: number;
}

let comboCache: ComboCache | null = null;
const COMBO_CACHE_TTL = 5 * 60 * 1000;

export async function fetchComboData(
	config: OmniRouteConfig,
): Promise<Map<string, OmniRouteCombo> | null> {
	const baseUrl = config.baseUrl;
	const apiKey = config.apiKey;

	if (comboCache && Date.now() - comboCache.timestamp < COMBO_CACHE_TTL) {
		log.info('[OmniRoute] Using cached combo data');
		return comboCache.combos;
	}

	const combosUrl = `${baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '')}/api/combos`;
	log.info(`[OmniRoute] Fetching combo data from ${combosUrl}`);

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

	try {
		const response = await fetch(combosUrl, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: 'application/json',
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			log.warn(`[OmniRoute] Failed to fetch combo data: ${response.status}`);
			return null;
		}

		const data = await response.json() as OmniRouteCombosResponse;

		if (!data?.combos || !Array.isArray(data.combos)) {
			log.warn('[OmniRoute] Invalid combo data structure');
			return null;
		}

		const comboMap = new Map<string, OmniRouteCombo>();
		for (const combo of data.combos) {
			if (combo?.name) {
				comboMap.set(combo.name, combo);
			}
		}

		comboCache = {
			combos: comboMap,
			timestamp: Date.now(),
		};

		log.info(`[OmniRoute] Successfully fetched ${comboMap.size} combos`);
		return comboMap;
	} catch (error) {
		log.warn('[OmniRoute] Error fetching combo data:', error);
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

export function clearComboCache(): void {
	comboCache = null;
	log.info('[OmniRoute] Combo cache cleared');
}

export async function resolveUnderlyingModels(
	modelId: string,
	config: OmniRouteConfig,
): Promise<string[]> {
	const combos = await fetchComboData(config);
	if (!combos) {
		return [modelId];
	}

	const combo = combos.get(modelId);
	if (combo) {
		log.info(`[OmniRoute] Resolved combo "${modelId}" to ${combo.models.length} underlying models`);
		return combo.models;
	}

	return [modelId];
}

export function lookupModelInIndex(
	modelId: string,
	modelsDevIndex: ModelsDevIndex | null,
	config?: OmniRouteConfig,
): ModelsDevModel | null {
	if (!modelsDevIndex) return null;

	const { providerKey, modelKey } = splitModelId(modelId);
	const providerAlias = providerKey
		? resolveProviderAlias(providerKey, config)
		: null;

	const lookupKey = modelKey.toLowerCase();
	const normalizedKey = normalizeModelKey(modelKey);

	if (providerAlias) {
		const providerExact = modelsDevIndex.exactByProvider.get(providerAlias)?.get(lookupKey);
		if (providerExact) return providerExact;

		const providerNorm = modelsDevIndex.normalizedByProvider.get(providerAlias)?.get(normalizedKey);
		if (providerNorm) return providerNorm;
	}

	const globalExactList = modelsDevIndex.exactGlobal.get(lookupKey);
	if (globalExactList?.length === 1) {
		return globalExactList[0];
	}

	const globalNormList = modelsDevIndex.normalizedGlobal.get(normalizedKey);
	if (globalNormList?.length === 1) {
		return globalNormList[0];
	}

	if (globalExactList && globalExactList.length > 1 && providerAlias) {
		const byProvider = globalExactList.find((m) => {
			for (const [pKey, pMap] of modelsDevIndex.exactByProvider.entries()) {
				if (pMap.get(lookupKey) === m && pKey === providerAlias) {
					return true;
				}
			}
			return false;
		});
		if (byProvider) return byProvider;
	}

	return globalExactList?.[0] ?? globalNormList?.[0] ?? null;
}

function splitModelId(modelId: string): { providerKey: string | null; modelKey: string } {
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

export async function calculateModelCapabilities(
	model: OmniRouteModel,
	config: OmniRouteConfig,
	modelsDevIndex: ModelsDevIndex | null,
): Promise<OmniRouteModelMetadata> {
	if (model.contextWindow !== undefined && model.maxTokens !== undefined) {
		return {};
	}

	const underlyingModels = await resolveUnderlyingModels(model.id, config);

	if (underlyingModels.length === 1 && underlyingModels[0] === model.id) {
		const match = lookupModelInIndex(model.id, modelsDevIndex, config);
		if (match) {
			return modelsDevToMetadata(match);
		}
		return {};
	}

	log.info(`[OmniRoute] Calculating capabilities for combo "${model.id}" from ${underlyingModels.length} models`);

	const resolvedModels: ModelsDevModel[] = [];
	const unresolvedModels: string[] = [];

	for (const underlyingId of underlyingModels) {
		const match = lookupModelInIndex(underlyingId, modelsDevIndex, config);
		if (match) {
			resolvedModels.push(match);
		} else {
			unresolvedModels.push(underlyingId);
		}
	}

	if (unresolvedModels.length > 0) {
		log.warn(
			`[OmniRoute] Could not resolve ${unresolvedModels.length} underlying models for "${model.id}": ${unresolvedModels.join(', ')}`,
		);
	}

	if (resolvedModels.length === 0) {
		log.warn(`[OmniRoute] No models.dev matches found for combo "${model.id}"`);
		return {};
	}

	log.info(`[OmniRoute] Resolved ${resolvedModels.length}/${underlyingModels.length} underlying models for "${model.id}"`);

	const capabilities = calculateLowestCommonCapabilities(resolvedModels);

	log.info(
		`[OmniRoute] Calculated capabilities for "${model.id}": context=${capabilities.contextWindow ?? 'N/A'}, maxTokens=${capabilities.maxTokens ?? 'N/A'}, vision=${capabilities.supportsVision ?? false}, tools=${capabilities.supportsTools ?? false}`,
	);

	return capabilities;
}

export function isComboModel(model: OmniRouteModel): boolean {
	const record = model as unknown as Record<string, unknown>;
	if (record.owned_by === 'combo') {
		return true;
	}

	if (comboCache?.combos?.has(model.id)) {
		return true;
	}

	return false;
}

export async function enrichComboModels(
	models: OmniRouteModel[],
	config: OmniRouteConfig,
	modelsDevIndex: ModelsDevIndex | null,
): Promise<OmniRouteModel[]> {
	const combos = await fetchComboData(config);
	if (!combos) {
		return models;
	}

	return Promise.all(
		models.map(async (model) => {
			const isCombo = combos.has(model.id);
			if (!isCombo) {
				return model;
			}

			log.info(`[OmniRoute] Enriching combo model: ${model.id}`);

			const capabilities = await calculateModelCapabilities(model, config, modelsDevIndex);

			return {
				...model,
				...(capabilities.name !== undefined ? { name: capabilities.name } : {}),
				...(capabilities.contextWindow !== undefined ? { contextWindow: capabilities.contextWindow } : {}),
				...(capabilities.maxTokens !== undefined ? { maxTokens: capabilities.maxTokens } : {}),
				...(capabilities.supportsVision !== undefined ? { supportsVision: capabilities.supportsVision } : {}),
				...(capabilities.supportsTools !== undefined ? { supportsTools: capabilities.supportsTools } : {}),
				...(capabilities.supportsStreaming !== undefined ? { supportsStreaming: capabilities.supportsStreaming } : {}),
				...(capabilities.pricing !== undefined ? { pricing: { ...model.pricing, ...capabilities.pricing } } : {}),
			};
		}),
	);
}

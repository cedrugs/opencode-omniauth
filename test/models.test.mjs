import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import {
	clearModelCache,
	clearModelsDevCache,
	fetchModels,
	getCachedModels,
	isCacheValid,
	refreshModels,
} from '../dist/runtime.js';

const ORIGINAL_FETCH = global.fetch;

const CONFIG = {
	baseUrl: 'http://localhost:20128/v1',
	apiKey: 'test-key',
	apiMode: 'chat',
	modelCacheTtl: 60000,
};

afterEach(() => {
	clearModelCache();
	clearModelsDevCache();
	global.fetch = ORIGINAL_FETCH;
});

function createRoutedFetch(modelsData) {
	return async (input) => {
		const url = typeof input === 'string'
			? input
			: input instanceof Request
				? input.url
				: String(input);

		if (url.includes('/v1/models')) {
			return new Response(
				JSON.stringify({
					object: 'list',
					data: modelsData ?? [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' }],
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}

		if (url.includes('models.dev')) {
			return new Response(
				JSON.stringify({}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}

		return new Response(
			JSON.stringify({ combos: [] }),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		);
	};
}

test('fetchModels caches successful responses', async () => {
	let modelCalls = 0;

	global.fetch = async (input) => {
		const url = typeof input === 'string'
			? input
			: input instanceof Request
				? input.url
				: String(input);

		if (url.includes('/v1/models')) {
			modelCalls += 1;
			return new Response(
				JSON.stringify({
					object: 'list',
					data: [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' }],
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}

		if (url.includes('models.dev')) {
			return new Response(
				JSON.stringify({}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}

		return new Response(
			JSON.stringify({ combos: [] }),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		);
	};

	const first = await fetchModels(CONFIG, CONFIG.apiKey, false);
	const second = await fetchModels(CONFIG, CONFIG.apiKey, false);

	assert.equal(modelCalls, 1);
	assert.equal(first[0].id, 'gpt-4.1-mini');
	assert.equal(second[0].id, 'gpt-4.1-mini');
	assert.ok(getCachedModels(CONFIG, CONFIG.apiKey));
	assert.equal(isCacheValid(CONFIG, CONFIG.apiKey), true);
});

test('refreshModels forces refetch', async () => {
	let modelCalls = 0;

	global.fetch = async (input) => {
		const url = typeof input === 'string'
			? input
			: input instanceof Request
				? input.url
				: String(input);

		if (url.includes('/v1/models')) {
			modelCalls += 1;
			return new Response(
				JSON.stringify({
					object: 'list',
					data: [{ id: `model-${modelCalls}`, name: `Model ${modelCalls}` }],
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}

		if (url.includes('models.dev')) {
			return new Response(
				JSON.stringify({}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}

		return new Response(
			JSON.stringify({ combos: [] }),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		);
	};

	await fetchModels(CONFIG, CONFIG.apiKey, false);
	const refreshed = await refreshModels(CONFIG, CONFIG.apiKey);

	assert.equal(modelCalls, 2);
	assert.equal(refreshed[0].id, 'model-2');
});

test('fetchModels falls back to defaults when response shape is invalid', async () => {
	global.fetch = async () => {
		return new Response(JSON.stringify({ data: null }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	const models = await fetchModels(CONFIG, CONFIG.apiKey, true);
	assert.ok(models.length > 0);
	assert.ok(typeof models[0].id === 'string');
});

test('fetchModels maps snake_case API fields to camelCase', async () => {
	global.fetch = createRoutedFetch([
		{
			id: 'test-model',
			name: 'Test Model',
			context_length: 200000,
			capabilities: { vision: true, tools: true },
			input_modalities: ['text', 'image'],
		},
	]);

	const models = await fetchModels(CONFIG, CONFIG.apiKey, true);
	const model = models.find((m) => m.id === 'test-model');

	assert.ok(model);
	assert.equal(model.contextWindow, 200000);
	assert.equal(model.supportsVision, true);
	assert.equal(model.supportsTools, true);
});

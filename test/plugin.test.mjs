import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import OmniRouteAuthPlugin from '../dist/index.js';
import { clearModelCache, clearModelsDevCache } from '../dist/runtime.js';

const ORIGINAL_FETCH = global.fetch;

afterEach(() => {
	clearModelCache();
	clearModelsDevCache();
	global.fetch = ORIGINAL_FETCH;
});

function createModelsResponse() {
	return {
		object: 'list',
		data: [
			{
				id: 'gpt-4.1-mini',
				name: 'GPT-4.1 Mini',
			},
		],
	};
}

function createEmptyOmniRouteFetch() {
	return async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);

		if (url.endsWith('/v1/models')) {
			return new Response(JSON.stringify(createModelsResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.includes('models.dev')) {
			return new Response(JSON.stringify({}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.includes('/api/combos')) {
			return new Response(JSON.stringify({ combos: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};
}

test('config hook applies defaults and normalized apiMode', async () => {
	const plugin = await OmniRouteAuthPlugin({});
	const config = {
		provider: {
			omniroute: {
				options: {
					baseURL: 'http://localhost:20128/v1',
					apiMode: 'invalid-mode',
				},
			},
		},
	};

	await plugin.config(config);

	assert.equal(config.provider.omniroute.api, 'chat');
	assert.equal(config.provider.omniroute.options.apiMode, 'chat');
	assert.equal(config.provider.omniroute.options.baseURL, 'http://localhost:20128/v1');
});

test('config hook sets responses mode npm package', async () => {
	const plugin = await OmniRouteAuthPlugin({});
	const config = {
		provider: {
			omniroute: {
				options: {
					baseURL: 'http://localhost:20128/v1',
					apiMode: 'responses',
				},
			},
		},
	};

	await plugin.config(config);

	assert.equal(config.provider.omniroute.api, 'responses');
	assert.equal(config.provider.omniroute.npm, '@ai-sdk/openai');
});

test('loader injects auth headers only for OmniRoute URLs', async () => {
	const plugin = await OmniRouteAuthPlugin({});
	const calls = [];

	global.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		calls.push({ url, init });

		if (url.endsWith('/v1/models')) {
			return new Response(JSON.stringify(createModelsResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.includes('models.dev')) {
			return new Response(JSON.stringify({}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.includes('/api/combos')) {
			return new Response(JSON.stringify({ combos: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	const provider = {
		options: {
			baseURL: 'http://localhost:20128/v1',
			apiMode: 'chat',
		},
		models: {},
	};

	const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
	const interceptedFetch = options.fetch;

	await interceptedFetch('http://localhost:20128/v1/chat/completions', {
		method: 'POST',
		body: JSON.stringify({ model: 'gpt-4.1-mini', messages: [] }),
	});

	await interceptedFetch('https://example.com/not-omniroute', {
		method: 'POST',
		body: JSON.stringify({ value: true }),
	});

	const omnirouteCall = calls.find((call) => call.url.includes('/chat/completions'));
	const externalCall = calls.find((call) => call.url.includes('example.com/not-omniroute'));

	assert.ok(omnirouteCall);
	assert.ok(externalCall);

	const omnirouteHeaders = new Headers(omnirouteCall.init?.headers);
	assert.equal(omnirouteHeaders.get('Authorization'), 'Bearer secret-key');
	assert.equal(omnirouteHeaders.get('Content-Type'), 'application/json');

	const externalHeaders = new Headers(externalCall.init?.headers);
	assert.equal(externalHeaders.get('Authorization'), null);
});

test('tool schema sanitization applies to all models', async () => {
	const plugin = await OmniRouteAuthPlugin({});
	let forwardedBody;

	global.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.endsWith('/v1/models')) {
			return new Response(JSON.stringify(createModelsResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.includes('models.dev')) {
			return new Response(JSON.stringify({}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.includes('/api/combos')) {
			return new Response(JSON.stringify({ combos: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		forwardedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	const provider = {
		options: { baseURL: 'http://localhost:20128/v1', apiMode: 'chat' },
		models: {},
	};

	const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
	const interceptedFetch = options.fetch;

	await interceptedFetch('http://localhost:20128/v1/chat/completions', {
		method: 'POST',
		body: JSON.stringify({
			model: 'free-stack',
			messages: [],
			tools: [
				{
					type: 'function',
					function: {
						name: 'lookup',
						parameters: {
							type: 'object',
							$schema: 'https://json-schema.org/draft/2020-12/schema',
							additionalProperties: false,
						},
					},
				},
			],
		}),
	});

	assert.ok(forwardedBody);
	assert.equal(forwardedBody.tools[0].function.parameters.$schema, undefined);
	assert.equal(forwardedBody.tools[0].function.parameters.additionalProperties, undefined);
	assert.equal(forwardedBody.tools[0].function.parameters.type, 'object');
});

test('gemini tool schema with $ref definitions resolved inline', async () => {
	const plugin = await OmniRouteAuthPlugin({});
	let forwardedBody;

	global.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.endsWith('/v1/models')) {
			return new Response(JSON.stringify(createModelsResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.includes('models.dev') || url.includes('/api/combos')) {
			return new Response(
				JSON.stringify(url.includes('models.dev') ? {} : { combos: [] }),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}

		forwardedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	const provider = {
		options: { baseURL: 'http://localhost:20128/v1', apiMode: 'chat' },
		models: {},
	};

	const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
	const interceptedFetch = options.fetch;

	await interceptedFetch('http://localhost:20128/v1/chat/completions', {
		method: 'POST',
		body: JSON.stringify({
			model: 'gemini-2.5-pro',
			messages: [],
			tools: [
				{
					type: 'function',
					function: {
						name: 'lookup',
						parameters: {
							type: 'object',
							$schema: 'https://json-schema.org/draft/2020-12/schema',
							additionalProperties: false,
							$defs: {
								queryItem: {
									type: 'object',
									properties: {
										term: { type: 'string' },
									},
									additionalProperties: false,
								},
							},
							properties: {
								query: {
									type: 'array',
									items: {
										$ref: '#/$defs/queryItem',
										additionalProperties: false,
									},
								},
							},
						},
					},
				},
			],
		}),
	});

	assert.ok(forwardedBody);
	const params = forwardedBody.tools[0].function.parameters;
	assert.equal(params.$schema, undefined);
	assert.equal(params.additionalProperties, undefined);
	assert.equal(params.$defs, undefined);
	assert.equal(params.properties.query.items.$ref, undefined);
	assert.equal(params.properties.query.items.type, 'object');
	assert.equal(params.properties.query.items.properties.term.type, 'string');
	assert.equal(params.properties.query.items.additionalProperties, undefined);
});

test('nested $ref resolution and circular ref safety', async () => {
	const plugin = await OmniRouteAuthPlugin({});
	let forwardedBody;

	global.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.endsWith('/v1/models')) {
			return new Response(JSON.stringify(createModelsResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.includes('models.dev') || url.includes('/api/combos')) {
			return new Response(
				JSON.stringify(url.includes('models.dev') ? {} : { combos: [] }),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}

		forwardedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	const provider = {
		options: { baseURL: 'http://localhost:20128/v1', apiMode: 'chat' },
		models: {},
	};

	const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
	const interceptedFetch = options.fetch;

	await interceptedFetch('http://localhost:20128/v1/chat/completions', {
		method: 'POST',
		body: JSON.stringify({
			model: 'gemini-2.5-pro',
			messages: [],
			tools: [
				{
					type: 'function',
					function: {
						name: 'create_quiz',
						parameters: {
							type: 'object',
							$defs: {
								QuestionOption: {
									type: 'object',
									properties: {
										label: { type: 'string' },
										correct: { type: 'boolean' },
									},
									additionalProperties: false,
								},
								Question: {
									type: 'object',
									properties: {
										text: { type: 'string' },
										options: {
											type: 'array',
											items: { $ref: '#/$defs/QuestionOption' },
										},
									},
									additionalProperties: false,
								},
								TreeNode: {
									type: 'object',
									properties: {
										value: { type: 'string' },
										children: {
											type: 'array',
											items: { $ref: '#/$defs/TreeNode' },
										},
									},
								},
							},
							properties: {
								questions: {
									type: 'array',
									items: { $ref: '#/$defs/Question' },
								},
								tree: { $ref: '#/$defs/TreeNode', description: 'A tree structure' },
							},
							additionalProperties: false,
						},
					},
				},
			],
		}),
	});

	assert.ok(forwardedBody);
	const params = forwardedBody.tools[0].function.parameters;

	assert.equal(params.$defs, undefined);
	assert.equal(params.additionalProperties, undefined);

	const question = params.properties.questions.items;
	assert.equal(question.type, 'object');
	assert.equal(question.properties.text.type, 'string');
	assert.equal(question.properties.options.items.type, 'object');
	assert.equal(question.properties.options.items.properties.label.type, 'string');
	assert.equal(question.properties.options.items.additionalProperties, undefined);

	const tree = params.properties.tree;
	assert.equal(tree.type, 'object');
	assert.equal(tree.description, 'A tree structure');
	assert.equal(tree.properties.value.type, 'string');
	assert.equal(tree.properties.children.items.$ref, undefined);
});

test('responses endpoint sanitizes tool schemas from Request objects', async () => {
	const plugin = await OmniRouteAuthPlugin({});
	let forwardedBody;

	global.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.endsWith('/v1/models')) {
			return new Response(JSON.stringify(createModelsResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.includes('models.dev')) {
			return new Response(JSON.stringify({}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.includes('/api/combos')) {
			return new Response(JSON.stringify({ combos: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const raw = typeof init?.body === 'string'
			? init.body
			: input instanceof Request
				? await input.clone().text()
				: undefined;
		if (raw) forwardedBody = JSON.parse(raw);
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	const provider = {
		options: { baseURL: 'http://localhost:20128/v1', apiMode: 'responses' },
		models: {},
	};

	const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
	const interceptedFetch = options.fetch;

	const request = new Request('http://localhost:20128/v1/responses', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: 'gemini-2.5-pro',
			input: 'test',
			tools: [
				{
					type: 'function',
					name: 'lookup',
					input_schema: {
						type: 'object',
						properties: {
							query: {
								type: 'array',
								items: {
									type: 'object',
									additionalProperties: false,
								},
							},
						},
						additionalProperties: false,
					},
				},
			],
		}),
	});

	await interceptedFetch(request);

	assert.ok(forwardedBody);
	assert.equal(forwardedBody.tools[0].input_schema.additionalProperties, undefined);
	assert.equal(forwardedBody.tools[0].input_schema.properties.query.items.additionalProperties, undefined);
});

test('responses payload strips unsupported fields', async () => {
	const plugin = await OmniRouteAuthPlugin({});
	let forwardedBody;

	global.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.endsWith('/v1/models')) {
			return new Response(JSON.stringify(createModelsResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.includes('models.dev') || url.includes('/api/combos')) {
			return new Response(
				JSON.stringify(url.includes('models.dev') ? {} : { combos: [] }),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}

		forwardedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	const provider = {
		options: { baseURL: 'http://localhost:20128/v1', apiMode: 'responses' },
		models: {},
	};

	const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
	const interceptedFetch = options.fetch;

	await interceptedFetch('http://localhost:20128/v1/responses', {
		method: 'POST',
		body: JSON.stringify({
			model: 'gpt-5.4',
			input: 'test',
			max_output_tokens: 4096,
			max_tokens: 4096,
			temperature: 0.7,
			reasoningSummary: 'auto',
			store: true,
			parallel_tool_calls: true,
			top_p: 0.9,
		}),
	});

	assert.ok(forwardedBody);
	assert.equal(forwardedBody.max_output_tokens, undefined);
	assert.equal(forwardedBody.max_tokens, undefined);
	assert.equal(forwardedBody.temperature, undefined);
	assert.equal(forwardedBody.reasoningSummary, undefined);
	assert.equal(forwardedBody.store, true);
	assert.equal(forwardedBody.parallel_tool_calls, true);
	assert.equal(forwardedBody.top_p, 0.9);
});

test('chat payload strips reasoning summary aliases', async () => {
	const plugin = await OmniRouteAuthPlugin({});
	let forwardedBody;

	global.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.endsWith('/v1/models')) {
			return new Response(JSON.stringify(createModelsResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.includes('models.dev') || url.includes('/api/combos')) {
			return new Response(
				JSON.stringify(url.includes('models.dev') ? {} : { combos: [] }),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}

		forwardedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	const provider = {
		options: { baseURL: 'http://localhost:20128/v1', apiMode: 'chat' },
		models: {},
	};

	const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
	const interceptedFetch = options.fetch;

	await interceptedFetch('http://localhost:20128/v1/chat/completions', {
		method: 'POST',
		body: JSON.stringify({
			model: 'gpt-5.4',
			messages: [{ role: 'user', content: 'hello' }],
			reasoningSummary: 'auto',
			reasoning_summary: 'detailed',
			temperature: 0.7,
		}),
	});

	assert.ok(forwardedBody);
	assert.equal(forwardedBody.reasoningSummary, undefined);
	assert.equal(forwardedBody.reasoning_summary, undefined);
	assert.equal(forwardedBody.temperature, 0.7);
});

test('reasoningEffort is normalized to reasoning.effort object', async () => {
	const plugin = await OmniRouteAuthPlugin({});
	let forwardedBody;

	global.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.endsWith('/v1/models')) {
			return new Response(JSON.stringify(createModelsResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.includes('models.dev') || url.includes('/api/combos')) {
			return new Response(
				JSON.stringify(url.includes('models.dev') ? {} : { combos: [] }),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}

		forwardedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	const provider = {
		options: { baseURL: 'http://localhost:20128/v1', apiMode: 'chat' },
		models: {},
	};

	const options = await plugin.auth.loader(async () => ({ type: 'api', key: 'secret-key' }), provider);
	const interceptedFetch = options.fetch;

	await interceptedFetch('http://localhost:20128/v1/chat/completions', {
		method: 'POST',
		body: JSON.stringify({
			model: 'gpt-5.4',
			messages: [{ role: 'user', content: 'hello' }],
			reasoningEffort: 'high',
		}),
	});

	assert.ok(forwardedBody);
	assert.equal(forwardedBody.reasoningEffort, undefined);
	assert.deepStrictEqual(forwardedBody.reasoning, { effort: 'high' });
});

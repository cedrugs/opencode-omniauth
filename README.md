# @cedrugs/opencode-omniauth

[![npm version](https://img.shields.io/npm/v/@cedrugs/opencode-omniauth)](https://www.npmjs.com/package/@cedrugs/opencode-omniauth)
[![license](https://img.shields.io/npm/l/@cedrugs/opencode-omniauth)](https://github.com/cedrugs/opencode-omniauth/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@cedrugs/opencode-omniauth)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)
[![tests](https://img.shields.io/badge/tests-15%20passing-brightgreen)](#testing)

An [OpenCode](https://opencode.ai) authentication plugin for the [OmniRoute](https://github.com/Alph4d0g/omniroute) API. Provides `/connect` command setup, API key auth, dynamic model fetching from `/v1/models`, models.dev metadata enrichment, combo model resolution, reasoning variant generation, Gemini-specific schema sanitization, and request payload normalization.

Forked from [Alph4d0g/opencode-omniroute-auth](https://github.com/Alph4d0g/opencode-omniroute-auth) with combined improvements from the community and critical fixes for tool call reliability.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration Reference](#configuration-reference)
- [Features](#features)
  - [Dynamic Model Fetching](#dynamic-model-fetching)
  - [models.dev Metadata Enrichment](#modelsdev-metadata-enrichment)
  - [Combo Model Support](#combo-model-support)
  - [Reasoning Variant Generation](#reasoning-variant-generation)
  - [Per-Model API Mode Overrides](#per-model-api-mode-overrides)
  - [Request Payload Normalization](#request-payload-normalization)
  - [Gemini Tool Schema Sanitization](#gemini-tool-schema-sanitization)
  - [Responses Mode Chat Fallback](#responses-mode-chat-fallback)
  - [Debug Logging](#debug-logging)
- [API Mode](#api-mode)
- [Model Metadata Overrides](#model-metadata-overrides)
- [Runtime Exports](#runtime-exports)
- [Project Structure](#project-structure)
- [Development](#development)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Installation

**From npm:**

```bash
npm install @cedrugs/opencode-omniauth
```

**From local clone (development):**

```bash
git clone https://github.com/cedrugs/opencode-omniauth.git
cd opencode-omniauth
npm install
npm run build
```

---

## Quick Start

Add the plugin to your `opencode.json`:

```json
{
  "plugin": ["@cedrugs/opencode-omniauth"],
  "provider": {
    "omniroute": {
      "options": {
        "baseURL": "https://your-omniroute-instance.com/v1",
        "apiMode": "chat"
      }
    }
  }
}
```

If developing locally, point to the local directory instead:

```json
{
  "plugin": ["/path/to/opencode-omniauth"]
}
```

Start OpenCode and run `/connect omniroute` to set up your API key. The plugin will automatically fetch available models from your OmniRoute instance and register them as provider models.

---

## Configuration Reference

All configuration lives under `provider.omniroute.options` in your `opencode.json`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseURL` | `string` | `http://localhost:20128/v1` | OmniRoute API base URL. Must use `http:` or `https:` protocol. |
| `apiMode` | `"chat" \| "responses"` | `"chat"` | Global API mode. `chat` uses `/chat/completions`, `responses` uses `/responses`. |
| `refreshOnList` | `boolean` | `true` | Whether to re-fetch models from `/v1/models` on each auth load. |
| `modelCacheTtl` | `number` | `300000` (5 min) | Model cache time-to-live in milliseconds. |
| `modelsDev` | `object` | see below | models.dev enrichment configuration. |
| `modelMetadata` | `object \| array` | `undefined` | Per-model metadata overrides. See [Model Metadata Overrides](#model-metadata-overrides). |

### `modelsDev` options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable or disable models.dev enrichment entirely. |
| `url` | `string` | `https://models.dev/api.json` | URL to the models.dev API payload. |
| `cacheTtl` | `number` | `86400000` (24h) | Cache TTL for models.dev data in milliseconds. |
| `timeoutMs` | `number` | `1000` | Fetch timeout for models.dev in milliseconds. |
| `providerAliases` | `Record<string, string>` | `{}` | Custom alias mapping from OmniRoute provider keys to models.dev provider keys. Merged with built-in defaults. |

### Full example

```json
{
  "plugin": ["@cedrugs/opencode-omniauth"],
  "provider": {
    "omniroute": {
      "options": {
        "baseURL": "https://your-omniroute.example.com/v1",
        "apiMode": "chat",
        "refreshOnList": true,
        "modelCacheTtl": 300000,
        "modelsDev": {
          "enabled": true,
          "cacheTtl": 86400000,
          "timeoutMs": 2000,
          "providerAliases": {
            "myalias": "openai"
          }
        },
        "modelMetadata": {
          "custom/my-model": {
            "contextWindow": 128000,
            "maxTokens": 4096,
            "supportsVision": true,
            "supportsTools": true,
            "reasoning": true
          }
        }
      }
    }
  }
}
```

---

## Features

### Dynamic Model Fetching

On each auth load (when you start OpenCode or reconnect), the plugin fetches all available models from your OmniRoute instance's `/v1/models` endpoint. Models are cached in memory with a configurable TTL to avoid repeated API calls.

If the fetch fails, the plugin falls back to expired cache entries first, then to a set of built-in defaults (GPT-4o, GPT-4o Mini, Claude 3.5 Sonnet, Llama 3.1 405B).

The plugin also maps snake_case API response fields to the internal model interface:
- `context_length` maps to `contextWindow`
- `capabilities.vision` maps to `supportsVision`
- `capabilities.tools` maps to `supportsTools`
- `input_modalities` containing `"image"` maps to `supportsVision`
- `root` and `owned_by` fields are preserved for model lookup resolution

### models.dev Metadata Enrichment

Models fetched from `/v1/models` often lack detailed capability information. The plugin enriches each model with data from [models.dev](https://models.dev), filling in missing values for context window, max tokens, vision support, tool support, reasoning capability, and pricing.

The enrichment uses a multi-strategy lookup system:
1. Provider-specific exact match using the model's `root` field and provider alias
2. Provider-specific normalized match (strips date suffixes, version numbers, preview tags, thinking/reasoning suffixes, and effort-level suffixes)
3. Global exact match (only when unambiguous)
4. Global normalized match (only when unambiguous)
5. Family derivation: automatically detects model families (`claude-*` to `anthropic`, `gemini-*` to `google`, `gpt-*`/`o3`/`o4`/`codex-*` to `openai`) and generates additional lookup candidates

Built-in provider aliases: `oai`, `openai`, `cx`, `codex` to `openai`; `antigravity`, `anthropic`, `claude` to `anthropic`; `gemini`, `google` to `google`; plus `deepseek`, `mistral`, `xai`, `groq`, `together`, `openrouter`, `perplexity`, `cohere`.

### Combo Model Support

OmniRoute supports "combo" models that route requests across multiple underlying models using strategies like priority, round-robin, or cost-optimized routing. The plugin fetches combo definitions from `/api/combos` and calculates the lowest common capabilities across all underlying models:

- Context window: minimum across all underlying models
- Max output tokens: minimum across all underlying models
- Vision support: only if all underlying models support it
- Tool support: only if all underlying models support it

### Reasoning Variant Generation

Models detected as reasoning-capable automatically get `low`, `medium`, and `high` reasoning effort variants generated. Detection uses:
1. Explicit `reasoning: true` in model metadata or models.dev data
2. Pattern matching for known reasoning families (GPT-5, o3, o4, Codex)

Models with embedded effort suffixes in their ID (e.g., `antigravity/gemini-3.1-pro-high`) get a fixed variant with the embedded effort level instead of the generated picker. The `resetEmbeddedReasoningVariant` metadata flag overrides this behavior and restores the generated variants.

Custom variants can be added via `modelMetadata` and are merged on top of the auto-generated ones.

### Per-Model API Mode Overrides

Individual models can override the global `apiMode`. Set `apiMode: "chat"` or `apiMode: "responses"` in model metadata to force a specific mode for that model, regardless of the global setting.

```json
{
  "modelMetadata": {
    "anthropic/claude-opus-4": {
      "apiMode": "chat"
    }
  }
}
```

### Request Payload Normalization

The fetch interceptor normalizes outgoing request payloads to ensure compatibility with OmniRoute:

**For all endpoints:**
- `reasoningEffort` and `reasoning_effort` are normalized into the canonical `reasoning: { effort: "..." }` object format

**For `/chat/completions`:**
- `reasoningSummary` and `reasoning_summary` fields are stripped (not supported by OmniRoute Chat Completions)
- Input-shaped bodies (Responses API format with `input` instead of `messages`) are converted to `messages` format

**For `/responses`:**
- Unsupported fields are stripped: `max_output_tokens`, `max_tokens`, `reasoningEffort`, `textVerbosity`, `reasoning_effort`, `reasoningSummary`, `reasoning_summary`, `temperature`

### Gemini Tool Schema Sanitization

When the request payload targets a Gemini model (detected by `"gemini"` in the model name), the plugin sanitizes tool schemas by:

- Stripping `$schema` and `additionalProperties` keys (which Gemini rejects)
- Resolving `$ref` references inline by looking up `$defs`/`definitions` and expanding them in place, with circular reference safety
- Removing `$defs` and `definitions` containers after resolution

Non-Gemini models (OpenAI, Anthropic, etc.) keep their tool schemas fully intact, including `additionalProperties: false` which is required for strict structured output.

### Responses Mode Chat Fallback

When the global `apiMode` is set to `"responses"`, certain model families are automatically forced back to `"chat"` mode because they do not support the Responses API streaming format:

- Cursor defaults (`cu/default`, `cursor/default`)
- Anthropic/Claude models (`claude`, `opus`, `sonnet`, `haiku`)
- Gemini models
- MLX models (`mlx/`, `mlx-community/`)
- Qwen models

This fallback is overridden by explicit per-model `apiMode` settings in metadata.

### Debug Logging

All log output is silent by default to prevent TUI pollution (which can cause tool call aborts in OpenCode). To enable debug logging, set the `OMNIROUTE_DEBUG` environment variable:

```bash
OMNIROUTE_DEBUG=1 opencode
```

This enables all `[OmniRoute]` prefixed log messages for intercepted requests, model fetching, cache behavior, combo resolution, and schema sanitization.

---

## API Mode

The plugin supports two API modes:

| Mode | SDK | Endpoint | Use Case |
|------|-----|----------|----------|
| `chat` | `@ai-sdk/openai-compatible` | `/chat/completions` | Default. Works with all OmniRoute proxied models including GitHub Copilot, Anthropic, and custom endpoints. |
| `responses` | `@ai-sdk/openai` | `/responses` | For direct OpenAI models that support the Responses API. Requires compatible upstream. |

The `chat` mode uses `@ai-sdk/openai-compatible` specifically because `@ai-sdk/openai` has stricter response format expectations for tool calls that OmniRoute proxied models may not satisfy.

---

## Model Metadata Overrides

Model metadata can be configured in two formats:

### Record format

Keys are model IDs. Missing models are created as synthetic entries enriched with models.dev data:

```json
{
  "modelMetadata": {
    "custom/my-model": {
      "name": "My Custom Model",
      "contextWindow": 128000,
      "maxTokens": 8192,
      "supportsVision": true,
      "supportsTools": true,
      "reasoning": true,
      "apiMode": "chat",
      "variants": {
        "xhigh": { "reasoningEffort": "xhigh" }
      }
    }
  }
}
```

### Array-of-blocks format

For pattern matching with `match` (string for exact match, RegExp object for pattern match) and optional `addIfMissing`:

```javascript
// opencode.js
export default {
  provider: {
    omniroute: {
      options: {
        modelMetadata: [
          {
            match: /^anthropic\//,
            apiMode: "chat",
            supportsVision: true,
          },
          {
            match: "custom/my-special-model",
            addIfMissing: true,
            contextWindow: 256000,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
};
```

### Available metadata fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Display name |
| `description` | `string` | Model description |
| `contextWindow` | `number` | Context window size in tokens |
| `maxTokens` | `number` | Maximum output tokens |
| `supportsStreaming` | `boolean` | Streaming support |
| `supportsVision` | `boolean` | Image input support |
| `supportsTools` | `boolean` | Tool/function calling support |
| `apiMode` | `"chat" \| "responses"` | Per-model API mode override |
| `reasoning` | `boolean` | Whether the model supports reasoning effort controls |
| `resetEmbeddedReasoningVariant` | `boolean` | Restore generated variants for models with embedded effort suffixes |
| `variants` | `Record<string, unknown>` | Custom variant definitions merged with auto-generated ones |
| `pricing` | `{ input?: number; output?: number }` | Cost per token |

---

## Runtime Exports

The package exposes a `./runtime` subpath for programmatic use:

```typescript
import {
  fetchModels,
  clearModelCache,
  refreshModels,
  getCachedModels,
  isCacheValid,
  clearModelsDevCache,
  clearComboCache,
  fetchComboData,
  resolveUnderlyingModels,
  calculateModelCapabilities,
  OMNIROUTE_PROVIDER_ID,
  OMNIROUTE_DEFAULT_MODELS,
  OMNIROUTE_ENDPOINTS,
  MODEL_CACHE_TTL,
  REQUEST_TIMEOUT,
} from "@cedrugs/opencode-omniauth/runtime";
```

---

## Project Structure

```
src/
  constants.ts        Debug-gated logging, provider ID, endpoints, defaults, cache TTLs
  types.ts            TypeScript interfaces for models, config, provider models, metadata
  plugin.ts           Main plugin: config hook, auth hook, fetch interceptor, payload normalization,
                      reasoning variants, per-model apiMode, Gemini schema sanitization
  models.ts           Model fetching, caching, models.dev enrichment, multi-strategy lookup,
                      configured metadata application, synthetic model creation
  models-dev.ts       models.dev API fetching, index building, normalization, provider aliases
  omniroute-combos.ts Combo model fetching, underlying model resolution, capability calculation
index.ts              Plugin entry point and type exports
runtime.ts            Runtime subpath exports for programmatic use
test/
  models.test.mjs     Model fetching, caching, snake_case mapping tests
  plugin.test.mjs     Config hook, auth, schema sanitization, payload normalization tests
```

---

## Development

```bash
git clone https://github.com/cedrugs/opencode-omniauth.git
cd opencode-omniauth
npm install
npm run dev       # Watch mode (recompiles on file changes)
```

### Build

```bash
npm run build     # One-time TypeScript compilation
npm run clean     # Remove dist/ output
```

### Type checking

```bash
npx tsc --noEmit
```

---

## Testing

```bash
npm test
```

This runs `npm run build` followed by `node --test test/*.test.mjs`. The test suite covers:

- Model fetching with cache behavior and forced refresh
- Fallback to defaults on invalid API responses
- Snake_case API field mapping to camelCase interface
- Config hook defaults and apiMode normalization
- Responses mode npm package selection
- Auth header injection scoped to OmniRoute URLs only
- Gemini tool schema sanitization ($schema, additionalProperties stripping)
- Non-Gemini tool schema preservation (additionalProperties: false kept intact)
- $ref inline resolution with nested definitions
- Circular $ref safety
- Responses endpoint Request object handling
- Responses payload stripping of unsupported fields
- Chat payload reasoning summary alias stripping
- reasoningEffort normalization to reasoning.effort object

---

## Troubleshooting

### Tool calls abort immediately

Verify that the plugin is using `@ai-sdk/openai-compatible` for chat mode (the default). If you or a previous version switched to `@ai-sdk/openai`, tool calls through OmniRoute proxied models will fail because that SDK has stricter response format expectations.

Check that `apiMode` is set to `"chat"` (the default) unless you specifically need `"responses"` mode with a compatible upstream.

### Models not appearing

1. Check that your OmniRoute instance is running and accessible at the configured `baseURL`
2. Run `/connect omniroute` in OpenCode to set up your API key
3. Enable debug logging with `OMNIROUTE_DEBUG=1 opencode` to see fetch attempts and errors
4. Verify the `/v1/models` endpoint returns a valid `{ object: "list", data: [...] }` response

### models.dev enrichment not working

1. Check network connectivity to `https://models.dev/api.json` (or your configured URL)
2. The default timeout is 1000ms; increase `modelsDev.timeoutMs` if on a slow connection
3. Set `modelsDev.enabled: false` to disable enrichment entirely if it causes issues

### Gemini tool calls fail

The plugin automatically sanitizes tool schemas for Gemini models. If you encounter issues, enable debug logging to verify the sanitization is running (`[OmniRoute] Sanitized Gemini tool schema keywords`).

### No log output

All logging is silent by default. Set `OMNIROUTE_DEBUG=1` as an environment variable to enable output.

---

## License

[MIT](https://github.com/cedrugs/opencode-omniauth/blob/main/LICENSE)

Maintained by [@cedrugs](https://github.com/cedrugs).

Originally forked from [Alph4d0g/opencode-omniroute-auth](https://github.com/Alph4d0g/opencode-omniroute-auth).

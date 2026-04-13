export type OmniRouteApiMode = 'chat' | 'responses';

export interface OmniRouteModel {
	id: string;
	name: string;
	description?: string;
	root?: string;
	owned_by?: string;
	contextWindow?: number;
	maxTokens?: number;
	supportsStreaming?: boolean;
	supportsVision?: boolean;
	supportsTools?: boolean;
	apiMode?: OmniRouteApiMode;
	reasoning?: boolean;
	resetEmbeddedReasoningVariant?: boolean;
	variants?: Record<string, unknown>;
	pricing?: {
		input?: number;
		output?: number;
	};
}

export interface OmniRouteModelMetadata {
	name?: string;
	description?: string;
	contextWindow?: number;
	maxTokens?: number;
	supportsStreaming?: boolean;
	supportsVision?: boolean;
	supportsTools?: boolean;
	apiMode?: OmniRouteApiMode;
	reasoning?: boolean;
	resetEmbeddedReasoningVariant?: boolean;
	variants?: Record<string, unknown>;
	pricing?: {
		input?: number;
		output?: number;
	};
}

export interface OmniRouteModelMetadataBlock extends OmniRouteModelMetadata {
	match: string | RegExp;
	addIfMissing?: boolean;
}

export type OmniRouteModelMetadataConfig =
	| Record<string, OmniRouteModelMetadata>
	| OmniRouteModelMetadataBlock[];

export interface OmniRouteModelsDevConfig {
	enabled?: boolean;
	url?: string;
	cacheTtl?: number;
	timeoutMs?: number;
	providerAliases?: Record<string, string>;
}

export interface OmniRouteModelsResponse {
	object: 'list';
	data: OmniRouteModel[];
}

export interface OmniRouteConfig {
	baseUrl: string;
	apiKey: string;
	apiMode: OmniRouteApiMode;
	defaultModels?: OmniRouteModel[];
	modelCacheTtl?: number;
	refreshOnList?: boolean;
	modelsDev?: OmniRouteModelsDevConfig;
	modelMetadata?: OmniRouteModelMetadataConfig;
}

export interface OmniRouteProviderModelModalities {
	text: boolean;
	image: boolean;
	audio: boolean;
	video: boolean;
	pdf: boolean;
}

export interface OmniRouteProviderModel {
	id: string;
	name: string;
	providerID: string;
	family: string;
	release_date: string;
	api: {
		id: string;
		url: string;
		npm: string;
	};
	capabilities: {
		temperature: boolean;
		reasoning: boolean;
		attachment: boolean;
		toolcall: boolean;
		input: OmniRouteProviderModelModalities;
		output: OmniRouteProviderModelModalities;
		interleaved: boolean;
	};
	modalities?: {
		input: string[];
		output: string[];
	};
	cost: {
		input: number;
		output: number;
		cache: {
			read: number;
			write: number;
		};
	};
	limit: {
		context: number;
		output: number;
	};
	options: Record<string, unknown>;
	headers: Record<string, string>;
	status: 'active';
	variants: Record<string, unknown>;
}

export interface OmniRouteError {
	error: {
		message: string;
		type: string;
		code?: string;
	};
}

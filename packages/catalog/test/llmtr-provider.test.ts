/**
 * LLMTR chat gateway: public /v1/models is not a key check, discovered ids
 * stay intact (including an embedded llmtr/ prefix), and chat requests go to
 * /v1/chat/completions with max_tokens and no Responses reasoning object.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getEnvApiKey, getEnvApiKeyName } from "@oh-my-pi/pi-ai/env-api-key";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { apiRouteFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { providerEntry, seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import { llmtrModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Model } from "@oh-my-pi/pi-catalog/types";

const BASE_URL = "https://llmtr.com/v1";
const VERIFIED_ID = "minimax/minimax-m3.1-flash";
const PREFIXED_ID = "llmtr/minimax/minimax-m3.1-flash";

const originalKey = Bun.env.LLMTR_API_KEY;

afterEach(() => {
	if (originalKey === undefined) delete Bun.env.LLMTR_API_KEY;
	else Bun.env.LLMTR_API_KEY = originalKey;
});

const verifiedRecord = {
	id: VERIFIED_ID,
	object: "model",
	owned_by: "minimax",
	supported_operations: ["CHAT_COMPLETIONS"],
	supported_endpoints: ["/v1/chat/completions"],
	name: "MiniMax M3.1 Flash",
	context_length: 1000000,
	architecture: {
		modality: "text+image+video->text",
		input_modalities: ["text", "image", "video"],
		output_modalities: ["text"],
	},
	pricing: {
		prompt: "0.00000015",
		completion: "0.0000006",
		input_cache_read: "0.000000015",
	},
	top_provider: {
		context_length: 1000000,
		max_completion_tokens: 524288,
		is_moderated: false,
	},
	reasoning: {
		mandatory: true,
		default_enabled: true,
		supported_efforts: ["low", "medium", "high", "xhigh", "max"],
	},
};

function rosterFetch(data: unknown[]): {
	calls: Array<{ url: string; authorization: string | null }>;
	fetch: FetchImpl;
} {
	const calls: Array<{ url: string; authorization: string | null }> = [];
	const fetch: FetchImpl = async (input, init) => {
		calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		return new Response(JSON.stringify({ object: "list", data }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { calls, fetch };
}

function chatFetch(): {
	calls: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }>;
	fetch: FetchImpl;
} {
	const calls: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
	const fetch: FetchImpl = async (input, init) => {
		const parsed: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
		calls.push({
			url: String(input),
			authorization: new Headers(init?.headers).get("authorization"),
			body: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {},
		});
		const chunk = JSON.stringify({
			id: "chatcmpl-llmtr",
			object: "chat.completion.chunk",
			created: 0,
			model: "llmtr",
			choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
		});
		return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	return { calls, fetch };
}

const context: Context = {
	messages: [{ role: "user", content: "Reply with the single word ok.", timestamp: 0 }],
};

function verifiedModel(): Model<"openai-completions"> {
	const seed = seedModels("llmtr").find(model => model.id === VERIFIED_ID);
	if (!seed) throw new Error("LLMTR verified seed missing");
	return buildModel(seed) as Model<"openai-completions">;
}

describe("LLMTR catalog", () => {
	test("registers the chat gateway, env key, and chat-completions login probe", () => {
		expect(providerEntry("llmtr")?.defaultModel).toBe(VERIFIED_ID);
		expect(providerEntry("llmtr")?.allowUnauthenticated).toBe(true);
		expect(getEnvApiKeyName("llmtr")).toBe("LLMTR_API_KEY");
		Bun.env.LLMTR_API_KEY = "llmtr-env-key";
		expect(getEnvApiKey("llmtr")).toBe("llmtr-env-key");

		const login = authPolicyFor("llmtr")?.login;
		expect(login?.kind).toBe("api-key");
		if (login?.kind !== "api-key") return;
		expect(login.validate).toMatchObject({
			kind: "chat-completions",
			baseUrl: BASE_URL,
			model: VERIFIED_ID,
			maxTokensField: "max_tokens",
			maxTokens: 1,
		});
	});

	test("public model listing keeps full ids and the published metrics", async () => {
		const keyless = rosterFetch([
			verifiedRecord,
			{
				id: PREFIXED_ID,
				name: PREFIXED_ID,
				supported_operations: ["CHAT_COMPLETIONS"],
				supported_endpoints: ["/v1/chat/completions"],
			},
			{ id: "llmtr/embed", supported_operations: ["EMBEDDINGS"], supported_endpoints: ["/v1/embeddings"] },
		]);
		const withoutKey = (await llmtrModelManagerOptions({ fetch: keyless.fetch }).fetchDynamicModels?.()) ?? [];
		expect(keyless.calls).toEqual([{ url: `${BASE_URL}/models`, authorization: null }]);
		expect(withoutKey.map(model => model.id)).toEqual([PREFIXED_ID, VERIFIED_ID]);

		const prefixed = withoutKey.find(model => model.id === PREFIXED_ID);
		expect(prefixed).toMatchObject({
			id: PREFIXED_ID,
			api: "openai-completions",
			provider: "llmtr",
			baseUrl: BASE_URL,
			contextWindow: null,
			maxTokens: null,
		});
		expect(prefixed && getModelPricingStatus(prefixed)).toBe("unknown");

		const verified = withoutKey.find(model => model.id === VERIFIED_ID);
		expect(verified).toMatchObject({
			id: VERIFIED_ID,
			name: "MiniMax M3.1 Flash",
			api: "openai-completions",
			baseUrl: BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1000000,
			maxTokens: 524288,
			cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
				requiresEffort: true,
			},
		});

		const keyed = rosterFetch([verifiedRecord]);
		await llmtrModelManagerOptions({ apiKey: "llmtr-test-key", fetch: keyed.fetch }).fetchDynamicModels?.();
		expect(keyed.calls).toEqual([{ url: `${BASE_URL}/models`, authorization: "Bearer llmtr-test-key" }]);
	});

	test("routes every id to chat completions without stripping llmtr/", () => {
		expect(apiRouteFor("llmtr", PREFIXED_ID)).toEqual({ api: "openai-completions" });
		expect(apiRouteFor("llmtr", VERIFIED_ID)).toEqual({ api: "openai-completions" });
		expect(apiRouteFor("llmtr", "gpt-5.4")).toEqual({ api: "openai-completions" });
		expect(apiRouteFor("llmtr", "llmtr/gpt-5.4")?.requestModelId).toBeUndefined();
	});
});

describe("LLMTR chat request", () => {
	test("posts max_tokens 64 to chat completions and omits the reasoning object", async () => {
		Bun.env.LLMTR_API_KEY = "llmtr-env-key";
		const captured = chatFetch();
		const model = verifiedModel();
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe(BASE_URL);
		expect(model.compat.maxTokensField).toBe("max_tokens");
		expect(model.compat.thinkingFormat).toBe("openai");

		const result = await streamOpenAICompletions(model, context, {
			fetch: captured.fetch,
			maxTokens: 64,
			maxHttpAttempts: 1,
			acceptEmptyResponse: true,
		}).result();
		expect(result.stopReason).not.toBe("error");
		expect(captured.calls).toHaveLength(1);
		expect(captured.calls[0]).toMatchObject({
			url: `${BASE_URL}/chat/completions`,
			authorization: "Bearer llmtr-env-key",
		});
		expect(captured.calls[0]?.body.model).toBe(VERIFIED_ID);
		expect(captured.calls[0]?.body.max_tokens).toBe(64);
		expect(captured.calls[0]?.body).not.toHaveProperty("reasoning");
		expect(captured.calls[0]?.body).not.toHaveProperty("reasoning_effort");
		expect(captured.calls[0]?.body).not.toHaveProperty("tools");
		expect(String(captured.calls[0]?.url)).not.toContain("/responses");
	});

	test("keeps an embedded llmtr/ prefix on the wire and sends reasoning_effort instead of a reasoning object", async () => {
		const captured = chatFetch();
		const model = buildModel({
			id: "llmtr/gpt-5.4",
			name: "llmtr/gpt-5.4",
			api: "openai-completions",
			provider: "llmtr",
			baseUrl: BASE_URL,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
				requiresEffort: true,
			},
		}) as Model<"openai-completions">;

		await streamOpenAICompletions(model, context, {
			apiKey: "llmtr-test-key",
			fetch: captured.fetch,
			maxTokens: 64,
			maxHttpAttempts: 1,
			acceptEmptyResponse: true,
			reasoning: Effort.Low,
		}).result();

		expect(captured.calls[0]?.url).toBe(`${BASE_URL}/chat/completions`);
		expect(captured.calls[0]?.body.model).toBe("llmtr/gpt-5.4");
		expect(captured.calls[0]?.body.max_tokens).toBe(64);
		expect(captured.calls[0]?.body.reasoning_effort).toBe("low");
		expect(captured.calls[0]?.body).not.toHaveProperty("reasoning");

		const disabled = chatFetch();
		await streamOpenAICompletions(model, context, {
			apiKey: "llmtr-test-key",
			fetch: disabled.fetch,
			maxTokens: 64,
			maxHttpAttempts: 1,
			acceptEmptyResponse: true,
			disableReasoning: true,
		}).result();
		expect(disabled.calls[0]?.body.reasoning_effort).toBe("low");
		expect(disabled.calls[0]?.body).not.toHaveProperty("reasoning");
		expect(disabled.calls[0]?.body.model).toBe("llmtr/gpt-5.4");
	});
});

/**
 * One LLMTR chat through the catalog seed and the Chat Completions transport.
 *
 *   LLMTR_API_KEY=... bun packages/catalog/scripts/llmtr-chat-smoke.ts
 *   LLMTR_API_KEY=... bun packages/catalog/scripts/llmtr-chat-smoke.ts <model-id>
 *   LLMTR_MODEL=<model-id> overrides the argument.
 *
 * Sends one user message, no tools, max_tokens 64, and a single HTTP attempt.
 * The default model is the reviewed minimax/minimax-m3.1-flash seed. Any other
 * id is sent unchanged on the same route without invented limits or prices.
 * The reasoning parameter is omitted. This entry does not call /v1/models.
 */
import { getEnvApiKey } from "@oh-my-pi/pi-ai/env-api-key";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

const DEFAULT_ID = "minimax/minimax-m3.1-flash";
const BASE_URL = "https://llmtr.com/v1";

function modelId(): string {
	const fromEnv = Bun.env.LLMTR_MODEL?.trim();
	if (fromEnv) return fromEnv;
	const args = Bun.argv.slice(1).filter(arg => {
		if (arg === import.meta.path) return false;
		if (arg.endsWith("llmtr-chat-smoke.ts") || arg.endsWith("llmtr-chat-smoke")) return false;
		return !arg.startsWith("-");
	});
	return args[0]?.trim() || DEFAULT_ID;
}

function modelFor(id: string): Model<"openai-completions"> {
	const seed = seedModels<"openai-completions">("llmtr").find(entry => entry.id === id);
	const spec: ModelSpec<"openai-completions"> = seed ?? {
		id,
		name: id,
		api: "openai-completions",
		provider: "llmtr",
		baseUrl: BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		pricingStatus: "unknown",
	};
	return buildModel(spec) as Model<"openai-completions">;
}

const apiKey = getEnvApiKey("llmtr");
if (!apiKey) {
	console.error("LLMTR_API_KEY is not set");
	process.exit(1);
}

const id = modelId();
const model = modelFor(id);
const context: Context = {
	messages: [{ role: "user", content: "Reply with the single word ok.", timestamp: 0 }],
};

const message = await streamOpenAICompletions(model, context, {
	apiKey,
	maxTokens: 64,
	maxHttpAttempts: 1,
	acceptEmptyResponse: true,
}).result();

if (message.stopReason === "error" || message.errorMessage) {
	console.error(message.errorMessage ?? "LLMTR chat failed");
	process.exit(1);
}

const text = message.content
	.filter(block => block.type === "text")
	.map(block => block.text)
	.join("");
if (text.length > 0) console.log(text);
console.error(`llmtr chat stop=${message.stopReason} model=${model.id}`);

/**
 * One LLMTR chat through the reviewed seed and the Chat Completions transport.
 *
 *   LLMTR_API_KEY=... bun packages/catalog/scripts/llmtr-chat-smoke.ts
 *
 * The model is exactly `minimax/minimax-m3.1-flash`. One user message, no
 * tools, `max_tokens` 64, no reasoning fields. One POST, redirects rejected,
 * aborted at 120s. No model list, discovery, or auth preflight. Exits 0 only
 * when the response is HTTP-success and the assistant text is non-empty.
 */
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";

const MODEL_ID = "minimax/minimax-m3.1-flash";
const SMOKE_MS = 120_000;

export async function runLlmtrChatSmoke(fetchImpl: FetchImpl = fetch): Promise<number> {
	const apiKey = Bun.env.LLMTR_API_KEY?.trim();
	if (!apiKey) {
		console.error("LLMTR_API_KEY is not set");
		return 1;
	}
	const seed = seedModels<"openai-completions">("llmtr").find(entry => entry.id === MODEL_ID);
	if (!seed) {
		console.error(`LLMTR seed ${MODEL_ID} is missing`);
		return 1;
	}
	const model = buildModel(seed) as Model<"openai-completions">;
	let posts = 0;
	const boundedFetch: FetchImpl = async (input, init) => {
		posts += 1;
		if (posts > 1) {
			throw new Error("LLMTR smoke refused a second request");
		}
		const method = (init?.method ?? "GET").toUpperCase();
		if (method !== "POST") {
			throw new Error(`LLMTR smoke refused ${method}`);
		}
		const timeout = AbortSignal.timeout(SMOKE_MS);
		const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
		return fetchImpl(input, { ...init, redirect: "error", signal });
	};
	const context: Context = {
		messages: [{ role: "user", content: "Reply with the single word ok.", timestamp: 0 }],
	};
	const message = await streamOpenAICompletions(model, context, {
		apiKey,
		maxTokens: 64,
		maxHttpAttempts: 1,
		acceptEmptyResponse: true,
		fetch: boundedFetch,
		streamFirstEventTimeoutMs: SMOKE_MS,
		streamIdleTimeoutMs: SMOKE_MS,
	}).result();
	const text = message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("")
		.trim();
	if (message.stopReason === "error" || message.errorMessage || text.length === 0) {
		console.error(message.errorMessage ?? `LLMTR chat failed stop=${message.stopReason}`);
		return 1;
	}
	console.log(text);
	console.error(`PASS llmtr chat stop=${message.stopReason} model=${model.id}`);
	return 0;
}

if (import.meta.main) {
	process.exit(await runLlmtrChatSmoke());
}

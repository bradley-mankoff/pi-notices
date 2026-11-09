/**
 * The outside service the Notices tests talk to: a pi provider that answers each request
 * with one line and records the conversation it was sent, so a test can see which turn
 * first carried a Notice.
 *
 * NOTICES_TEST_LOG: one JSON object a line per request: when it started, and the text of
 * each message it was sent.
 * NOTICES_TEST_DELAY_MS: how long to hold the answer, so a turn is still running when the
 * test writes a Notice into the file.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const api = "notices-test";
const log = process.env.NOTICES_TEST_LOG ?? "/dev/null";
const delayMs = Number(process.env.NOTICES_TEST_DELAY_MS ?? 0);

const model = (id: string) => ({
	id,
	name: id,
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
});

const message = (requested: Model<Api>, text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: requested.api,
	provider: requested.provider,
	model: requested.id,
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
});

export default function noticesTestProvider(pi: ExtensionAPI): void {
	const streamSimple = (requested: Model<Api>, context: unknown, _options?: SimpleStreamOptions) => {
		appendFileSync(
			log,
			`${JSON.stringify({
				at: Date.now(),
				messages: ((context as { messages?: unknown[] }).messages ?? []).map(textOf),
			})}\n`,
		);
		const stream = createAssistantMessageEventStream();
		const answer = () => {
			const text = "answered";
			const reply = message(requested, text);
			stream.push({ type: "start", partial: reply });
			stream.push({ type: "text_start", contentIndex: 0, partial: reply });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: reply });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: reply });
			stream.push({ type: "done", reason: "stop", message: reply });
		};
		if (delayMs > 0) setTimeout(answer, delayMs);
		else queueMicrotask(answer);
		return stream;
	};

	pi.registerProvider("notices-test", {
		name: "Notices test provider",
		api,
		apiKey: "test-key",
		baseUrl: "http://localhost:0",
		models: [model("reply")],
		streamSimple,
	});
}

/** The text a message carries (copied from pi-flows, so this fixture stands alone). */
const textOf = (message: unknown): string => {
	if (typeof message !== "object" || message === null) return "";
	const { content } = message as { content?: unknown };
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const { type, text } = part as { type?: unknown; text?: unknown };
			return type === "text" && typeof text === "string" ? [text] : [];
		})
		.join("\n");
};

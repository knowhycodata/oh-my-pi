/**
 * Bundle the LLMTR smoke into one JS file for bun.
 *
 * The entry uses the reviewed seed, `buildModel`, and `streamOpenAICompletions`.
 * Two import edges load `@oh-my-pi/pi-natives` at startup even though this chat
 * never calls them: the pi-utils barrel re-exports mermaid, file locks, and
 * process helpers, and `getEnvApiKey` constructs the full provider registry
 * (Apple Foundation Models and the desktop OAuth callback). This build omits
 * those unused edges. It does not alias or replace the natives addon.
 *
 *   bun packages/catalog/scripts/build-llmtr-chat-smoke.ts [outfile]
 */
import * as path from "node:path";
import type { BunPlugin } from "bun";

const entry = path.join(import.meta.dir, "llmtr-chat-smoke.ts");
const outfile = process.argv[2] ?? path.join(import.meta.dir, "../../../dist/llmtr-chat-smoke.js");

const utilsIndex = path.join(import.meta.dir, "../../utils/src/index.ts");
const envApiKey = path.join(import.meta.dir, "../../ai/src/env-api-key.ts");

const dropBarrel =
	/^\s*export\s+(?:\*\s+as\s+\w+\s+from|\*\s+from|\{\s*AbortError,\s*ChildProcess,\s*Exception,\s*NonZeroExitError\s*\}\s+from)\s+"\.\/(?:mermaid-ascii|file-lock|procmgr|ptree|sqlite|runtime-install)";\s*$/;

const plugin: BunPlugin = {
	name: "llmtr-smoke-unused-native-edges",
	setup(build) {
		build.onLoad({ filter: /index\.ts$/ }, async args => {
			if (!args.path.endsWith(`${path.sep}packages${path.sep}utils${path.sep}src${path.sep}index.ts`)) return;
			console.error("rewrite utils barrel", args.path);
			const text = await Bun.file(utilsIndex).text();
			const lines = text.split("\n");
			const contents = lines.filter(line => !dropBarrel.test(line)).join("\n");
			console.error(
				`utils barrel lines ${lines.length} -> ${contents.split("\n").length} mermaid-left=${contents.includes("mermaid-ascii")}`,
			);
			return { contents, loader: "ts" };
		});
		build.onLoad({ filter: /env-api-key\.ts$/ }, async args => {
			if (!args.path.endsWith(`${path.sep}packages${path.sep}ai${path.sep}src${path.sep}env-api-key.ts`)) return;
			console.error("rewrite env-api-key", args.path);
			const text = await Bun.file(envApiKey).text();
			const contents = text
				.replace(/\nimport \{ PROVIDER_REGISTRY \} from "\.\/registry";\n/, "\n")
				.replace(
					/\t\.\.\.Object\.fromEntries\(\s*PROVIDER_REGISTRY\.flatMap\(provider =>\s*provider\.envKeys != null \? \[\[provider\.id, provider\.envKeys\] as \[string, KeyResolver\]\] : \[\],\s*\),\s*\),\n/,
					"",
				);
			console.error(`env-api-key registry-left=${contents.includes("PROVIDER_REGISTRY")}`);
			if (contents.includes("PROVIDER_REGISTRY")) {
				throw new Error("env-api-key rewrite still references PROVIDER_REGISTRY");
			}
			return { contents, loader: "ts" };
		});
	},
};

const result = await Bun.build({
	entrypoints: [entry],
	target: "bun",
	minify: true,
	outfile,
	plugins: [plugin],
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
const output = result.outputs[0];
if (!output) {
	console.error("bun build produced no output");
	process.exit(1);
}
const bytes = await output.text();
await Bun.write(outfile, bytes);
if (bytes.includes("const nativeBindings = loadNative()") || bytes.includes("nativeBindings=loadNative()")) {
	console.error("bundle still evaluates pi-natives at import");
	process.exit(1);
}
console.error(`wrote ${outfile} (${output.size} bytes)`);

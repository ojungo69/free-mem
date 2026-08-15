import { builtinModules } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const coreVersion = String(
	(JSON.parse(readFileSync(resolve(import.meta.dirname, "../core/package.json"), "utf8")) as {
		version: unknown;
	}).version,
);

export default defineConfig({
	define: { __CODEMEM_VERSION__: JSON.stringify(coreVersion) },
	resolve: {
		preserveSymlinks: true,
		alias: {
			"@codemem/core": resolve(import.meta.dirname, "src/hook-core.ts"),
		},
		conditions: ["source"],
	},
	build: {
		target: "node24",
		lib: {
			entry: resolve(import.meta.dirname, "src/hook-runtime.ts"),
			formats: ["es"],
			fileName: "hook-runtime",
		},
		rollupOptions: {
			external: [/^node:/, ...builtinModules],
			output: {
				banner:
					'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
			},
		},
		outDir: "dist",
		emptyOutDir: false,
		minify: false,
		sourcemap: false,
	},
});

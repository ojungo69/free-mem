import { resolve } from "node:path";
import license from "rollup-plugin-license";
import { defineConfig } from "vitest/config";

export default defineConfig({
	build: {
		lib: {
			entry: {
				index: resolve(import.meta.dirname, "src/index.ts"),
			},
			formats: ["es"],
			fileName: (_format, entryName) => `${entryName}.js`,
		},
		rollupOptions: {
			external: [
				"better-sqlite3",
				"sqlite-vec",
				"@xenova/transformers",
				"drizzle-orm",
				/^drizzle-orm\//,
				/^node:/,
			],
			plugins: [
				license({
					thirdParty: {
						includePrivate: false,
						output: {
							file: resolve(import.meta.dirname, "dist/THIRD_PARTY_NOTICES.md"),
						},
					},
				}),
			],
		},
		outDir: "dist",
		sourcemap: true,
		emptyOutDir: true,
	},
	test: {
		name: "core",
	},
});

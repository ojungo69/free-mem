import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryStore } from "../store.js";
import { openTestMemoryStore } from "../test-utils.js";
import { memoryRoutes } from "./memory.js";

const REPOSITORY_A = `repo-v1:sha256:${"a".repeat(64)}`;
const REPOSITORY_B = `repo-v1:sha256:${"b".repeat(64)}`;

type Fixture = {
	name: string;
	sensitivity: "eligible" | "local_only" | "private" | "secret";
	repositoryIdentity: string | null;
	sessionId: number;
};

describe("viewer memory privacy boundary", () => {
	let dir: string;
	let store: MemoryStore;
	let fixtures: Fixture[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "codemem-viewer-memory-"));
		store = openTestMemoryStore(join(dir, "memory.sqlite"));
		fixtures = [
			{ name: "eligible-same", sensitivity: "eligible", repositoryIdentity: REPOSITORY_A },
			{ name: "eligible-unknown", sensitivity: "eligible", repositoryIdentity: null },
			{ name: "local-only-same", sensitivity: "local_only", repositoryIdentity: REPOSITORY_A },
			{ name: "private-cross", sensitivity: "private", repositoryIdentity: REPOSITORY_B },
			{ name: "secret-unknown", sensitivity: "secret", repositoryIdentity: null },
		].map((fixture, index) => {
			const now = `2026-09-01T00:00:0${index}.000Z`;
			const session = store.db
				.prepare(
					`INSERT INTO sessions(
						started_at, cwd, project, git_remote, git_branch, user,
						tool_version, metadata_json, repository_identity
					 ) VALUES (?, ?, ?, ?, ?, ?, 'test', ?, ?)`,
				)
				.run(
					now,
					`/${fixture.name}-cwd-sentinel`,
					fixture.name,
					`${fixture.name}-git-remote-sentinel`,
					`${fixture.name}-branch-sentinel`,
					`${fixture.name}-user-sentinel`,
					JSON.stringify({ sentinel: `${fixture.name}-metadata-sentinel` }),
					fixture.repositoryIdentity,
				);
			const sessionId = Number(session.lastInsertRowid);
			for (const [kind, suffix] of [
				["discovery", "observation"],
				["session_summary", "summary"],
			] as const) {
				store.db
					.prepare(
						`INSERT INTO memory_items(
							session_id, kind, title, body_text, active, created_at, updated_at,
							metadata_json, project, sensitivity, repository_identity
						 ) VALUES (?, ?, ?, ?, 1, ?, ?, '{}', ?, ?, ?)`,
					)
					.run(
						sessionId,
						kind,
						`${fixture.name}-${suffix}-title`,
						`${fixture.name}-${suffix}-body-sentinel`,
						now,
						now,
						fixture.name,
						fixture.sensitivity,
						fixture.repositoryIdentity,
					);
			}
			store.db
				.prepare(
					`INSERT INTO user_prompts(
						session_id, project, prompt_text, prompt_number, created_at,
						created_at_epoch, metadata_json, sensitivity, repository_identity
					 ) VALUES (?, ?, ?, 1, ?, ?, '{}', ?, ?)`,
				)
				.run(
					sessionId,
					fixture.name,
					`${fixture.name}-prompt-sentinel`,
					now,
					index,
					fixture.sensitivity,
					fixture.repositoryIdentity,
				);
			store.db
				.prepare(
					`INSERT INTO artifacts(
						session_id, kind, path, content_text, created_at, metadata_json,
						sensitivity, repository_identity
					 ) VALUES (?, 'note', ?, ?, ?, '{}', ?, ?)`,
				)
				.run(
					sessionId,
					`${fixture.name}-artifact-path-sentinel`,
					`${fixture.name}-artifact-body-sentinel`,
					now,
					fixture.sensitivity,
					fixture.repositoryIdentity,
				);
			return { ...fixture, sessionId };
		});
		const eligibleParent = fixtures.find((fixture) => fixture.name === "eligible-same");
		if (!eligibleParent) throw new Error("eligible viewer fixture missing");
		store.db
			.prepare(
				`INSERT INTO user_prompts(
					session_id, project, prompt_text, prompt_number, created_at,
					created_at_epoch, metadata_json, sensitivity, repository_identity
				 ) VALUES (?, ?, 'eligible-parent-secret-prompt-sentinel', 2, ?, 10, '{}', 'secret', ?)`,
			)
			.run(
				eligibleParent.sessionId,
				eligibleParent.name,
				"2026-09-01T00:00:10.000Z",
				eligibleParent.repositoryIdentity,
			);
		store.db
			.prepare(
				`INSERT INTO artifacts(
					session_id, kind, path, content_text, created_at, metadata_json,
					sensitivity, repository_identity
				 ) VALUES (?, 'note', 'eligible-parent-secret-path-sentinel',
					'eligible-parent-secret-artifact-sentinel', ?, '{}', 'secret', ?)`,
			)
			.run(eligibleParent.sessionId, "2026-09-01T00:00:10.000Z", eligibleParent.repositoryIdentity);
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns only eligible observations, summaries, and recent memories without cwd", async () => {
		const routes = memoryRoutes(() => store);
		const responses = await Promise.all(
			["/api/observations", "/api/summaries", "/api/memory"].map(async (path) => {
				const response = await routes.request(path);
				return [path, response.status, await response.json()] as const;
			}),
		);

		for (const [path, status, rawBody] of responses) {
			const body = rawBody as { items: Array<Record<string, unknown>> };
			expect(status, path).toBe(200);
			expect(body.items).toHaveLength(path === "/api/memory" ? 4 : 2);
			expect(
				body.items.every((item) => item.sensitivity === "eligible"),
				path,
			).toBe(true);
			for (const item of body.items) expect(item).not.toHaveProperty("cwd");
			const serialized = JSON.stringify(body);
			expect(serialized, path).not.toContain("local-only-same");
			expect(serialized, path).not.toContain("private-cross");
			expect(serialized, path).not.toContain("secret-unknown");
			expect(serialized, path).not.toContain("cwd-sentinel");
		}
	});

	it("returns eligible projects, prompt/artifact counts, and safe session shells", async () => {
		const routes = memoryRoutes(() => store);
		const projects = (await (await routes.request("/api/projects")).json()) as {
			projects: string[];
		};
		const counts = (await (await routes.request("/api/session")).json()) as Record<string, number>;
		const sessions = (await (await routes.request("/api/sessions")).json()) as {
			items: Array<Record<string, unknown>>;
		};

		expect(projects.projects).toEqual(["eligible-same", "eligible-unknown"]);
		expect(counts).toEqual({
			total: 8,
			memories: 4,
			artifacts: 2,
			prompts: 2,
			observations: 2,
		});
		expect(sessions.items.map((item) => item.project).sort()).toEqual([
			"eligible-same",
			"eligible-unknown",
		]);
		for (const item of sessions.items) {
			for (const field of ["cwd", "git_remote", "git_branch", "user", "metadata_json"]) {
				expect(item).not.toHaveProperty(field);
			}
		}
		const serialized = JSON.stringify({ projects, counts, sessions });
		expect(serialized).not.toContain("local-only-same");
		expect(serialized).not.toContain("private-cross");
		expect(serialized).not.toContain("secret-unknown");
		expect(serialized).not.toContain("metadata-sentinel");
	});

	it("returns eligible artifacts and hides sessions whose content is all restricted", async () => {
		const routes = memoryRoutes(() => store);
		const eligible = fixtures.find((fixture) => fixture.name === "eligible-same");
		const restricted = fixtures.find((fixture) => fixture.name === "private-cross");
		if (!eligible || !restricted) throw new Error("viewer fixtures missing");

		const eligibleResponse = await routes.request(
			`/api/artifacts?session_id=${eligible.sessionId}`,
		);
		const eligibleBody = (await eligibleResponse.json()) as {
			items: Array<Record<string, unknown>>;
		};
		const restrictedResponse = await routes.request(
			`/api/artifacts?session_id=${restricted.sessionId}`,
		);

		expect(eligibleResponse.status).toBe(200);
		expect(eligibleBody.items).toHaveLength(1);
		expect(eligibleBody.items[0]).toMatchObject({ sensitivity: "eligible" });
		expect(JSON.stringify(eligibleBody)).not.toContain("eligible-parent-secret");
		expect(restrictedResponse.status).toBe(404);
		expect(JSON.stringify(await restrictedResponse.json())).not.toContain("private-cross");
	});
});

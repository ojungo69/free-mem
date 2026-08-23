import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	type DaemonRpcContext,
	dispatchDaemonRpc,
	LOCAL_API_VERSION,
	NORMALIZED_SCHEMA_VERSION,
	RPC_CAPABILITY_HASH,
} from "./daemon-rpc.js";
import { openTestMemoryStore } from "./test-utils.js";

it("accepts canonical positive integer strings and rejects invalid RPC ids", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codemem-rpc-id-"));
	const store = openTestMemoryStore(join(dir, "test.sqlite"));
	const context = {
		identity: { pid: process.pid, nonce: "rpc-id-test" },
		dataDir: dir,
		onStop: () => {},
		writer: store.db,
		store,
		jobs: { isMaintenanceMode: () => false } as never,
	} as DaemonRpcContext;
	const request = (id: unknown) =>
		JSON.stringify({
			id: "rpc-id-test",
			method: "POST /v1/search",
			adapter_version: "test",
			native_cli_version: "test",
			normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
			local_api_version: LOCAL_API_VERSION,
			capability_hash: RPC_CAPABILITY_HASH,
			body: { requestId: "rpc-id-test", mode: "get_many", ids: [id] },
		});

	try {
		expect(await dispatchDaemonRpc(request("1"), context)).toMatchObject({
			result: { items: [] },
		});
		for (const id of ["0", "01", "-1", "1.5", "", true]) {
			expect(await dispatchDaemonRpc(request(id), context)).toMatchObject({
				error: { code: "invalid_request", message: "id is invalid." },
			});
		}
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

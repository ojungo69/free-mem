import { describe, expect, it } from "vitest";
import { BACKUP_PRIVACY_NOTICE, backupCommand } from "./backup.js";

describe("backup command", () => {
	it("P1-T052-04-backup-privacy-copy", () => {
		const output = backupCommand.configureOutput();
		let help = "";
		try {
			backupCommand.configureOutput({ writeOut: (value) => (help += value) });
			backupCommand.outputHelp();
		} finally {
			backupCommand.configureOutput(output);
		}
		expect(help).toContain(BACKUP_PRIVACY_NOTICE);
		expect(BACKUP_PRIVACY_NOTICE).toMatch(/private.*local-only/i);
		expect(BACKUP_PRIVACY_NOTICE).toMatch(/Phase 1.*off-device.*export/i);
	});
});

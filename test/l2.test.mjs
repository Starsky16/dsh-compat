import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { l2Status, hostVersion } from "../lib/l2.mjs";
import { sha256 } from "../bin/patch.mjs";

/** 合成一棵宿主树 + 一份只含 retired 字段的清单。 */
function fixture(contents, retiredSha) {
	const nm = mkdtempSync(join(tmpdir(), "dsh-l2-"));
	const lib = join(nm, "@deepseek-ai", "dsh-client-modules", "lib");
	mkdirSync(lib, { recursive: true });
	writeFileSync(join(lib, "client.js"), contents);
	const manifestPath = join(nm, "manifest.json");
	writeFileSync(
		manifestPath,
		JSON.stringify({
			schema: 1,
			targets: [
				{
					id: "t",
					pkg: "@deepseek-ai/dsh-client-modules",
					rel: "lib/client.js",
					patch: "p.patch",
					create: false,
					pristine_sha256: sha256("pristine"),
					patched_sha256: sha256("patched"),
					retired: { upstream: "0.2.2-rc.3", sha256: retiredSha ?? sha256("retired") },
				},
			],
		}),
	);
	return { nm, manifestPath };
}

test("l2Status：retired 哈希优先于 drift", () => {
	const { nm, manifestPath } = fixture("retired");
	try {
		const status = l2Status({ nodeModules: nm, manifestPath });
		assert.equal(status.state, "retired");
		assert.equal(status.retired, true);
	} finally {
		rmSync(nm, { recursive: true, force: true });
	}
});

test("l2Status：未知哈希仍是 drift", () => {
	const { nm, manifestPath } = fixture("something-else");
	try {
		assert.equal(l2Status({ nodeModules: nm, manifestPath }).state, "drift");
	} finally {
		rmSync(nm, { recursive: true, force: true });
	}
});

test("l2Status：没有宿主树时 state=skip", () => {
	assert.equal(l2Status({ nodeModules: null }).state, "skip");
});

test("hostVersion：从 dsh-termux/package.json 读取", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-l2-host-"));
	try {
		const nm = join(root, "dsh-termux", "node_modules");
		mkdirSync(nm, { recursive: true });
		writeFileSync(join(root, "dsh-termux", "package.json"), JSON.stringify({ version: "0.2.2-rc.3-tdsh.2" }));
		assert.equal(hostVersion(nm), "0.2.2-rc.3-tdsh.2");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

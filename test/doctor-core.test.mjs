// test/doctor-core.test.mjs
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createDoctor, defaultProfileDir } from "../lib/doctor-core.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = join(ROOT, "test", "fixtures", "probe-profile");

test("createDoctor：fixture 四种判据（PASS / FAIL / WARN / os 映射）", () => {
	const doctor = createDoctor({ profileDir: PROBE, repoRoot: ROOT, platform: "linux", arch: "x64", env: {} });
	const rows = doctor.audit();
	const byName = Object.fromEntries(rows.map((r) => [r.name, r.verdict]));
	assert.equal(byName["dsh-good-plugin"], "PASS");
	assert.equal(byName["dsh-bad-plugin"], "FAIL");
	assert.equal(byName["dsh-os-mismatch"], "FAIL");
	assert.equal(byName["dsh-os-linux"], "PASS");
	assert.equal(byName["dsh-nomanifest"], "WARN");
});

test("defaultProfileDir：优先 web，其次 desktop", () => {
	assert.match(defaultProfileDir({ DSH_HOME: "/tmp/x" }), /profiles\/web$/);
});

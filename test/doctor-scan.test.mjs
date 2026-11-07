import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { scanSpecs, stripComments } from "../lib/specscan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const read = (p) => readFileSync(p, "utf8");

test("specscan：注释里的 from/require/import 不算 specifier（行注释 + 块注释 + JSDoc）", () => {
	const source = `
// 假：from "line-fake"
/* 假：require("block-fake") */
/**
 * "we were not told" has to look different from "nothing".
 */
const real = require("react");
`;
	assert.deepEqual([...scanSpecs(source)], ["react"]);
});

test("specscan：字符串/模板字符串/正则字面量原样保留，真实 specifier 不被误剥", () => {
	const fixture = read(join(ROOT, "test", "fixtures", "specscan", "client-with-comments.js"));
	const specs = [...scanSpecs(fixture)].sort();
	assert.deepEqual(specs, [
		"@deepseek-ai/dsh-client-ui-primitives",
		"@scope/after-regex/client",
		"react",
		"react/jsx-runtime",
	]);
	// 注释内容一个都不该出现
	for (const fake of ["nothing", "line-comment-fake", "block-comment-fake"]) {
		assert.ok(!specs.includes(fake), `不应把注释里的 "${fake}" 当 specifier`);
	}
});

test("specscan：正则里的 `//` 不会截断后续代码（stripComments 只看字面量外的注释）", () => {
	const source = 'const re = /a\\//; const x = require("react");';
	const stripped = stripComments(source);
	assert.match(stripped, /require\("react"\)/);
	assert.deepEqual([...scanSpecs(source)], ["react"]);
});

test("doctor 集成：注释假 specifier 不再导致 FAIL（临时 profile + 假插件）", () => {
	const profile = mkdtempSync(join(tmpdir(), "dsh-doctor-scan-"));
	try {
		const pkgDir = join(profile, "node_modules", "fake-plugin");
		mkdirSync(join(pkgDir, "lib"), { recursive: true });
		writeFileSync(join(profile, "package.json"), JSON.stringify({
			name: "dsh-profile-test",
			dependencies: { "fake-plugin": "1.0.0" },
		}));
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
			name: "fake-plugin",
			version: "1.0.0",
			main: "lib/index.js",
			exports: { ".": "./lib/index.js", "./client": "./lib/client.js" },
			dsh: { client: { platform: "web" } },
		}));
		writeFileSync(join(pkgDir, "lib", "index.js"), "export function apply() {}\n");
		writeFileSync(join(pkgDir, "lib", "client.js"), `
/**
 * "we were not told" has to look different from "nothing".
 */
const a = require("react");
const b = require("@deepseek-ai/dsh-client-ui-primitives");
`);

		const result = spawnSync(process.execPath, [join(ROOT, "bin", "doctor.mjs"), profile], { encoding: "utf8" });
		assert.equal(result.status, 0, `doctor 应全过：\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /PASS\s+fake-plugin/);
		assert.doesNotMatch(result.stdout, /nothing/);
		assert.doesNotMatch(result.stdout, /缺失:/);
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
});

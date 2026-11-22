import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadClient(status) {
	let registration;
	const sandbox = {
		window: { __ModuleLoader__: { load: (reg) => { registration = reg; } } },
		document: { head: { append() {} }, createElement: () => ({ dataset: {}, textContent: "", remove() {} }) },
		console,
	};
	if (status !== undefined) sandbox.window.__DSH_COMPAT_STATUS__ = status;
	vm.runInNewContext(readFileSync(join(ROOT, "lib", "client.js"), "utf8"), sandbox);
	const React = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	};
	const mod = registration.factory((spec) => {
		if (spec === "react") return React;
		throw new Error(`unexpected require ${spec}`);
	});
	return { registration, mod, React, sandbox };
}

function flat(node) {
	if (node === null || node === undefined) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(flat).join("");
	return (node.children ?? []).map(flat).join("");
}

test("client bundle：id 正确，导出 apply 与 inject", () => {
	const { registration, mod } = loadClient();
	assert.equal(registration.id, "dsh-compat");
	assert.equal(typeof mod.apply, "function");
	assert.deepEqual(Array.from(mod.inject), ["slots"]);
});

test("client apply：注册 plugins.tab、plugins.detail.badge 与 plugins.detail.section", () => {
	const { mod } = loadClient();
	const registered = [];
	const ctx = {
		effect: (fn) => { fn(); },
		slots: {
			inject: (_name, cb) => cb(),
			register: (options, Component) => { registered.push({ options, Component }); },
		},
	};
	mod.apply(ctx);
	const names = registered.map((r) => r.options.name).sort();
	assert.deepEqual(names, ["plugins.detail.badge", "plugins.detail.section", "plugins.tab"]);
});

test("CompatBadge：非 bundle subject 返回 null，FAIL 行渲染文本", () => {
	const { mod, React } = loadClient({
		plugins: [{ name: "bad-plugin", verdict: "FAIL", missing: ["x"], notes: [] }],
	});
	const registered = [];
	mod.apply({ effect: (fn) => fn(), slots: { inject: (_n, cb) => cb(), register: (o, C) => registered.push({ o, C }) } });
	const badge = registered.find((r) => r.o.name === "plugins.detail.badge").C;
	assert.equal(badge({ subject: { kind: "item", id: "x" } }), null);
	const tree = badge({ subject: { kind: "bundle", pkg: { name: "bad-plugin" } } });
	assert.equal(tree.type, "span");
	assert.match(flat(tree), /不可用/);
});

test("CompatBadge：PASS 或未登记插件不渲染（避免噪音）", () => {
	const { mod } = loadClient({ plugins: [{ name: "ok-plugin", verdict: "PASS", missing: [], notes: [] }] });
	const registered = [];
	mod.apply({ effect: (fn) => fn(), slots: { inject: (_n, cb) => cb(), register: (o, C) => registered.push({ o, C }) } });
	const badge = registered.find((r) => r.o.name === "plugins.detail.badge").C;
	assert.equal(badge({ subject: { kind: "bundle", pkg: { name: "ok-plugin" } } }), null);
	assert.equal(badge({ subject: { kind: "bundle", pkg: { name: "unknown" } } }), null);
});

test("CompatSection：渲染宿主版本、L2 状态与逐插件行", () => {
	const { mod } = loadClient({
		host: { version: "0.2.2-rc.5" },
		l2: { state: "retired", anchor: "0.2.2-rc.3", retired: true },
		plugins: [
			{ name: "good", verdict: "PASS", missing: [], notes: ["host-only（无 dsh.client 声明）"] },
			{ name: "bad", verdict: "FAIL", missing: ["x/client"], notes: ["依赖不可达"] },
		],
	});
	const registered = [];
	mod.apply({ effect: (fn) => fn(), slots: { inject: (_n, cb) => cb(), register: (o, C) => registered.push({ o, C }) } });
	const Section = registered.find((r) => r.o.name === "plugins.tab").C;
	const text = flat(Section());
	assert.match(text, /0\.2\.2-rc\.5/);
	assert.match(text, /retired/);
	assert.match(text, /good/);
	assert.match(text, /bad/);
	assert.match(text, /x\/client/);
});

test("CompatSection：没有注入全局时给出可读提示而不是崩溃", () => {
	const { mod } = loadClient();
	const registered = [];
	mod.apply({ effect: (fn) => fn(), slots: { inject: (_n, cb) => cb(), register: (o, C) => registered.push({ o, C }) } });
	const Section = registered.find((r) => r.o.name === "plugins.tab").C;
	const text = flat(Section());
	assert.match(text, /尚未生成/);
});

test("client bundle 不直接读 document 之外的宿主 API，且不含 </script", () => {
	const source = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
	assert.ok(!source.includes("</script"));
	assert.ok(!source.includes("require(\"fs\")"), "client 半区不得引用 node 内置模块");
});

test("详情页段落：order 10 排在市场「来源仓库」（order 90）之前", () => {
	const { mod } = loadClient({ plugins: [] });
	const registered = [];
	mod.apply({ effect: (fn) => fn(), slots: { inject: (_n, cb) => cb(), register: (o, C) => registered.push({ o, C }) } });
	const entry = registered.find((r) => r.o.name === "plugins.detail.section");
	assert.ok(entry, "应注册详情页段落");
	assert.equal(entry.o.order, 10);
	assert.equal(entry.o.id, "dsh-compat");
});

test("详情页段落：展开 FAIL 插件的 missing 与 notes（不只是角标）", () => {
	const { mod } = loadClient({
		host: { version: "0.2.2-rc.5" },
		l2: { state: "retired", anchor: "0.2.2-rc.3", retired: true },
		plugins: [
			{ name: "bad-plugin", verdict: "FAIL", missing: ["@scope/missing/client"], notes: ["依赖不可达（externals 漂移）"] },
		],
	});
	const registered = [];
	mod.apply({ effect: (fn) => fn(), slots: { inject: (_n, cb) => cb(), register: (o, C) => registered.push({ o, C }) } });
	const Section = registered.find((r) => r.o.name === "plugins.detail.section").C;
	const text = flat(Section({ subject: { kind: "bundle", pkg: { name: "bad-plugin" } } }));
	assert.match(text, /不可用/);
	assert.match(text, /@scope\/missing\/client/, "详情页必须摊开缺失的 specifier");
	assert.match(text, /externals 漂移/, "详情页必须摊开原因");
});

test("详情页段落：PASS 插件给出明确「兼容」结论（不是空白）", () => {
	const { mod } = loadClient({ plugins: [{ name: "ok", verdict: "PASS", missing: [], notes: [] }] });
	const registered = [];
	mod.apply({ effect: (fn) => fn(), slots: { inject: (_n, cb) => cb(), register: (o, C) => registered.push({ o, C }) } });
	const Section = registered.find((r) => r.o.name === "plugins.detail.section").C;
	const text = flat(Section({ subject: { kind: "bundle", pkg: { name: "ok" } } }));
	assert.match(text, /兼容/);
});

test("详情页段落：非 bundle subject（row 等）返回 null，不抢别家段落", () => {
	const { mod } = loadClient({ plugins: [{ name: "x", verdict: "FAIL", missing: [], notes: [] }] });
	const registered = [];
	mod.apply({ effect: (fn) => fn(), slots: { inject: (_n, cb) => cb(), register: (o, C) => registered.push({ o, C }) } });
	const Section = registered.find((r) => r.o.name === "plugins.detail.section").C;
	assert.equal(Section({ subject: { kind: "row", pkg: { name: "x" } } }), null);
	assert.equal(Section({}), null);
});

test("详情页段落：未登记插件返回 null（不制造噪音）", () => {
	const { mod } = loadClient({ plugins: [] });
	const registered = [];
	mod.apply({ effect: (fn) => fn(), slots: { inject: (_n, cb) => cb(), register: (o, C) => registered.push({ o, C }) } });
	const Section = registered.find((r) => r.o.name === "plugins.detail.section").C;
	assert.equal(Section({ subject: { kind: "bundle", pkg: { name: "unknown" } } }), null);
});

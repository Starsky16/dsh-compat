/**
 * dsh-compat · client 半区：插件页「兼容性」tab + 详情 badge。
 *
 * 数据只读宿主注入的 `window.__DSH_COMPAT_STATUS__`（见 lib/index.js 的
 * buildCompatStatus），本文件不发起任何请求、不写存储。
 *
 * 形态约束（宿主 client 半区契约）：`window.__ModuleLoader__.load({id, factory})`，
 * factory 内用 `require(...)` 只取平台 seed 词（react 等）。
 */
window.__ModuleLoader__.load({
	id: "dsh-compat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var GLOBAL = "__DSH_COMPAT_STATUS__";
		var CSS =
			".dsh-compat-section{padding:16px 0;display:flex;flex-direction:column;gap:12px}" +
			".dsh-compat-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}" +
			".dsh-compat-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}" +
			".dsh-compat-row{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;font-size:13px}" +
			".dsh-compat-name{font-weight:600}" +
			".dsh-compat-detail{color:var(--dsw-alias-label-secondary);font-size:12px}" +
			".dsh-compat-tag{font-size:11px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}" +
			'.dsh-compat-tag[data-verdict="FAIL"]{color:var(--dsw-alias-state-error-primary)}' +
			'.dsh-compat-tag[data-verdict="WARN"]{color:var(--dsw-alias-state-warn-primary)}';

		function readStatus() {
			var value = window[GLOBAL];
			return value !== null && typeof value === "object" ? value : null;
		}

		function verdictText(verdict) {
			if (verdict === "PASS") return "兼容";
			if (verdict === "WARN") return "注意";
			if (verdict === "KNOWN") return "已知例外";
			return "不可用";
		}

		function CompatSection() {
			var status = readStatus();
			if (status === null) {
				return React.createElement(
					"p",
					{ className: "dsh-compat-meta" },
					"兼容性报告尚未生成：重启 dsh 后可见（插件在启动时注入结论）。",
				);
			}
			var l2 = status.l2 || {};
			var rows = Array.isArray(status.plugins) ? status.plugins : [];
			var head =
				"宿主 " +
				((status.host && status.host.version) || "未知") +
				" · L2 " +
				(l2.state || "unknown") +
				(l2.anchor ? "（锚定 " + l2.anchor + "）" : "");
			return React.createElement(
				"div",
				{ className: "dsh-compat-section" },
				React.createElement("p", { className: "dsh-compat-meta" }, head),
				status.error ? React.createElement("p", { className: "dsh-compat-meta" }, status.error) : null,
				rows.length === 0
					? React.createElement("p", { className: "dsh-compat-meta" }, "没有可检查的插件。")
					: React.createElement(
							"ul",
							{ className: "dsh-compat-list" },
							rows.map(function (row) {
								return React.createElement(
									"li",
									{ key: row.name, className: "dsh-compat-row" },
									React.createElement("span", { className: "dsh-compat-name" }, row.name),
									React.createElement(
										"span",
										{ className: "dsh-compat-tag", "data-verdict": row.verdict },
										verdictText(row.verdict),
									),
									row.missing && row.missing.length
										? React.createElement("span", { className: "dsh-compat-detail" }, "缺失: " + row.missing.join(", "))
										: null,
									row.notes && row.notes.length
										? React.createElement("span", { className: "dsh-compat-detail" }, row.notes.join("；"))
										: null,
								);
							}),
						),
			);
		}

		function CompatBadge(props) {
			var status = readStatus();
			var subject = props && props.subject;
			if (status === null || !subject || subject.kind !== "bundle") return null;
			var name = subject.pkg && subject.pkg.name;
			var rows = Array.isArray(status.plugins) ? status.plugins : [];
			var row = null;
			for (var i = 0; i < rows.length; i++) {
				if (rows[i].name === name) {
					row = rows[i];
					break;
				}
			}
			if (!row || row.verdict === "PASS") return null;
			return React.createElement(
				"span",
				{
					className: "dsh-compat-tag",
					"data-verdict": row.verdict,
					title: (row.notes || []).join("；"),
				},
				verdictText(row.verdict),
			);
		}

		/** 详情页段落：把某个插件的判定摊开（missing / notes 逐条），非 bundle 或不认识就不占位。 */
		function CompatDetail(props) {
			var status = readStatus();
			var subject = props && props.subject;
			if (status === null || !subject || subject.kind !== "bundle") return null;
			var name = subject.pkg && subject.pkg.name;
			var rows = Array.isArray(status.plugins) ? status.plugins : [];
			var row = null;
			for (var i = 0; i < rows.length; i++) {
				if (rows[i].name === name) {
					row = rows[i];
					break;
				}
			}
			if (!row) return null;
			var missing = Array.isArray(row.missing) ? row.missing : [];
			var notes = Array.isArray(row.notes) ? row.notes : [];
			return React.createElement(
				"div",
				{ className: "dsh-compat-section" },
				React.createElement(
					"p",
					{ className: "dsh-compat-meta" },
					"兼容性判定（dsh-compat）",
				),
				React.createElement(
					"p",
					{ className: "dsh-compat-row" },
					React.createElement(
						"span",
						{ className: "dsh-compat-tag", "data-verdict": row.verdict },
						verdictText(row.verdict),
					),
					row.verdict === "PASS"
						? React.createElement("span", { className: "dsh-compat-detail" }, "当前宿主上可正常加载。")
						: null,
				),
				missing.length
					? React.createElement(
							"ul",
							{ className: "dsh-compat-list" },
							missing.map(function (spec) {
								return React.createElement(
									"li",
									{ key: spec, className: "dsh-compat-detail" },
									"缺失: " + spec,
								);
							}),
						)
					: null,
				notes.length
					? React.createElement(
							"ul",
							{ className: "dsh-compat-list" },
							notes.map(function (note, index) {
								return React.createElement(
									"li",
									{ key: "note-" + index, className: "dsh-compat-detail" },
									note,
								);
							}),
						)
					: null,
				status.host && status.host.version
					? React.createElement("p", { className: "dsh-compat-meta" }, "宿主 " + status.host.version)
					: null,
			);
		}

		function apply(ctx) {
			ctx.effect(function () {
				if (typeof document === "undefined" || !document.head) return function () {};
				var style = document.createElement("style");
				style.dataset.plugin = "dsh-compat";
				style.textContent = CSS;
				document.head.append(style);
				return function () {
					style.remove();
				};
			}, "dsh-compat: compatibility styles");
			ctx.slots.inject("plugins.tab", function () {
				return ctx.slots.register(
					{ name: "plugins.tab", id: "compat", label: function () { return "兼容性"; }, order: 20 },
					CompatSection,
				);
			});
			ctx.slots.inject("plugins.detail.badge", function () {
				return ctx.slots.register({ name: "plugins.detail.badge", id: "compat", order: 20 }, CompatBadge);
			});
			// 详情页段落：order 10 排在市场「来源仓库」（order 90）之前。
			ctx.slots.inject("plugins.detail.section", function () {
				return ctx.slots.register({ name: "plugins.detail.section", id: "dsh-compat", order: 10 }, CompatDetail);
			});
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});

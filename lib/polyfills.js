/**
 * dsh-compat · L3 · polyfills.js
 *
 * 作为 `<script>` 注入的 polyfill 脚本（plans Task 3 Step 3）：只补缺失能力，
 * 已有原生实现时一律不覆盖。注意 `text` 里不能出现 `</script`（会提前闭合标签）。
 */
export const POLYFILLS = String.raw`
/* [dsh-compat] L3 polyfills：只补缺失，不覆盖原生实现 */
if (!(globalThis.crypto && typeof crypto.randomUUID === "function")) {
  try {
    globalThis.crypto = globalThis.crypto || {};
    globalThis.crypto.randomUUID = function () {
      var b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var h = Array.prototype.map.call(b, function (x) {
        return x.toString(16).padStart(2, "0");
      }).join("");
      return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
    };
  } catch (e) { /* crypto 不可用时放弃，页面继续起 */ }
}
if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any !== "function") {
  AbortSignal.any = function (signals) {
    var c = new AbortController();
    for (var i = 0; i < signals.length; i++) {
      (function (s) {
        if (s.aborted) { c.abort(s.reason); return; }
        s.addEventListener("abort", function () { c.abort(s.reason); }, { once: true });
      })(signals[i]);
    }
    return c.signal;
  };
}
/* 触屏（coarse pointer）= 低端机/移动端：打开 perf.css 的 opt-in 开关 */
try {
  if (matchMedia("(pointer: coarse)").matches) {
    document.documentElement.dataset.dshCompatPerf = "1";
  }
} catch (e) { /* matchMedia 不可用时跳过 */ }
`;

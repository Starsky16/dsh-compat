// dsh-compat 测试 fixture：只推一条可检索的 style，用于核对注入顺序。
const MARKER = "/* dsh-compat-injector */";
export function apply(ctx) {
  ctx.on("webserver/index-inject", (table) => {
    table.push({ kind: "style", text: `${MARKER} body { --dsh-compat-injector: 1; }` });
  });
}

/* 验证从 config.js（Secret 注入）读取配置时会 trim 首尾空白
   —— key 里混一个 \t 就会被 Google 判 InvalidKeyMapError，且只表现为静默降级到瓦片地图 */
const fs = require("fs");

let pass = 0, fail = 0;
const check = (name, ok, got) => {
  if (ok) { pass++; console.log("  PASS:", name); }
  else    { fail++; console.log("  FAIL:", name, "->", JSON.stringify(got)); }
};

const html = fs.readFileSync(__dirname + "/points.html", "utf8");
const start = html.indexOf("const CONFIG = {");
const tail  = "if (__SECRET.sources) CONFIG.sources = parseSources(__SECRET.sources);";
const end   = html.indexOf(tail);
if (start < 0 || end < 0) { console.log("无法定位 CONFIG 段，测试中止"); process.exit(1); }
const code = html.slice(start, end + tail.length);

/* 在模拟 window 下执行这段配置代码，拿到最终的 CONFIG */
function build(secret){
  return new Function("window", code + "\n; return CONFIG;")({ MAP_SECRET: secret });
}

console.log("\n=== 1. apiKey 的空白处理 ===");
const K = "AIzaQ2jAfLWiJrQEbIw5FYph";
check("制表符前缀被清掉（线上就是这个 bug）", build({ apiKey: "\t" + K }).apiKey === K, build({ apiKey: "\t" + K }).apiKey);
check("首尾空格+换行被清掉", build({ apiKey: "  \n " + K + " \t" }).apiKey === K, build({ apiKey: "  \n " + K + " \t" }).apiKey);
check("正常 key 原样保留", build({ apiKey: K }).apiKey === K);
check("纯空白视同未设置（不覆盖默认值 \"\"）", build({ apiKey: "   " }).apiKey === "", build({ apiKey: "   " }).apiKey);
check("空字符串不覆盖", build({ apiKey: "" }).apiKey === "");

console.log("\n=== 2. dataUrl / colorBy ===");
check("dataUrl 去空白", build({ dataUrl: " https://x/pub?output=csv\n" }).dataUrl === "https://x/pub?output=csv");
check("colorBy 去空白", build({ colorBy: " match_status " }).colorBy === "match_status");
check("colorBy 全空白时不覆盖默认 match_status", build({ colorBy: "  " }).colorBy === "match_status");

console.log("\n=== 3. sources 数组 ===");
const s1 = build({ sources: [{ label: " 踩点数据 ", url: " https://x/pub?output=csv\n" }] }).sources;
check("sources.url 去空白", s1.length === 1 && s1[0].url === "https://x/pub?output=csv", s1[0]);
check("sources.label 去空白", s1[0].label === "踩点数据", s1[0].label);
const s2 = build({ sources: [{ url: " https://x " }] }).sources;
check("缺 label 时补默认名", s2[0].label === "数据源", s2[0].label);
check("url 为空的源被剔除", build({ sources: [{ label: "a", url: "   " }] }).sources.length === 0);

console.log("\n=== 4. 真实线上形态回归（tab + 39 位 key） ===");
const online = build({ apiKey: "\tAIzaSyD-EXAMPLEKEY_39CHARS_xxxxxxxxxxxxx" }).apiKey;
check("线上 tab 形态不再带 \\t", !/[\t\n ]/.test(online), online);

console.log("\n=== 汇总 ===");
console.log(`  PASS: ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);

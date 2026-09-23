/* Google Maps API キー対応の検証
   シナリオ A: キー無し → タイル地図で 1598 点が描画される（回帰確認）
   シナリオ B: 不正キー → 白画面にならず、警告を出してタイル地図へ自動フォールバック
   シナリオ C: config.js 経由の注入が効いているか
   ※/tmp に退避した本物設定は必ず復元する
*/
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const DIR = "/Users/annika/WorkBuddy/2026-09-22-18-33-40/knot-map";
const CFG = path.join(DIR, "config.js");
const BASE = "http://127.0.0.1:8123/points.html";

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
};

function writeCfg(apiKey) {
  fs.writeFileSync(CFG, `window.MAP_SECRET = {\n  apiKey: "${apiKey}",\n  dataUrl: ""\n};\n`, "utf8");
}

(async () => {
  const original = fs.readFileSync(CFG, "utf8");
  const browser = await chromium.launch();

  async function open(waitMs) {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    p.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
    p.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await p.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await p.waitForFunction(() => {
      const t = document.getElementById("s-total");
      return t && t.textContent.replace(/\D/g, "") !== "0";
    }, { timeout: 60000 }).catch(() => {});
    await p.waitForTimeout(waitMs);
    return { p, errors };
  }

  const stat = async p => ({
    total: ((await p.textContent("#s-total")) || "").trim(),
    shown: ((await p.textContent("#s-shown")) || "").trim(),
    note: ((await p.textContent("#note")) || "").replace(/\s+/g, " ").trim(),
    src: ((await p.textContent("#src")) || "").replace(/\s+/g, " ").trim().slice(0, 120),
    leafletLoaded: await p.evaluate(() => !!(window.L && L.map)).catch(() => false),
    googleLoaded: await p.evaluate(() => !!(window.google && window.google.maps)).catch(() => false),
    clusters: await p.$$eval(".wcp-cl,.marker-cluster", e => e.length).catch(() => 0),
    tiles: await p.$$eval("img.leaflet-tile", e => e.filter(i => i.naturalWidth > 0).length).catch(() => 0),
    hasGmapCanvas: await p.$$eval("#map canvas", e => e.length).catch(() => 0)
  });

  try {
    // ---------- A: キー無し（回帰） ----------
    console.log("\n=== A. API キー無し（タイル地図・回帰確認） ===");
    writeCfg("");
    let { p, errors } = await open(7000);
    let s = await stat(p);
    console.log("  ", JSON.stringify(s));
    check("1598 点が描画される", s.total.replace(/\D/g, "") === "1598", s.total);
    check("タイルが実ロードされている", s.tiles > 0, s.tiles);
    check("クラスタが形成される", s.clusters > 0, s.clusters);
    check("警告が出ていない", !/Google Maps を読み込めませんでした/.test(s.note), s.note);
    await p.close();

    // ---------- B: 不正キー → フォールバック ----------
    console.log("\n=== B. 不正な API キー（自動フォールバック確認） ===");
    writeCfg("THIS_IS_AN_INVALID_KEY_FOR_TESTING_ONLY");
    ({ p, errors } = await open(16000));   // 10 秒タイムアウト + 余裕
    s = await stat(p);
    console.log("  ", JSON.stringify(s));
    check("白画面にならず地図が出る（タイル or Google）", s.tiles > 0 || s.hasGmapCanvas > 0, s);
    check("フォールバック警告が表示される", /Google Maps を読み込めませんでした/.test(s.note), s.note);
    check("ポイントは描画されている", s.total.replace(/\D/g, "") === "1598", s.total);
    await p.screenshot({ path: path.join(DIR, "smoke_fallback.png") });
    await p.close();

    // ---------- C: config.js 注入の確認 ----------
    console.log("\n=== C. config.js からの注入 ===");
    writeCfg("INJECTED_KEY_12345");
    const p3 = await browser.newPage();
    const applied = [];
    p3.on("request", r => { if (/maps\.googleapis\.com\/maps\/api\/js/.test(r.url())) applied.push(r.url()); });
    await p3.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await p3.waitForTimeout(4000);
    check("config.js のキーが Google 読込に使われる",
      applied.length > 0 && applied[0].includes("INJECTED_KEY_12345"), applied[0] || "(リクエスト無し)");
    await p3.close();

  } finally {
    fs.writeFileSync(CFG, original, "utf8");   // 必ず元に戻す
    console.log("\n  config.js を元の状態に復元しました");
    await browser.close();
  }

  console.log(`\n=== 結果: PASS ${pass} / FAIL ${fail} ===`);
  process.exit(fail ? 1 : 0);
})();

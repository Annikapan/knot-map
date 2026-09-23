/* このファイルを config.js にコピーして、apiKey / sources を埋めてください。
   （config.example.js は git 管理 OK。config.js は .gitignore 済み） */
window.MAP_SECRET = {

  // ① Google Maps JavaScript API キー（未設定なら自動でタイル地図にフォールバック）
  apiKey: "",

  // ② データソース（複数可。ここに並べたものを1枚の地図に重ねます）
  //   label = 凡例・切替に出る名前（日本語/中国語どちらでも）
  //   url   = 以下の3通りいずれか
  //     a) GitHub 内の CSV/JSON             : "asakusa.csv"
  //     b) Google Sheets「ウェブに公開→CSV」 : "https://docs.google.com/spreadsheets/d/e/XXXX/pub?output=csv"
  //     c) Apps Script の /exec（Sheet非公開のまま読める）
  //                                         : "https://script.google.com/macros/s/YYYY/exec?format=json"
  //
  // ★ 推奨は「突合済み 1 本」：GAS 側で 踩点×Knot を突合済みなので、地図はそれを読むだけ
  //     → 地図上で同じ店が 2 点に重ならない。下の A を使う。
  //   A) 突合済み（推奨）
  //      url: "https://script.google.com/macros/s/YYYY/exec?format=json"
  //      ※ 下钻したい時は &pref=東京都 / &area=浅草 / &status=spot-only / &q=店名 を付け足す
  //   B) 突合せず 2 源を重ねる（GAS 未導入時の暫定。同じ店が 2 点に出る）
  sources: [
    // { label: "踩点×Knot 突合済み", url: "https://script.google.com/macros/s/YYYY/exec?format=json" }
    // { label: "踩点データ（Sheets）",      url: "https://docs.google.com/spreadsheets/d/e/XXXX/pub?output=csv" },
    // { label: "物料激励＋子商户进件（Knot）", url: "https://script.google.com/macros/s/YYYY/exec?format=json&view=raw" }
  ],

  // ③ ソースが1つだけならこれでも可（sources を書いた場合は sources が優先）
  dataUrl: "",

  // ④ 何で色分けするか（GAS の「合并」列名をそのまま書く）
  //    "match_status" … both / spot-only / knot-only（踩过没铺 / 铺了没踩 が一目で分かる。推奨）
  //    "category"     … 物料铺设ステータス
  //    "area"         … 商圈
  //    "institution"  … 服务商
  //    空欄なら自動判定
  colorBy: "match_status"
};

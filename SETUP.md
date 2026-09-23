# 从 0 到 1：自动化物料地图搭建手册（双数据源 + 突合处理层版）

> 目标：一张地图，两个数据源（Google Sheets 踩点数据 + Knot 定时跑的物料激励/子商户进件），
> 中间有**数据清洗 + 匹配层**，固定链接、每周自动更新、无需人工维护。
>
> 预计总耗时：**约 45 分钟**（一次性），之后完全自动。

---

## 整体架构（先看懂这张图再动手）

```
【数据源①：踩点数据】                    【数据源②：Knot 定时数据】
Google Sheets（你维护的踩点表）          Knot agent 每周自动跑数
   │ 「文件」→「分享」→                      │ 跑完后 POST JSON
   │ 「发布到网络」→ CSV                     ▼
   ▼                                    GAS /exec（Code.gs）
公开 CSV URL                             ├─ 校验 token → 写入「明细」Sheet 存档
   │                                     ├─ 同 merchant_id 去重（留最新周）
   │                                     ▼
   │                              ┌─────────────────────────────┐
   └─────────────────────────────▶│ Pipeline.gs（数据处理・突合层）│
                                  │ ① 归一化：NFKC / 去法人前缀    │
                                  │    / 地址反推（丁目番号→数字）  │
                                  │ ② 匹配：id→店名+地址→店名→坐标 │
                                  │ ③ 坐标补全：缺的用地址反查      │
                                  │ ④ 打标：都道府県/激励区域/商圈  │
                                  └──────────┬──────────────────┘
                                             ▼
                                  「合并」Sheet（both/spot-only/knot-only）
                                             │ doGet?format=json
                                             ▼
                                  points.html（地图页，已支持多源合并）
                                   ├─ 按 match_status 配色：
                                   │   both＝已铺物料 / spot-only＝踩过没铺
                                   ├─ 填了 Google key → Google Maps 底图
                                   └─ 没填 / key 失效 → 自动降级国土地理院淡色
                                             ▼
                                  GitHub Pages（固定 URL，每周一 09:00 自动重建）
```

**为什么要这一层？** 两个源直接叠加的话，同一家店会出现两个重叠的点。
处理层把两边**归一化后匹配**，合成一条并打上 `both / spot-only / knot-only` 标记——
地图上直接看出「踩过但没铺物料」「铺了但没踩过」。

**处理层的四个能力（都在 gas/Pipeline.gs，可单独开关）**

| 能力 | 做法 | 开关 |
|---|---|---|
| 归一化 | NFKC 全半角统一、去（株）等法人前缀、「1丁目2番3号」⇔「1-2-3」反推统一 | 始终开启 |
| 匹配 | L1 merchant_id → L2 店名+地址 → L3 店名 → L4 坐标50m内+店名相似 | 始终开启 |
| 坐标补全 | 缺坐标的行用地址反查（GAS 内置 Maps 服务或 Geocoding API） | `GEOCODE_ENABLED` |
| 打标 | 都道府県抽出、激励区域判定、商圈关键词 | `INCENTIVE_AREAS` / `AREA_RULES` |

**谁负责"自动化"什么？**

| 环节 | 谁做 | 频率 |
|---|---|---|
| 踩点数据更新 | 你编辑 Google Sheets | 随时（GAS 每次突合都重读） |
| 物料激励/进件数据 | Knot agent 跑数 → POST 给 GAS | 每周定时 |
| 清洗 + 匹配 + 写「合并」表 | GAS Pipeline.gs | 每次 Knot 推送时 / 每周一 09:00 |
| 地图重建 | GitHub Actions | push 时 + 每周一 09:00 |
| 你的工作量 | **0**（全部接好之后） | — |

---

## Part A：准备 Google Maps API key + 4 道锁（约 15 分钟，一次）

> 浏览器端的 key 一定会被看网页的人看到，这是 Google 官方设计。
> 防盗靠"限制"而不是"隐藏"。4 道锁全部要挂。

### A-1. 建 key
1. 打开 https://console.cloud.google.com/ → 项目 **Japan Food Industry**
2. API 和服务 → 凭据 → 创建凭据 → API 密钥

### A-2. 锁①：API 限制（最重要）
1. 点开刚建的 key
2. 「API 限制」→ 勾选「限制密钥」→ 只勾 **Maps JavaScript API**
3. 保存
   → key 泄漏也用不了 Places/Geocoding 等贵 API

### A-3. 锁②：HTTP referrer 限制
1. 同一页面「网站限制」→ 添加：
   `https://<你的GitHub用户名>.github.io/*`
2. ⚠️ 本地调试期间**临时**加 `http://localhost:8123/*`，测完删掉

### A-4. 锁③：每日配额上限（唯一能物理止损的设置）
1. API 和服务 → 配额 → 搜「Maps JavaScript API」
2. 「Map loads」→ 编辑 → 设为预计用量的 2~3 倍（如日浏览 50 次设 500）
3. 保存 → 超额即拒绝，**账单停住**

### A-5. 锁④：预算告警
结算 → 预算和提醒 → 建预算（如月 ¥1,000，50%/90%/100% 邮件通知）
> 告警只通知不拦截，拦截靠 A-4。两个都要。

### A-6. 检查清单
- [ ] key 的 API 限制 = 仅 Maps JavaScript API
- [ ] referrer 含 `https://<用户名>.github.io/*`
- [ ] Map loads 每日上限已设
- [ ] 预算告警已开

---

## Part B：发布到 GitHub Pages（约 10 分钟，一次）

### B-1. 建远端仓库并 push
本地仓库**已经建好并提交过了**（18 个文件，密钥与真实数据已排除）。你只需要在 GitHub 上建一个空仓库，然后：

1. GitHub → New repository → 名字填 `knot-map` → **不要**勾 README / .gitignore / license（保持完全空）→ Create
2. 复制仓库地址，回来执行：

```bash
cd ~/WorkBuddy/2026-09-22-18-33-40/knot-map
git remote add origin git@github.com:<用户名>/knot-map.git
git push -u origin main
```

> 安全确认：`git ls-files` 里**不应出现** `config.js` / `asakusa.csv` / `merged_sample.csv`
> （已 .gitignore，实测通过）。
>
> 用 HTTPS 还是 SSH？上面是 SSH。如果没配 SSH key，把地址换成
> `https://github.com/<用户名>/knot-map.git` 即可（push 时输用户名 + Personal Access Token）。

**提交身份**：我用的是仓库级占位身份 `annika <annika@users.noreply.github.com>`。
改成你自己的（让 commit 关联到你的 GitHub 账号）：
```bash
git config user.name  "<你的GitHub用户名>"
git config user.email "<你的GitHub邮箱>"
git commit --amend --reset-author --no-edit
```

### B-2. 把 key 和数据源 URL 写进 GitHub Secrets（不进仓库）
仓库 → Settings → Secrets and variables → Actions → New repository secret：

| Name | Value |
|---|---|
| `MAPS_API_KEY` | Part A 的 key |
| `MAP_SOURCES` | JSON（见下方模板） |
| `MAP_COLOR_BY` | 配色列，推荐 `match_status`（不填默认也是它） |

`MAP_SOURCES` 模板。**推荐用突合后的单源**（Part D 做完之后）——同一家店不会出现两个点：
```json
[{"label":"踩点×Knot 突合済み","url":"https://script.google.com/macros/s/YYYY/exec?format=json"}]
```
还没做 Part D 时的临时双源写法（同店会有两个重叠点，突合层接好后换掉）：
```json
[{"label":"踩点データ（Sheets）","url":"https://docs.google.com/spreadsheets/d/e/XXXX/pub?output=csv"},{"label":"物料激励＋子商户进件（Knot）","url":"https://script.google.com/macros/s/YYYY/exec?format=json&view=raw"}]
```

### B-3. 开 Pages
Settings → Pages → Source 选 **GitHub Actions**。

### B-4. 首次部署
Actions → 「Deploy map to GitHub Pages」→ Run workflow。
完成后的 URL **永久固定**：
```
https://<用户名>.github.io/knot-map/
```

### B-5. 检查清单
- [ ] 打开链接能看到地图和点位
- [ ] 左栏「データソース」显示两个源、各自件数
- [ ] `git log -p -- config.js` 无输出（key 不在 git 历史）

---

## Part C：数据源①踩点数据接入（约 5 分钟，一次）

1. 打开你的踩点 Google Sheets
2. 共享 → 右上「常规访问权限」不动；**文件 → 共享 → 发布到网络**
3. 选择：整个文档 or 踩点 sheet → 格式选 **CSV** → 发布
4. 复制得到的 URL（形如 `https://docs.google.com/spreadsheets/d/e/XXXX/pub?output=csv`）
5. 填进 B-2 的 `MAP_SOURCES`（或本地 `config.js` 的 sources）

**表头要求**（中日英都能自动识别）：商户名/名称、地址（可空）、纬度/lat、经度/lng、
分类/状态（用来着色）、周次/日期（用来筛选，可空）。
缺经纬度的行会自动跳过并计数（左栏「座標なし」显示）。

> 以后你在这张 Sheet 上改内容，**地图每次打开都是最新的**，不用重建。
> 「发布到网络」有约 5 分钟缓存延迟，每周更新无所谓；要即时就用 Part D 的 GAS。

---

## Part D：数据源②Knot 定时数据接入（约 15 分钟，Knot agent 建好后）

### D-1. 建"中转存档 Sheet"
1. 新建 Google Sheet，tab 名 `明细`，首行表头：
   `week / merchant_id / name / category / institution / material / address / lat / lng / note`
2. 复制地址栏里的 spreadsheetId（URL 中 `/d/` 和 `/edit` 之间那串）

### D-2. 部署 GAS
1. 扩展程序 → Apps Script → 粘贴 **两个文件**：`gas/Code.gs` 和 `gas/Pipeline.gs`
2. 项目设置 → 脚本属性：

| 属性 | 必填 | 说明 |
|---|---|---|
| `SHEET_ID` | ✅ | D-1 的 spreadsheetId |
| `WEBHOOK_TOKEN` | ✅ | 自己编一串随机字符 |
| `SPOT_SHEET_ID` | 推荐 | **踩点表的 spreadsheetId**。填了它踩点源就保持私有，不用「发布到网络」 |
| `SPOT_SHEET_NAME` | | 踩点表的 tab 名（不填取第一个 tab） |
| `SPOT_CSV_URL` | 二选一 | 不想共享表时，用「发布到网络」的 CSV URL 代替上面两项 |
| `GEOCODE_ENABLED` | | 缺省 1（补坐标）。设 0 关闭 |
| `GEOCODE_KEY` | | Geocoding API 的 key（不填则用 GAS 内置 Maps 服务） |
| `GEO_RADIUS` | | 坐标就近匹配半径，默认 50（米） |
| `INCENTIVE_AREAS` | | 激励区域，逗号分隔：`東京都,大阪府,北海道` |
| `AREA_RULES` | | 商圈打标规则 JSON：`{"浅草":["浅草"],"合羽橋":["合羽橋"]}` |
| `GITHUB_OWNER/REPO/TOKEN` | | 要同步 data.json 到仓库时才填 |

3. 部署 → 新建部署 → 网页应用：执行者=我，访问权限=**任何人**
4. 复制 `/exec` URL
5. 手动跑一次验证：编辑器里选 `refreshMerged` → 执行 → 看日志里的突合统计，
   并确认存档 Sheet 里多出了 **「合并」** 和 **「待人工校对」** 两个 tab

### D-3. 配 Knot agent（提示词）

**系统提示词**：整段复制 [`knot/agent_prompt.md`](knot/agent_prompt.md)，粘进 Knot agent 的「系统提示词」框。

粘之前只改两处：
1. **时间口径** —— 默认是「上一自然周（JST）」，要改成别的就改那一句
2. **推送地址** —— 提示词第五节的 `https://script.google.com/macros/s/____/exec?token=____`，
   换成 D-2 拿到的 `/exec` + 你的 `WEBHOOK_TOKEN`

提示词已经写死了三件事，不要改：
- **字段契约**（`week / merchant_id / name / category / institution / material / address / lat / lng / note`）
- **只输出 JSON**（GAS 要解析，多一个字就失败）
- **坐标没有就留空**（下游按地址补全；填 0 会定位到几内亚湾）

> 你的 agent 接了数据源能直查，所以提示词里让它**自己去 schema 里找表**，不用写死 SQL。
> 找不到表时它会输出 `{"ok":false,"reason":...}`，你在日志里能看到，再针对性补表名。

### D-4. 接上 Knot（两条路，都配最稳）

两条路**互不冲突**（存档按 `merchant_id + week` 去重留最新，重复到也不怕），建议都配：

| 路线 | 需要 Knot 具备 | 配置 |
|---|---|---|
| **① Knot 主动推送** | agent 能发 HTTP（工具/MCP/插件）+ 平台有定时触发 | 提示词第五节已写好 POST；在 Knot 平台配每周定时 |
| **② GAS 定时去拉** | 不需要 Knot 任何能力 | 见下方 D-4-2 |

#### D-4-2. GAS 定时拉取（兜底，推荐无论如何都配）
1. Knot 平台 → 个人设置 / API → 拿 **Token**，以及 agent 的 AGUI 地址：
   `https://knot.woa.com/apigw/api/v1/agents/agui/<agent_id>`
2. GAS 项目设置 → 脚本属性，追加：

| 属性 | 说明 |
|---|---|
| `KNOT_AGENT_URL` | 上面的 AGUI 地址 |
| `KNOT_AGENT_TOKEN` | `knot_xxx` |
| `KNOT_USERNAME` | **agent token 模式才填**；个人 token 不填 |
| `KNOT_MODEL` | 可选，默认 `kimi-k2.5` |
| `KNOT_PROMPT` | 可选，不填就用内置模板 |

3. 编辑器里跑一次 `testKnotPull()` → 看执行日志：
   - `{"ok":true,"received":N,...}` = 打通了 ✅
   - `解析不出 JSON` = agent 开始闲聊了，检查提示词「只输出 JSON」那句有没有生效
   - `skipped:true` = 上面的属性没配上（属性名拼错最常见）
4. 跑 `installWeeklyTrigger()` 装每周一 09:00 的触发器

没配这些属性也没关系 —— `pullFromKnot()` 会自动跳过，不影响路线①。

**Knot 数据要改字段名？** 只改 `gas/Code.gs` 里的 `normalize()` 字段映射，其他都不用动。

### D-5. 「合并」表的列（= 地图气泡里的字段）

| 列 | 含义 |
|---|---|
| `match_status` | **both**＝两边都有（已铺物料且踩过）／ **spot-only**＝只踩过（没铺物料）／ **knot-only**＝只铺过（没踩） |
| `match_level` | 怎么匹配上的：id / exact（店名+地址）/ name（仅店名）/ geo（坐标+相似度） |
| `match_score` | 匹配置信度 0–1 |
| `spot_category` / `knot_category` | 各源自家的分类（保留原始口径） |
| `prefecture` / `incentive` / `area` | 都道府県 / 激励対象・対象外 / 商圈 |
| `geocoded` | 1＝坐标是补出来的（非原始数据） |

> **「待人工校对」tab**：没坐标且地址查不到的、以及低置信度匹配的行都会落在这里，
> 每周看一眼就行。改完直接改这个 tab，下次突合会以你改过的为准吗——**不会**，
> 存档表才是源头。要人工修正请改踩点表或让 Knot 侧修正后重推。

### D-6. 地图配色：一眼看出铺没铺

`config.js`（或 GitHub Secrets 加 `MAP_COLOR_BY`）里：
```js
colorBy: "match_status"   // both=绿 / spot-only=蓝 …按 PALETTE 顺序自动分配
```
其他可选值：`category`（铺设状态）、`area`（商圈）、`institution`（服务商）。

### D-7. 数据量大时的下钻

`/exec?format=json` 支持过滤参数，几万点时按需取：

| 参数 | 例 |
|---|---|
| `&pref=東京都` | 只取一个都道府県 |
| `&area=浅草` | 只取一个商圈 |
| `&status=spot-only` | 只看踩过没铺的 |
| `&institution=OS` | 只看某服务商 |
| `&q=ラーメン` | 店名/地址/商户号模糊搜 |

地图页 URL 同样支持：`points.html?data=https://script.google.com/.../exec?format=json%26pref=東京都`
（注意 `&` 要写成 `%26`）。

### D-8. 性能（已实测）

| 规模 | 耗时 |
|---|---|
| 真实浅草 1598 × 500 | 8 ms，召回率 100%（写法故意改乱也能认出） |
| 合成 50,000 × 50,000（全靠坐标比对的最坏情况） | 963 ms（GAS 上限 6 分钟） |

> 靠的是坐标网格索引（只比本格+周围 8 格），几万点规模不会撞时限。

---

## 常见问题

| 症状 | 原因 | 处理 |
|---|---|---|
| 灰色"出了点问题"画面 | key 不对 / referrer 拒绝 / API 未开 | 页面会**自动降级**到国土地理院底图并显示原因，按提示修 |
| 某个源没显示 | 该源读取失败 | 左栏出黄色警告条，注明哪个源、什么错 |
| 本地打开地图空白 | referrer 限制没含 localhost | 临时加 `http://localhost:8123/*` |
| 发布 CSV 数据不刷新 | 发布缓存约 5 分钟 | 每周更新无影响；要即时改用 GAS /exec |
| 想换底图样式 | — | 无 key 时默认国土地理院淡色；可选 `gsi-ortho` 航空图 / `osm`；有 Google key 时就是 Google 底图 |
| 同一家店出两个点 | 突合层没跑（用的是 2 源直连模式） | 按 Part D 配 `SPOT_SHEET_ID`，数据源改用单一 `/exec?format=json` |
| 该匹配上的没匹配上 | 两边写法差异超出规则 | 看「待人工校对」tab 的 `why`；常见是店名括号备注一边有一边没有（规则已带"包含"加成，但差异太大时只能人工） |
| 「合并」表没生成 | `SPOT_SHEET_ID` 和 `SPOT_CSV_URL` 都没配 | 至少配一个，然后手动执行 `refreshMerged` |
| 补出来的坐标不准 | Geocoding 对略称地址（如只有町名）会猜 | 核对 `geocoded=1` 的行；不放心就关 `GEOCODE_ENABLED` |
| 本周 Knot 数据没进来 | agent 没触发，或推/拉失败 | 编辑器跑 `testKnotPull()` 看返回；`skipped` = 属性没配，`解析不出 JSON` = 提示词没约束住输出格式 |
| Knot agent 说找不到表 | 提示词让它自己找，但 schema 里命名不一样 | 把日志里 `reason` 的表清单粘给我，我把表名写进提示词 |
| 地图上周次筛选是空的 | 数据里 `week` 列为空 | 提示词里已强制要求填；已进档的空 week 行需在「明细」表手工补 |

## 安全总结

| 项 | 状态 |
|---|---|
| key 进 git/GitHub？ | ❌ 不进（config.js 被 ignore，CI 从 Secrets 注入） |
| key 被访问者看到？ | ⚠️ 会（Google 设计如此）→ 4 道锁兜底 |
| key 被盗刷？ | ✅ 每日配额物理拦截 |
| 数据公开范围 | 公开 CSV = 知道 URL 的人可见；GAS /exec = 同样知 URL 可见，Sheet 本身保持私有 |

## 本地开发 / 测试

```bash
cd knot-map
python3 -m http.server 8123            # 起服务
# 浏览器开 http://127.0.0.1:8123/points.html

# ---- 后端（GAS 逻辑，不用部署就能跑）----
node gas/test.js            # 存档/去重/输出 15 项
node gas/test_pipeline.js   # 突合层 40 项（归一化/匹配/补坐标/打标）
node gas/test_knot.js       # Knot 拉取兜底 20 项（SSE/JSON/围栏解析 + 认证头）
node gas/test_real.js       # 真实 asakusa 1598 行压测（召回率+耗时）
node gas/make_sample.js     # 重新生成 merged_sample.csv（改完规则跑一下）

# ---- 前端（要起 http server）----
NODE_PATH=/Users/annika/.workbuddy/binaries/node/workspace/node_modules \
  node test_multisource.js  # 多源合并 9 项
NODE_PATH=/Users/annika/.workbuddy/binaries/node/workspace/node_modules \
  node test_browser.js      # 单源回归 8 项
```

> `merged_sample.csv` 是「合并」表的真实样例（both 500 / spot-only 1098），
> 地图页可以直接吃它验证配色：`config.js` 里 `sources: [{label:"突合済み", url:"merged_sample.csv"}]`。

样例文件：
- [`knot_sample.json`](knot_sample.json) —— Knot→GAS 输出的格式模板（12 条样例数据，可安全提交）
- [`knot/agent_prompt.md`](knot/agent_prompt.md) —— 粘进 Knot agent 的系统提示词（完整自洽，改两处即可用）

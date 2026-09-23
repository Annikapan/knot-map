# 任务C：把本周数据同步给地图 —— 追加到你现有 prompt 末尾

> 想要**一整份完整 prompt**（原跑数 prompt + 任务C 已合并好）的话，直接用
> [`agent_prompt_full.md`](agent_prompt_full.md)，整段覆盖 agent 的系统提示词即可，改 1 处推送地址。
> 本文件则是**纯增量**，适合你想保留自己那份 prompt 原貌、只追加任务C 的情况。
>
> **用法**：整段粘在你现有「日本周度新增数据跑数助手」prompt 的最后（「## 参考资产」之后）。
> **不改你原有任何内容**：任务A/B 的 SQL、口径、红线、Excel 交付、notify 全部原样保留，任务C 只是多吐一份数据。
> 粘之前只改 **一处**：推送地址（PUSH_URL，Part D 部署 GAS 后拿到的 `/exec?token=xxx`）。

---

## 提示词正文（从这里开始复制）

## 任务C：同步本周数据给地图看板（在任务A/B 之后执行）

地图看板需要同一批数据的结构化版本。任务A/B 的 Excel 照常交付，不要因此改变任何交付方式；
**在此之外**，用 `terminal` 跑 curl 把结果 POST 给地图后端（C-5），回复里只留一行确认块。

### C-1 只做字段映射，不要再查一次数

不要为任务C 重新跑 SQL。直接复用任务A、任务B 已经查出来的结果集，按下表改名换列：

| 契约字段 | 任务A（进件）取 | 任务B（物料铺设）取 |
|---|---|---|
| `week` | 统一填本周 ISO 周次（见 C-2） | 同左 |
| `merchant_id` | `smid`（子商户号） | `"MAT" + material_id`（物料码唯一，必须加前缀，否则去重会被互相覆盖） |
| `name` | `store_name` | `store_name`；为空则退回 `mch_name` |
| `category` | 固定 `已接入子商户` | 固定 `已铺设礼包或汇率` |
| `institution` | `fmerchantname` | `mch_name`（服务商名称） |
| `material` | `""` | `material_type_cn`（`礼包物料` / `汇率物料`） |
| `address` | `store_address` | `store_address` |
| `lat` / `lng` | `""` | `""` |
| `note` | `进件：{created_time}` | `绑码：{bind_time_str}`；`is_active=1` 加 `｜活跃`，否则 `｜未活跃`；公司名 `mch_companyname` 非空时一并写入 |

**坐标硬规则**：这两张表没有经纬度字段，一律填 `""`。
**禁止**填 0、**禁止**按地址估算、**禁止**用城市中心代替 —— 下游会用地理编码按地址补全，你填错会定位到错误地点。
（若实测表里确实有 lat/lng 字段，才填真实值，保留原始精度。）

**店名/地址一律保留日文原名**，不要翻译、不要缩写、不要去掉「株式会社」以外的任何字符 —— 下游靠「店名+地址归一化」跟踩点表做匹配，改一个字就匹配不上。

### C-2 week 怎么算

取你窗口第一天 `{D-7}`（上周一）所在的 ISO 周，格式 `YYYY-Www`。
例：`D-7 = 2026-09-14` → `week = "2026-W38"`。**整个数组统一填同一个值**，缺了会被当成新数据反复追加。

### C-3 同一家店只留一条

按「店名 + 地址」归一化（全角转半角、去空格）判重：

- 任务B 内同一家店有多个码 → 只保留 `bind_time` 最新的一条，`note` 末尾注明 `｜同店本周N个码`
- 任务A 和任务B 出现同一家店 → 合成一条：`merchant_id` 用 `smid`，`category` 用 `已铺设礼包或汇率`，`material` 用物料类型，`note` 加 `｜本周同时进件`

### C-4 输出：两条通道，POST 优先

| 通道 | 什么时候用 |
|---|---|
| **① curl POST（主路）** | 你有 `terminal` 工具，走 C-5。**成功就不再往回复里塞数据** |
| **② 哨兵块（兜底）** | C-5 连续失败，或没有 terminal 工具时 |

POST 成功后，在你**回复的最末尾**只放这个确认块（`rows` 是空数组，**不要**填真实数据）：

```
<<<KNOT_JSON>>>
{"ok":true,"week":"2026-W38","total_rows":1234,"rows":[]}
<<<END_KNOT_JSON>>>
```

只有走通道②时才把真实 rows 填进去。哨兵规则（通道②）：
- 哨兵标记**必须原样**，前后不要加 markdown 围栏（```），否则下游截不出来
- JSON 紧凑输出，不要缩进
- 行数 > 300 时拆成多个块，每块 ≤ 300 行，多个 `<<<KNOT_JSON>>> ... <<<END_KNOT_JSON>>>` 依次排列
- 第一块带 `total_rows`（全周总行数），下游据此判断有没有被截断

### C-5 用 terminal + curl 推送（已实测可用，主路）

你挂载的 `terminal` 工具能执行 curl，这是最稳的通道：数据落盘再 POST，不受回复长度限制。

**推送地址**（下文记作 `PUSH_URL`，部署 GAS 后拿到）：
`https://script.google.com/macros/s/____改成你的____/exec?token=____改成你的____`

先跑一次连通性自检（GET，空 body，只确认 URL + token + 后端正常）：
```bash
curl -sS -L 'PUSH_URL&ping=1' -o ping.json -w '\nHTTP:%{http_code}\n'
```
响应里 `"tokenOk":true` 才继续；`false` 说明 token 不对，`null` 说明下游还没配 token。

**第 1 步：把 JSON 写成文件**（`write_to_file`，单次上限 600 行，超出就分文件）

写入本期目录 `/data/workspace/osdata-home/tmp/weekly-jp-{YYYYMMDD}/`：
- ≤300 行 → 单文件 `knot_payload.json`
- \>300 行 → 分片 `knot_p1.json` … `knot_pn.json`，每片 ≤300 行且 body 里带 `chunk`：

```json
{"ok":true,"week":"2026-W38","chunk":{"i":1,"n":4},"total_rows":1234,"rows":[...]}
```

**第 2 步：POST**（terminal 工具，`commandWorkingDirectory` 填上面的本期目录）

```bash
curl -sS -L -X POST 'PUSH_URL' -H 'Content-Type: application/json' --data-binary @knot_p1.json -o resp1.json -w '\nHTTP:%{http_code}\n'
```

三个**不能省**的参数：
- `-L` —— GAS 的 `/exec` 会 302 跳转，不带它你拿到的是**空响应**，会误判成失败
- `--data-binary @文件` —— 不要用 `-d '{...}'` 把 JSON 塞进命令行，引号转义必错
- `-o resp1.json` —— 响应落盘再读，不要直接打印（长响应会刷屏）

多片时依次 POST `knot_p1.json` … `knot_pn.json`，**最后一片**（`i == n`）才会触发下游突合，中间片只入库。

**第 3 步：读响应确认**（`read_file` 读 `resp1.json`）

- 看到 `"ok":true` = 成功 ✅
- 末片的响应里会有 `merged` 字段（both / spot-only / knot-only 各多少），**把它原样写进你的回复**
- 非 200 或 `"ok":false` → 把响应原文原样贴出来，重试最多 2 次；仍失败就退回 C-4 通道②

### C-6 自检清单（输出前逐条确认）

- [ ] `week` 全数组一致，且是 `{D-7}` 所在的 ISO 周
- [ ] 每行都有 `name` 和 `address`，且是日文原名
- [ ] `lat`/`lng` 全是 `""`，没有 0、没有估算值
- [ ] 任务B 的 `merchant_id` 都带 `MAT` 前缀
- [ ] 同一家店没重复出现
- [ ] 回复末尾的确认块哨兵原样（`rows` 为空数组）；只有走通道②时才填真实数据
- [ ] 走通道①时：curl 的**响应体**里是 `"ok":true` —— 只看 HTTP 200 不够，GAS 出错也可能返 200
- [ ] 数据是任务A/B 真实查出来的，不是推测的

### C-7 失败处理

任务C 失败（HTTP 连续报错、输出被截断等）**不影响任务A/B 的交付与 notify**。
在回复里单独写一行：`地图同步：失败（原因）`，并在 notify 里带上这句即可。不要因为任务C 失败而重跑 SQL。

---

## 附：为什么这么设计

| 约束 | 原因 |
|---|---|
| 用哨兵块而不是「只输出 JSON」 | 你这份 prompt 的主体交付是 Excel + Markdown 摘要，不可能只吐 JSON。哨兵标记让下游能从混合正文里精准截出数据块 |
| 任务B 的 id 加 `MAT` 前缀 | 下游按 `merchant_id + week` 去重留最新。物料行如果没有稳定唯一 id，整批会互相覆盖，只剩最后一行 |
| 坐标一律留空 | 下游会用地址做地理编码补全；填 0 会被当成「几内亚湾」这种错误位置 |
| 分片 ≤ 300 行 | 全日本周新增铺设约 1000-1500 码，一次性输出大概率被平台截断，分片后每片都能完整落地 |
| 店名地址保留日文原名 | 下游靠「店名+地址归一化」跟踩点表匹配，翻译或缩写会直接匹配失败 |
| 任务C 失败不影响 A/B | 地图是看板，Excel 是交付。看板晚一周可以补，交付不能丢 |

# airdrop.satloot.com

三个大类的静态展示站,nginx 直接托管,systemd 定时器每 5 分钟重生成;任一数据源挂了就保留上一版,不会写空。

| 页面 | 数据源 |
|---|---|
| `/` 空投项目 | riskdesk 侧车 `/api/airdrop/projects`(按项目去重,含首见/最近见/上榜次数) |
| `/btt/` BTT 新帖 | `btt/btt_monitor.py` 导出的 `export.json`(bitcointalk 山寨板新帖 + grok 中文速览) |
| `/celeb/` 名人发币 | `celeb/celeb_monitor.py` 导出的 `export.json`(名人/政客/网红发币新闻事件 + grok 中文速览 + 去哪订阅) |
| `/nft/` NFT 打新 | `nft/nft_monitor.py` 导出的 `export.json`(名单项目 + AI 在 X 上发现的项目,grok 联网核查阶段 / 铸造时间 / 价格,变动推送与铸造提醒) |
| `/en/` `/en/btt/` `/en/celeb/` `/en/nft/` | 同四页的英文版(`build.mjs` 里 `LOCALES.en`),互带 hreflang;数据字段是中文来源,按 条目自带 `xxxEn` > 人工译文缓存 `data/i18n-en.json` > 中文原文 取值,本页仍有缺译时顶部才出现提示 |

## 名人发币监控(`celeb/`)

LAPTOP 的教训:WSJ 提前两天报道,空投名单按 Substack 订阅者截。这个进程盯「谁要发币」的新闻,一命中就推微信(PushPlus,不带 topic,只发令牌主人本人)+ Telegram,并给出该去订阅的渠道。

- 数据源:Google News RSS 四组检索(memecoin / meme coin / 身份词 + token / "coin named")+ The Block、CoinDesk、Cointelegraph、Decrypt 站点 RSS,每 10 分钟一轮,不需要任何 key
- 命中:标题 + 摘要同时含「发币动词 + 代币词 + 人物信号」;`celeb/watchlist.json` 点名 = 强命中,只有身份词(celebrity / senator / rapper…)= 疑似;价格涨跌/分析类标题按 `NOISE_RE` 排除
- 聚合:同一人物(或同一 `$TICKER`)7 天内合并为一个事件,只在第一篇推送,后续只累加报道数;首次启动只建基准不推送
- 速览:grok 读事件下最多 12 篇标题摘要,输出 人物/身份/代币/链/日期/状态/空投规则/去哪订阅/可信度/结论/评分
- 配置:`/etc/celeb-monitor.env`(可选,见 `deploy/celeb-monitor.env.example`);推送令牌与 grok 沿用 `/etc/btt-monitor.env` 的 `BTT_*`
- 本地验证规则:`CELEB_HTTP_PROXY=http://127.0.0.1:10809 python celeb/celeb_monitor.py --once`(只打印命中);生成 fixture:`--seed-only` 配 `CELEB_DB` / `CELEB_EXPORT` 指到临时目录
- 服务器:`systemctl status celeb-monitor`、`journalctl -u celeb-monitor -f`;库 `/var/lib/celeb-monitor/celeb.sqlite`(stories / articles / meta / events),导出 `/var/lib/celeb-monitor/export.json`

## NFT 打新追踪(`nft/`)

KOL 推一波 NFT 之后,阶段、铸造时间、价格随时会改。这个进程替人盯:名单项目定时核查,有变动就推,铸造前 24 小时 / 1 小时提醒,再定期在 X 上找新机会。

- 名单:`nft/watchlist.json`(handle = 官方 X 账号;人工资料 + `notes` 里的 KOL 观点与出处)。改完部署即可,进程发现文件变化自动同步;服务器上临时加一个用 `--add 账号 --note "观点" --by @某KOL`(要带 service 里的 NFT_DB 环境变量)
- 核查:每个项目一次 grok 联网调用(X 搜索 + 网页),实测 1.5–2.5 分钟、每次约 5 万 token。**节奏按项目状态分档**(09-16 用户定调"项目不用频繁验证,找到了就行";项目数不设上限):已申请项目铸造前后 1 小时、名单项目铸造前后 4 小时(AI 发现的不进这两档)、已公布铸造日期 12 小时、白名单申请中 24 小时、暂无日程 48 小时、已售罄 / 上市 / 取消 7 天;AI 发现的项目再 ×2(`NFT_DISCOVERED_FACTOR`)。各档是 `NFT_APPLIED_NEAR_/NEAR_/DATED_/WL_/QUIET_/ENDED_TRACK_EVERY_SEC`。发现轮次保持 2 小时一次
- 配额:grok 按周配额,09-16 实测一天 187 次核查 ≈ 周配额 42%。用户的规矩是**不为省配额关功能或降频,配额用完换 grok 账号**:`sudo -u riskdesk HOME=/opt/riskdesk grok logout` 再 `grok login --device-code`(登录态 /opt/riskdesk/.grok,三个监控与 riskdesk 侧车共用)。真要临时省,设 `NFT_DAILY_BUDGET_USD`(默认 0 = 不限;设正数则超额后只核查 48 小时内要铸造的与已申请项目、发现暂停到次日)
- 查用量:服务器 `~riskdesk/.grok/sessions/` 按 cwd 分目录(`%2Fvar%2Flib%2Fnft-monitor` 等),数 24 小时内的文件数与大小就知道哪个监控在烧配额
- grok 的 `--json-schema` 与联网工具不兼容(工具旁白混进输出导致解析失败),所以用 `--output-format json` 取文本,再抠出最后一个合规 JSON
- 变动:只比 阶段、铸造时间(差 1 小时以上)、铸造价(数字 + 币种)、总量、单钱包上限;这次没查到的字段沿用上次,不算变动;每个项目第一次核查只做基准;没读到官方推文且没有来源链接的变动不推送
- 发现:3 小时一轮,grok 在 X 上找最多 8 个新的白名单 / mint 机会,入库为「AI 发现」合并推一条;首轮只做基准;AI 发现的项目最多追踪 40 个,超出按 已结束 → 评分低 → 收录早 停
- 推送带当时价格:铸造价 + 折合美元 + ETH 现价(币安 → Coinbase → OKX,直连不通走 grok 代理)
- 配置:`/etc/nft-monitor.env`(可选,`NFT_TRACK_EVERY_SEC` / `NFT_DISCOVER_EVERY_SEC` / `NFT_DISCOVER=0` / `NFT_DAILY_BUDGET_USD` 等);推送令牌与 grok 沿用 `/etc/btt-monitor.env`
- 临时库试跑(不推送):`NFT_DB=/tmp/x/nft.sqlite NFT_EXPORT=/tmp/x/export.json python3 nft/nft_monitor.py --no-push --track-all`,再 `--discover-once`
- 服务器:`systemctl status nft-monitor`、`journalctl -u nft-monitor -f`;库 `/var/lib/nft-monitor/nft.sqlite`(projects / snapshots / changes / meta / events),导出 `/var/lib/nft-monitor/export.json`

- `build.mjs` 生成器:拉两路数据 → 同一 `template.html` 按 `LOCALES.zh` / `LOCALES.en` 各渲染一遍 → 原子写 `index.html` `btt/index.html` `en/index.html` `en/btt/index.html` `data.json` `btt/data.json` `robots.txt` `sitemap.xml`(四个 URL 带 alternate)。每页 head 带 canonical / hreflang / OG + Twitter 卡片 / JSON-LD(Organization + WebSite + WebPage + ItemList 前 20 项)
- `static/` 不经模板的静态文件,目前只有 OG 分享图 `og.png`(1200×630,`node tools/make-og.mjs` 用 resvg + 系统字体生成,产物进 git)。`build.mjs` 每次跑都先把它原样复制到输出目录;定时生成只写具体文件、不清目录,不会冲掉它
- `template.html` 布局模板(筛选/搜索/排序纯前端通用脚本:tab 的 `data-filter=x` 对应卡片 `data-x="1"`,排序按 `data-<key>` 数值降序)。中文页首部有一段极小内联脚本:没记过语言选择且浏览器语言不是中文就 `location.replace` 到 `/en/`;导航里的语言切换链接把选择记进 `localStorage.lang`,爬虫 UA 不跳转
- `btt/btt_monitor.py` BTT 监控:原版 `autofish/monitorbitcoin.py` 的推送逻辑原样保留(TG 每帖一条 + 微信一轮合并一条,首次只记基准),新增 SQLite 落库、后台线程 grok 速览、export.json 导出
- `deploy/` nginx 站点、`airdrop-site` 服务+定时器、`btt-monitor` / `celeb-monitor` 服务与 env 模板、`setup.sh` 一键安装(幂等)
- `fixture/` 真实接口返回 + BTT / 名人发币导出样例,本地测试用

## 英文译文缓存(`data/i18n-en.json`)

雷达 / 监控产出的字段都是中文,英文页不调任何翻译 API,只查这份人工译文缓存:键 = `plain()` 规范化后的中文原文(去 markdown、压空白),值 = 英文。同一句话出现在多个条目 / 页面只译一次;原文一更新就自然变成缺译、回落中文,不会张冠李戴。文件随代码部署(服务器 `/opt/airdrop-site/data/i18n-en.json`,生成器按 `__dirname` 读取,可用 `AIRDROP_I18N_EN` 覆盖),读不到就全部回落中文,不影响生成。

补译流程(新空投 / 新帖 / NFT 核查结果会持续产生新的中文,需要定期补):

```bash
node tools/list-missing-en.mjs                    # 拉线上四个 data.json 用同一生成器渲染,打印各页缺译条数与英文页中文残留
node tools/list-missing-en.mjs --out todo.json    # 缺译写成 {"中文": ""} 骨架(--page airdrop,celeb 可只看某几页,--print 逐条打印)
node tools/list-missing-en.mjs --merge todo.json  # 填好英文后并回缓存(空串跳过,键排序写回),再部署
```

专有名词 / 代币名 / 项目名 / 链名保持原样。生成日志末尾会打印 `en cache N, M strings still Chinese`。

## 本地测试

```bash
AIRDROP_FIXTURE_DIR=./fixture node build.mjs   # 输出到 ./dist,不联网
```

## 部署 / 更新(本机)

```bash
cd /d/CLAUDE/airdrop-site && tar czf - --exclude=dist --exclude=fixture --exclude=.claude --exclude=__pycache__ . | ssh -i ~/.earnfarm-deploy/earnfarm_deploy_key root@172.96.9.5 'mkdir -p /opt/airdrop-site && tar xzf - -C /opt/airdrop-site && bash /opt/airdrop-site/deploy/setup.sh'
```

服务器:
- 代码 `/opt/airdrop-site`,页面输出 `/var/www/airdrop-satloot`
- 页面生成:`systemctl status airdrop-site.timer`、`journalctl -u airdrop-site -n 20`、手动 `systemctl start airdrop-site.service`
- BTT 监控:`systemctl status btt-monitor`、`journalctl -u btt-monitor -f`;库 `/var/lib/btt-monitor/btt.sqlite`(posts / meta / events),导出 `/var/lib/btt-monitor/export.json`
- BTT 配置 `/etc/btt-monitor.env`(root 600,令牌只在这里);以 riskdesk 用户跑,借 `/opt/riskdesk/.grok` 的 grok 登录态,出网走 127.0.0.1:10809

空投接口在 earn.satloot.com 上有登录墙;生成器跑在服务器本机、不经 nginx 直连 127.0.0.1:5177,riskdesk 的 RISKDESK_AUTH_LOCAL_ADMIN=1 把这种请求当站主放行(只读三个 GET 接口)。

## grok 配额用完时的 Codex 备用(`lib/ai_fallback.py`,2026-09-20)

grok 走 SuperGrok 周配额,用完后 CLI 退出码 1、正文里是 `API error (status 402 Payment Required): Grok Build usage balance exhausted`。
备用**不走 OpenAI API、不需要 API key**,而是用用户自己的 ChatGPT 订阅:服务器上装了 `@openai/codex`
(`/opt/riskdesk-node/bin/codex`,以 riskdesk 用户、`HOME=/opt/riskdesk` 做过一次设备码登录,
登录态在 `/opt/riskdesk/.codex/auth.json`),备用就是 spawn 一个 `codex exec`。
用户定的规矩是**只给便宜的三条链路配备用,贵的那条直接暂停**:

| 链路 | grok 耗尽时 | 联网 |
| --- | --- | --- |
| BTT 新帖速览 `btt/btt_monitor.py` | 切 codex `gpt-5.6-luna` | 否(`BTT_CODEX_WEB=1` 可开) |
| 名人发币速览 `celeb/celeb_monitor.py` | 切 codex `gpt-5.6-luna` | 否 |
| 空投雷达 `riskdesk/server/airdrop.mjs` | 切 codex `gpt-5.6-luna` + `-c tools.web_search=true` | 是 |
| **NFT 打新追踪 `nft/nft_monitor.py`** | **本轮直接跳过,不调 codex** | — |

- 模型与强度:订阅侧**没有** nano / mini,09-20 在服务器上实测可用的最小一档是 `gpt-5.6-luna`(还有个隐藏档 `gpt-reserve` 也能跑,想换设 `CODEX_MODEL`);`model_reasoning_effort` 只认 `low/medium/high/xhigh/max`,`minimal` 会直接退出码 1,所以默认 `low`(`CODEX_REASONING_EFFORT` 可改,认不出来会自动降回 `low` 重试一次)。
- 命令行:`codex exec -C <每次新建的空目录> -s read-only --skip-git-repo-check --ephemeral -m <模型> -c model_reasoning_effort=low --json -o <文件> -`,提示词走 stdin(长文不受 argv 长度限制;codex 不接管 stdin 时会一直读到 EOF,写完必须关),正文取 `-o` 那个文件(联网时中途还会吐一条「我先去查一下」的 agent_message,不能当正文),用量从 `--json` 事件流的 `turn.completed.usage` 里取。联网只在空投发现那一路开:`codex exec` 没有 `--search`(那是顶层 flag),要写 `-c tools.web_search=true`。结构化输出走 `--output-schema`,模块会自动把 schema 补成 strict 模式(`required` 列全、`additionalProperties: false`)。
- 切换规则:任一条链路的 grok 调用撞上 402(或连续 `AI_GROK_FAIL_STREAK` 次普通失败,默认 5),就往 `$HOME/.grok-exhausted` 写标记(服务器上四个服务的 HOME 都是 `/opt/riskdesk`,所以标记是**共享**的:NFT 先撞上,BTT / 空投雷达下一次就直接走备用,不用各撞一次)。
- 恢复规则:标记超过 `AI_GROK_RETRY_MIN` 分钟(**09-20 用户拍板:60 → 240,即 4 小时**;周配额不可能一小时回血,白撞一次纯浪费)就算过期,下一次调用会拿 grok 探一次路——成功即删标记,四条链路一起切回 grok(NFT 追踪自动恢复);还是 402 就把标记时间往后推 4 小时。也可以手动 `python3 lib/ai_fallback.py clear`。
- codex 没装 / 没登录(`$CODEX_HOME/auth.json` 不在)/ `CODEX_FALLBACK=0`:备用不启用,四条链路的行为与加这套之前完全一致(只多一条日志,每个进程只提示一次)。
- 用量:订阅制没有按次美元,改记 token。`$HOME/.ai-fallback-usage.json` 按北京时间自然日累计 calls / in / cached / out / reasoning / 搜索次数;**不设硬上限**(用户的规矩:不自作主张限额),每次调用一条 `[ai] provider=codex model=… in=… out=…` 日志,跨天时补一条前一天的日汇总。看现状:`python3 lib/ai_fallback.py status`。
- 备用链路用**另一份精简提示词**(codex 每次调用光它自己的系统提示词就上万 token,提示词能省一点是一点):BTT `build_fallback_prompt()` 只喂标题 + 正文前 1500 字(`BTT_FALLBACK_MAX_CHARS`)、去掉"用 X 搜索核实"那段;名人 `build_fallback_prompt()` 只喂人物/代号 + 前 6 条标题(`CELEB_FALLBACK_ARTICLES`)。输出格式交给 `--output-schema`(两边都把现成的 `ANALYSIS_SCHEMA` 传下去),不再写进提示词;模型万一不照办,两边的 `extract_json` 仍然能从 ```` ```json ```` 代码块 + 前后废话里抠出对象。
- 配置:`/etc/btt-monitor.env`(BTT / 名人 / NFT 共用)与 `/etc/riskdesk.env`(空投雷达)里各有一行 `CODEX_BIN=/opt/riskdesk-node/bin/codex`——三个 python 服务与 riskdesk 的 PATH 里没有它,必须写全路径。**不需要任何 API key**;登录过期了就重跑一次 `sudo -u riskdesk env HOME=/opt/riskdesk /opt/riskdesk-node/bin/codex login --device-auth`。
- 本机自测:riskdesk 侧 `server/ai-fallback.assert.mjs`(`npm run assert` 会跑,用一个假的 codex 可执行文件顶替真 CLI,62 项);python 侧的切换逻辑与它同构,改了两边都要对一遍。

BTT 速览:每帖一次 grok-4.5 调用(`--json-schema` 结构化输出,关闭网页搜索),实测约 20 秒、0.01 美元;失败最多重试 3 次后标 failed。走 codex 备用时实测约 10 秒、约 1.3 万 token(其中一万多是 codex 自己的系统提示词,省不掉)。

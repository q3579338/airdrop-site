# airdrop.satloot.com

两个大类的静态展示站,nginx 直接托管,systemd 定时器每 5 分钟重生成;任一数据源挂了就保留上一版,不会写空。

| 页面 | 数据源 |
|---|---|
| `/` 空投项目 | riskdesk 侧车 `/api/airdrop/projects`(按项目去重,含首见/最近见/上榜次数) |
| `/btt/` BTT 新帖 | `btt/btt_monitor.py` 导出的 `export.json`(bitcointalk 山寨板新帖 + grok 中文速览) |
| `/en/` `/en/btt/` | 同两页的英文壳(`build.mjs` 里 `LOCALES.en`),互带 hreflang;项目描述/速览是中文来源,英文页原样保留并在顶部注明 |

- `build.mjs` 生成器:拉两路数据 → 同一 `template.html` 按 `LOCALES.zh` / `LOCALES.en` 各渲染一遍 → 原子写 `index.html` `btt/index.html` `en/index.html` `en/btt/index.html` `data.json` `btt/data.json` `robots.txt` `sitemap.xml`(四个 URL 带 alternate)。每页 head 带 canonical / hreflang / OG + Twitter 卡片 / JSON-LD(Organization + WebSite + WebPage + ItemList 前 20 项)
- `static/` 不经模板的静态文件,目前只有 OG 分享图 `og.png`(1200×630,`node tools/make-og.mjs` 用 resvg + 系统字体生成,产物进 git)。`build.mjs` 每次跑都先把它原样复制到输出目录;定时生成只写具体文件、不清目录,不会冲掉它
- `template.html` 布局模板(筛选/搜索/排序纯前端通用脚本:tab 的 `data-filter=x` 对应卡片 `data-x="1"`,排序按 `data-<key>` 数值降序)。中文页首部有一段极小内联脚本:没记过语言选择且浏览器语言不是中文就 `location.replace` 到 `/en/`;导航里的语言切换链接把选择记进 `localStorage.lang`,爬虫 UA 不跳转
- `btt/btt_monitor.py` BTT 监控:原版 `autofish/monitorbitcoin.py` 的推送逻辑原样保留(TG 每帖一条 + 微信一轮合并一条,首次只记基准),新增 SQLite 落库、后台线程 grok 速览、export.json 导出
- `deploy/` nginx 站点、`airdrop-site` 服务+定时器、`btt-monitor` 服务与 env 模板、`setup.sh` 一键安装(幂等)
- `fixture/` 真实接口返回 + 一份 BTT 导出样例,本地测试用

## 本地测试

```bash
AIRDROP_FIXTURE_DIR=./fixture node build.mjs   # 输出到 ./dist,不联网
```

## 部署 / 更新(本机)

```bash
cd /d/CLAUDE/airdrop-site && tar czf - --exclude=dist --exclude=fixture . | ssh -i ~/.earnfarm-deploy/earnfarm_deploy_key root@172.96.9.5 'mkdir -p /opt/airdrop-site && tar xzf - -C /opt/airdrop-site && bash /opt/airdrop-site/deploy/setup.sh'
```

服务器:
- 代码 `/opt/airdrop-site`,页面输出 `/var/www/airdrop-satloot`
- 页面生成:`systemctl status airdrop-site.timer`、`journalctl -u airdrop-site -n 20`、手动 `systemctl start airdrop-site.service`
- BTT 监控:`systemctl status btt-monitor`、`journalctl -u btt-monitor -f`;库 `/var/lib/btt-monitor/btt.sqlite`(posts / meta / events),导出 `/var/lib/btt-monitor/export.json`
- BTT 配置 `/etc/btt-monitor.env`(root 600,令牌只在这里);以 riskdesk 用户跑,借 `/opt/riskdesk/.grok` 的 grok 登录态,出网走 127.0.0.1:10809

空投接口在 earn.satloot.com 上有登录墙;生成器跑在服务器本机、不经 nginx 直连 127.0.0.1:5177,riskdesk 的 RISKDESK_AUTH_LOCAL_ADMIN=1 把这种请求当站主放行(只读三个 GET 接口)。

BTT 速览:每帖一次 grok-4.5 调用(`--json-schema` 结构化输出,关闭网页搜索),实测约 20 秒、0.01 美元;失败最多重试 3 次后标 failed。

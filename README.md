# airdrop.satloot.com

空投项目展示站。数据来自 riskdesk 侧车的空投雷达存档接口(`/api/airdrop/projects`,按项目去重,含首见/最近见/上榜次数),
每 10 分钟由 systemd 定时器在服务器本机重生成一份静态页,nginx 直接托管。侧车挂了就保留上一版,不会写空。

- `build.mjs` 生成器:拉 projects/status/reports → 渲染 `template.html` → 写 `index.html` `data.json` `robots.txt` `sitemap.xml`(原子写)
- `template.html` 页面模板(筛选/搜索/排序纯前端,无依赖)
- `deploy/` nginx 站点、systemd 服务+定时器、`setup.sh` 一键安装(幂等)
- `fixture/` 一份真实接口返回,本地测试用

## 本地测试

```bash
AIRDROP_FIXTURE_DIR=./fixture node build.mjs   # 输出到 ./dist
```

## 部署 / 更新(本机)

```bash
tar czf - --exclude=dist --exclude=fixture --exclude=node_modules . | ssh -i ~/.earnfarm-deploy/earnfarm_deploy_key "$(cat ~/.earnfarm-deploy/host.txt)" 'mkdir -p /opt/airdrop-site && tar xzf - -C /opt/airdrop-site && bash /opt/airdrop-site/deploy/setup.sh'
```

服务器:`/opt/airdrop-site`(代码)、`/var/www/airdrop-satloot`(输出)、`systemctl status airdrop-site.timer`、`journalctl -u airdrop-site -n 20`。
手动重生成:`systemctl start airdrop-site.service`。

数据接口在 earn.satloot.com 上有登录墙;生成器跑在服务器本机、不经 nginx 直连 127.0.0.1:5177,riskdesk 的 RISKDESK_AUTH_LOCAL_ADMIN=1 把这种请求当站主放行(只读三个 GET 接口)。

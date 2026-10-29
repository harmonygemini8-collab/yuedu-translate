# 23 代码同步（提交、推送、拉取与代理）

> 文档编号：OPS-002 ｜ 版本：v0.1 ｜ 状态：可执行
>
> 用途：本机怎么提交推送、另一台机器和服务器怎么拉取、需要代理时怎么走、哪些东西不该进仓库。
> 部署本身见 [16 服务器部署](./16-server-deployment.md)、[13 §4 官网](./13-website.md)；版本号规则见 [14 §5](./14-release-process.md)。

仓库：`https://github.com/harmonygemini8-collab/Yilin-Translate.git`（本机用 HTTPS，服务器用 SSH 部署密钥）。

## 1. 一句话

**本机写代码、构建、提交、推送；服务器只 `git pull` 加重启。** 服务器上没有 `node_modules`，所有 `npm run` 在那里都跑不了。

## 2. 代理

GitHub 在国内直连经常超时或中途断开。本机的代理是 `http://127.0.0.1:10808`。

### 2.1 当前的生效方式：环境变量

本机已设置下列环境变量，git、npm、curl 都会自动走代理，**平时不用加任何参数**：

```text
HTTP_PROXY=http://127.0.0.1:10808
HTTPS_PROXY=http://127.0.0.1:10808
NO_PROXY=localhost,127.0.0.1,::1,.local
```

`NO_PROXY` 很重要：本机后端 `http://127.0.0.1:8787` 和预览端口不能走代理，否则连自己都连不上。

### 2.2 临时加代理（环境变量没生效时）

只对这一条命令有效，不改任何配置：

```bash
git -c http.proxy=http://127.0.0.1:10808 push
```

```bash
git -c http.proxy=http://127.0.0.1:10808 pull --ff-only
```

```bash
git -c http.proxy=http://127.0.0.1:10808 fetch --tags
```

### 2.3 写进配置（换机器、或不想每次带参数）

```bash
git config --global http.proxy http://127.0.0.1:10808
```

只对 GitHub 走代理、其他仓库直连：

```bash
git config --global http.https://github.com.proxy http://127.0.0.1:10808
```

取消：

```bash
git config --global --unset http.proxy
```

查看当前有哪些代理设置：

```bash
git config --global --get-regexp proxy
```

### 2.4 验证代理是否可用

推之前先试这条，它只读、很快，不会改任何东西：

```bash
git ls-remote origin HEAD
```

能打印出一行 commit 哈希就说明通道正常。报 `Failed to connect to 127.0.0.1 port 10808` 是**代理软件没开**；报 `Recv failure` 或长时间卡住多半是**没走代理**。

### 2.5 SSH 协议走代理

服务器用 SSH 部署密钥，但服务器在海外，**不需要代理**。只有在本机改用 SSH 远程时才需要，写进 `~/.ssh/config`：

```text
Host github.com
  ProxyCommand connect -S 127.0.0.1:10808 %h %p
```

Windows 自带的 OpenSSH 可以用 `connect.exe`（Git for Windows 附带）。本机保持 HTTPS 就不用管这一节。

## 3. 本机日常

```bash
npm run check
```

```bash
git add -A && git status --short
```

先看一眼 `git status`，确认没有把调试文件、截图、`.env` 混进去，再提交：

```bash
git commit -m "一句话说清这次改了什么"
```

```bash
git push
```

规矩：

- **`npm run check` 必须先过**（typecheck + 测试 + 构建），别把红的推上去。
- 改动按主题分开提交，不要把无关的东西堆在一个提交里。
- 文档和代码在**同一次提交**里同步（见 `AGENTS.md`）。
- 不要 `git push --force`：多台机器和多个会话共用这个分支，强推会把别人的提交抹掉。

## 4. 另一台机器 / 另一个会话拉取

工作区干净时：

```bash
git pull --ff-only
```

`--ff-only` 的意思是「只快进，不自动合并」。要是它报 `Not possible to fast-forward`，说明本地有没推的提交，改用：

```bash
git pull --rebase
```

本地改到一半又想拉最新代码：

```bash
git stash && git pull --ff-only && git stash pop
```

拉完**重新跑一次 `npm run check`**——别人的改动可能和你的冲突，在本机发现比在服务器上发现便宜得多。

## 5. 服务器拉取：三种，不要混

| 目标 | 在哪 | 命令 |
|---|---|---|
| **API 服务**（`api.warptech.cc`） | 服务器 | `cd /opt/yuedu/app && sudo -u yuedu git pull && sudo systemctl restart yuedu-api` |
| **管理后台** | 服务器 | 同上。后台页面是**随仓库提交的构建产物**（`server/admin-ui/dist/`），服务器不需要构建 |
| **官网**（`www.warptech.cc`） | 服务器 | `git pull` 后还要 `npm run site:build`，再把 `website/dist/` 的内容放到 `/var/www/yilin/` |

官网那条要注意：`website/dist/` **不在仓库里**，拉取拉不到，必须构建。详细步骤和 nginx 配置见 [13 §4](./13-website.md)。

服务器用的是只读部署密钥（Deploy key，没勾 write），所以**服务器上推不了**，只能拉。要改东西就在本机改完推上去，再去服务器拉。

重启后确认一眼：

```bash
sudo systemctl status yuedu-api --no-pager
```

```bash
sudo journalctl -u yuedu-api -n 20 --no-pager
```

## 6. 哪些东西不进仓库

| 不提交 | 原因 |
|---|---|
| `server/.env` | API 密钥、`YILIN_AUTH_SECRET`。只有 `.env.example` 进仓库 |
| `node_modules/`、`dist/`、`coverage/` | 构建与安装产物，本机重新生成 |
| `release/build/`、`*.zip` | 打包产物，每次 `npm run release` 重新生成 |
| `website/dist/` | 官网构建产物，服务器自己构建 |
| `server/data/` | 线上数据库与用量账本 |
| `tmp-*.html`、`boom.html` | 一次性调试用的页面 |
| `release/assets/*/source-*/`、`audio/`、`review-*.png`、`encoded-*.png` | 视频渲染中间件，约 200 MB，脚本可重新生成。成片、字幕、封面、上传文案照常提交 |

**例外**：`server/admin-ui/dist/` 是故意提交的——这样服务器只要 `git pull` 就能更新后台，不用在服务器上装依赖。`.gitignore` 里对应的那条 `!server/admin-ui/dist/` 不能删。

## 7. 版本标签

每个发布版本打标签，标签要指向**与上传商店的 zip 相同的那个提交**：

```bash
git tag -a v0.3.5 -m "Release 0.3.5" && git push origin v0.3.5
```

需要临时带代理时：

```bash
git -c http.proxy=http://127.0.0.1:10808 push origin v0.3.5
```

改完代码重新打包后，标签也要跟着移动。版本号规则见 [14 §5](./14-release-process.md)。

## 8. 踩过的坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 打开 `/admin/` 返回 503 `ADMIN_UI_MISSING` | `.gitignore` 的 `dist/` 把 `server/admin-ui/dist/` 一起挡掉了，构建产物根本没进仓库 | 保留 `!server/admin-ui/dist/` 这一行；本机 `npm run build:admin-ui` 后提交 |
| 调试用的网页被提交进仓库 | `git add -A` 一把全加 | 提交前看 `git status --short`；一次性文件按 `tmp-*.html` 命名，已被忽略 |
| 推送卡住或 `Recv failure` | 代理没开，或环境变量没生效 | 先 `git ls-remote origin HEAD` 验证，再按 §2.2 临时带参数 |
| nginx 配置粘贴后域名变成 `[www.warptech.cc](https://…)` | 从聊天窗口复制，富文本把域名转成了 Markdown 链接 | 一律 `git pull` + `cp`，不手工粘贴（[13 §4.5](./13-website.md)） |
| 服务器上 `npm run …` 报错 | 服务器没有 `node_modules` | 所有构建在本机做（[18 §1.1](./18-invite-operations.md)） |
| 仓库里的版本号不等于商店已发布版本 | 打包推送后还要上传和审核 | 以商店后台显示为准（[14 §3](./14-release-process.md)） |

# 05 系统架构设计

> 文档编号：ARCH-001 ｜ 版本：v0.1 ｜ 状态：待评审

## 1. 总体架构

```text
Chrome 扩展（Manifest V3）
├─ Popup / Options   操作、设置、账号与额度
├─ Content Script    正文识别、可视区域调度、动态观察、译文渲染
└─ Service Worker    消息校验、会话、与平台后端通信、翻译服务适配
                │ HTTPS
                ▼
阅渡平台 API（server/，开发版已实现）
├─ 身份认证与访问控制（邮箱验证码账号 + 运维令牌）
├─ 月度预算预留与结算、按服务字符上限、限流
├─ 翻译任务与幂等控制（待实现）
└─ 供应商适配层：Microsoft / Google Cloud Translation / OpenAI
                │
                ▼
免费档：Microsoft Translator F0 ｜ 付费档：Google Cloud Translation、OpenAI
（谷歌免费接口由扩展 Service Worker 直连，不经过服务器）
```

平台供应商密钥只存在服务端，扩展不持有。翻译服务方案与费用规则见 [11 翻译服务与费用控制](./11-translation-services.md)。

## 2. 技术选型

| 层级 | 选型 | 说明 |
|---|---|---|
| 语言 | TypeScript | 扩展与后端共享类型 |
| 扩展构建 | esbuild | 原型阶段依赖少、构建快；如后续需要 HMR 再评估 WXT |
| 扩展 UI | 原生 DOM + CSS | 弹窗和设置页简单，避免注入脚本体积膨胀；复杂度上升后再评估 React |
| 单元测试 | Vitest + jsdom | 正文识别、渲染、调度逻辑 |
| 端到端测试 | Playwright（加载解包扩展） | 阶段 D 引入 |
| 后端（开发版） | Node.js 24 原生 `http`，类型剥离直接运行 TypeScript | 无第三方运行时依赖；正式版视负载评估 Fastify 等框架 |
| 数据库（MVP-A） | PostgreSQL | 账号、配额账本、订单 |
| 缓存/限流（MVP-A） | 视负载评估 Redis | 技术验证后决定 |

## 3. 扩展模块划分

```text
src/
├─ shared/        消息协议、设置模型、常量（各上下文共享）
├─ background/    Service Worker：消息路由、翻译服务适配、右键菜单、快捷键
├─ content/       extractor（正文识别）、renderer（译文渲染）、
│                 controller（会话状态、可视区域调度、批量提交、动态内容）、
│                 subtitles（视频字幕：字幕轨与播放器自绘字幕，叠加双语）
├─ popup/         弹窗（账号栏 + 翻译控制；登录按钮直接跳官网 /login）
└─ options/       设置页（侧边栏导航：基本设置 / 翻译样式 / 站点管理 / 账号 / 关于）

server/
├─ app.ts         路由、鉴权、校验、限流、错误映射、仅元数据日志
├─ usage.ts       月度预算账本（预留 → 结算，按月清零，JSON 持久化）
├─ providers/     microsoft.ts（Translator v3 F0）、siliconflow.ts（免费开源模型，OpenAI 兼容接口）、
│                 google.ts（Cloud Translation v2）、openai.ts（Responses API）
├─ config.ts      环境变量配置
└─ index.ts       启动入口（读取 server/.env）
```

后端地址在构建时注入（`YILIN_API_BASE` 或 `--api=`）；未注入时扩展只能使用谷歌免费翻译。manifest 不声明任何 `host_permissions`——两个翻译接口都允许跨域请求，Service Worker 靠 CORS 直接访问，详见 [07 §2](./07-security-privacy.md)。

### 3.1 登录流程与 link-state token 回传

扩展弹窗 / 设置页不内嵌登录表单，而是把用户引导到官网 `https://getyuedu.com/login` 完成登录（2026-10-24 起；`www.warptech.cc/login` 仍可用，301 跳转到这里，见 [13 §7.1](./13-website.md)）：

```
弹窗 / 设置页                  服务器                     官网 /login
─────────────────────────────────────────────────────────────────────
1. 生成 state UUID
   写入 chrome.storage.local
   打开 /login?from=extension&state=<uuid>
                               ↓
2.                             用户完成登录（Google OAuth 或邮件 OTP）
                                         POST /v1/auth/link-state
                                              { state, token }
                               ↓（存入内存 Map，5 分钟 TTL）
3. 下次打开弹窗时
   轮询 GET /v1/auth/link-state/:state（每 3 秒）
                               ↓ 返回 { token }
4. 写入 chrome.storage.local[SESSION_TOKEN_KEY]
   清除 pendingLoginState
   刷新账号 UI
```

- **弹窗**：`popup.ts` 生成 state，关闭弹窗后轮询在下次打开时继续（token 存服务器，不依赖弹窗常驻）。
- **设置页**：`options.ts` 打开官网同时在页面内启动轮询，状态显示在"等待登录..."提示中。
- **服务端**：`server/auth.ts` 的 `storeLinkState` / `retrieveLinkState`；`server/app.ts` 暴露 `POST /v1/auth/link-state` 和 `GET /v1/auth/link-state/:state`。

### 3.2 翻译服务适配接口

```ts
interface TranslationProvider {
  translate(batch: { id: string; text: string }[], target: string): Promise<Result[]>;
}
```

| 实现 | 阶段 | 说明 |
|---|---|---|
| GoogleFree | 已实现 | 浏览器直连谷歌免费接口（`src/background/google-free.ts`） |
| MockProvider | 已移除 | 原型阶段的本地模拟服务，已于 2026-10-01 删除 |
| PlatformProvider | 已实现 | 调用阅渡平台 `POST /v1/translate`，按用户选择的服务（google/openai） |

Content Script 不直接访问任何外部网络，全部经 Service Worker 转发。

## 4. 正文处理设计

1. **识别：**按段落组织文本；行内链接、强调等保留在同一段落中，避免碎片化。
   - `p/h1–h6/li/td/th/dd/dt/blockquote/figcaption/summary/caption` 只要有文字即为段落；
   - `div/section/article/aside/header/figure` 等容器，仅在“直接含文字”或“只含行内元素”时作为段落；
   - 嵌套段落（如 `li` 内的子列表）各自独立，父段落文本不包含子段落；
   - **`<br>` 分段**：工单系统、纯文本邮件渲染等会把多个自然段写在同一元素里、用 `<br><br>` 分隔。此类元素按「连续两个及以上 `<br>`」切分，每个自然段用扩展自己的 `<span data-yilin-line>` 包裹后各自成段，译文插在对应段落下方，而不是整块只译一次、译文堆在签名后面；单个 `<br>` 视为段内换行，保留在同一段。切分幂等（再次扫描复用已有包裹），恢复时连同译文一起解包，页面 DOM 还原。
2. **主内容范围：**页面存在 `main`/`[role=main]` 时只处理其中内容，否则使用 `article`；若该范围内文字不足全页可翻译文字的 25%，回退为整页。
3. **过滤：**
   - 标签与角色：`script/style/pre/textarea/input/button/label/svg/math/iframe/nav/footer`、`role=navigation/button/toolbar/tab/menu/banner/contentinfo/search`、可编辑区域、`translate="no"`、`.notranslate`、隐藏元素；
   - 类名/ID 噪声词（整词匹配）：`nav/menu/sidebar/toc/breadcrumb/cookie/consent/share/ad/sponsor/promo/newsletter/subscribe/cta/pagination/related/meta/footer/reply` 等；`main/article` 自身及包含它们的祖先不受此规则影响；
   - 内容规则：字母少于 2 个；全部文字位于 `code/kbd/samp/var` 内；单个无空格的标识符（`a.b`、`f()`、`@user`、域名）；≥3 个链接且无链接外文字（菜单）；目标语言为中文时，中文为主的文本（中文字数 ÷ 2 ≥ 英文词数，含假名的视为日文）。
   - 评测结果见 `tests/fixtures/README.md`。
   - **翻译范围**（设置项 `scope`）：以上 2、3 条为“正文”模式（默认）。“整页”模式不限主内容范围、不做类名噪声与菜单链接过滤，并把 `button/label/legend`、独立链接（父元素无散文字的 `<a>`）、导航/标签页/工具栏等角色区域纳入；仍排除代码、表单值（`input/textarea/select`）、可编辑区域、隐藏元素、`translate="no"` 及单个标识符。整页模式下 40 字以内的按钮、链接、表单标签、导航区域内文字及无句末标点的短文本标为 `compact`：译文插入承载文字的最内层元素末尾，同一行内联显示（0.9 倍字号、无竖线、不换行），避免在横向弹性布局的菜单项中被挤成一字一行。`segmentText` 必须与提取使用同一范围，否则指纹不一致会丢弃结果。
4. **标记：**为每个段落分配 ID 并记录文本指纹（规范化文本的哈希）。
5. **调度：**使用 `IntersectionObserver` 优先处理可视区域附近段落，按批次提交。
6. **动态内容：**`MutationObserver` 合并处理新增节点，忽略扩展自身插入的节点，避免循环翻译。
7. **渲染：**译文以独立元素插入原文之后，内容使用 `textContent` 写入。
8. **过期保护：**结果绑定会话代次（session generation）、段落 ID 与文本指纹，任一不符则丢弃。
9. **恢复：**依据扩展标记移除插入节点与属性，不重建原文 DOM。

## 5. 关键流程

### 5.1 翻译当前页面

```text
用户点击“翻译此页”
→ Popup 发送 START 给 Content Script
→ Content 识别段落，可视区域段落入队
→ Content 发送批次给 Service Worker
→ Service Worker 调用 Provider
→ 结果返回 Content，校验代次与指纹后渲染
→ 状态变化通知 Popup
```

### 5.2 Service Worker 生命周期

Service Worker 可能在空闲约 30 秒后被终止。设计要求：

- 会话状态保存在 Content Script（页面生命周期内）与服务端任务记录中；
- Service Worker 只做无状态转发，被终止后重新唤醒不影响正确性；
- 设置保存在 `chrome.storage`，不依赖内存全局变量。

## 6. 权限设计

| 权限 | 用途 | 阶段 |
|---|---|---|
| `activeTab` | 用户触发时临时访问当前标签页 | 原型起 |
| `scripting` | 按需注入 Content Script | 原型起 |
| `storage` | 保存设置与站点禁用列表 | 原型起 |
| `contextMenus` | 右键菜单入口 | 原型起 |
| `optional_host_permissions: *://*/*` | 安装时不申请。两条授权路径：加入「自动翻译」列表时逐站申请；或在选项页打开「允许在所有网站上运行」一次性申请 `*://*/*`。后者为 0.3.2 新增，因为嵌入式在线文档的实际域名无法预先知晓（见 §框架内翻译）。两者均可随时收回 | 已实现 |

### 框架内翻译（0.3.2）

Content Script 注入时带 `allFrames: true`，并向所有框架发送命令（不再限定 `frameId: 0`），因为 WPS 这类在线文档渲染器把正文放在嵌套 iframe 里，只跑顶层框架恰好漏掉用户唯一在意的那部分。三个配套约束：

- 子框架需 ≥ 200×200 才运行，挡掉广告与追踪用的小框架；
- 只有顶层框架应答 popup，否则多个框架抢着 `sendResponse` 会让状态不确定；
- 跨域子框架需要对其源的 host 权限，`activeTab` 只覆盖顶层 origin——这正是「允许在所有网站上运行」开关存在的理由。

`syncAutoTranslateScripts` 串行执行：启动、设置变更、权限增删会同时触发它，并发的两次运行会双双读到旧注册状态，导致 Chrome 报 Duplicate / Nonexistent script ID 并最终什么都没注册上。

不申请 `<all_urls>`、`cookies`、`history`、`tabs` 等首版不需要的权限。

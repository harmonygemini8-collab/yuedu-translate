# 06 接口与数据设计

> 文档编号：API-001 ｜ 版本：v0.1 ｜ 状态：待评审（MVP-A 阶段实施）

## 1. 扩展内部消息协议

| 消息 | 方向 | 说明 |
|---|---|---|
| `GET_STATE` | Popup → Content | 查询当前页面翻译状态 |
| `START` | Popup/背景 → Content | 开始翻译当前页面 |
| `STOP` | Popup/背景 → Content | 停止提交新任务 |
| `RESTORE` | Popup/背景 → Content | 恢复原文 |
| `RETRY_FAILED` | Popup → Content | 重试失败段落 |
| `TRANSLATE_BATCH` | Content → Service Worker | 提交一批段落 |
| `LOOKUP` | Content → Service Worker | 提交一处选中文字与其所在句子，取回译文或词条（FR-15） |
| `STATE_CHANGED` | Content → Popup | 状态广播 |

所有消息在接收端校验来源（`sender.id` 为本扩展）与结构，不信任网页环境。

## 2. 平台 API

### 2.0 开发版已实现接口

| 接口 | 鉴权 | 说明 |
|---|---|---|
| `GET /v1/health` | 无 | 存活检查 |
| `GET /v1/status` | 开发令牌 | 可用服务、本月费用与字符用量（不含正文），仅运维用 |
| `POST /v1/translate` | 会话令牌或开发令牌 | 同步翻译一批段落；用户按套餐与额度校验（`PLAN_REQUIRED` 403、`QUOTA_EXCEEDED` 402 附 `resetAt`） |
| `POST /v1/lookup` | 会话令牌或开发令牌 | 查询一处选中文字的词条（FR-15）。固定走 `openai` 引擎，因此计入 VIP 标准额度，免费账号得到 `PLAN_REQUIRED`，扩展随即降级为普通译文。请求 `{targetLang, text, context}`，上限 600 字符 / 600 字符；响应 `{ok, entry}` |
| `POST /v1/tts` | 会话令牌或开发令牌 | 朗读一小段译文（FR-16）。请求 `{lang, text}`，`text` ≤ 500 字符，`lang` 为目标语言代码；响应是 `audio/mpeg`（24 kHz、48 kbps 单声道 MP3），不是 JSON。内部记作 `azure-tts`：计入「今日免费额度」和平台每月字符上限，不接受 `/v1/translate`。没有 Speech 密钥时返回 503 `NOT_CONFIGURED`，语言无对应声音返回 400，额度用完返回 402 `QUOTA_EXCEEDED`；扩展遇到任何错误都退回浏览器本地语音 |
| `POST /v1/auth/email/start` | 无 | 发送 6 位验证码（付费版 P1） |
| `POST /v1/auth/email/verify` | 无 | 校验验证码，返回会话令牌 |
| `POST /v1/auth/logout` | 会话令牌 | 退出当前会话 |
| `GET /v1/me` | 会话令牌 | 账号、套餐、各额度池用量与重置时间、可用服务 |
| `DELETE /v1/me` | 会话令牌 | 删除账号及其会话与用量记录 |

账号接口、额度规则与数据表的完整设计见 [15 付费版设计](./15-paid-plan-design.md)。`engine` 新增 `openai-premium`（OpenAI 高质量模型）。

请求示例：

```json
{ "engine": "google", "targetLang": "zh-CN", "segments": [{ "id": "y12", "text": "Hello" }] }
```

响应示例：

```json
{ "ok": true, "results": [{ "id": "y12", "ok": true, "text": "你好" }] }
```

- `engine`：`microsoft`（免费档，官方免费额度）、`google`（谷歌官方 API）、`openai`（付费档）；谷歌免费档在浏览器直连，不经过此接口；
- 免费额度用尽（本地字符上限或服务商报告）返回 402 `QUOTA_EXCEEDED`；
- 批量限制与扩展一致（16 段 / 4000 字符 / 单段 2000 字符），由 `src/shared/messages.ts` 的 `isValidSegments` 统一校验；
- 鉴权方式为 `Authorization: Bearer <令牌>`：用户为登录会话令牌（[15 §5](./15-paid-plan-design.md)），运维为 `YILIN_DEV_TOKEN`（不计用户额度，仅用于 `/v1/status` 等接口）；管理后台另有自己的会话与接口，见 [17 §3、§5](./17-admin-console.md)；
- 尚未实现幂等键与异步任务接口（下表），同步接口满足当前批量规模。

### 2.0.1 后续规划接口

| 接口 | 职责 |
|---|---|
| `GET /v1/me` | 当前用户信息 |
| `GET /v1/quota` | 剩余额度与重置时间 |
| `POST /v1/translation-jobs` | 提交一批段落，返回任务结果或任务 ID |
| `GET /v1/translation-jobs/{id}` | 查询状态与逐段结果 |
| `POST /v1/translation-jobs/{id}/cancel` | 取消尚未执行的部分 |

登录方式待身份服务选型（见 DEC-05），不提前固定。

### 2.1 提交任务请求

```json
{
  "targetLang": "zh-CN",
  "sourceLang": "en",
  "segments": [{ "id": "s-12", "text": "..." }],
  "clientRequestId": "uuid",
  "idempotencyKey": "uuid"
}
```

- 不提交网页完整 URL、DOM、Cookie。
- 单批段落数、单段与单批字符数设上限（数值技术验证后确定）。

### 2.2 错误码

| HTTP | code | 含义 |
|---|---|---|
| 400 | `INVALID_REQUEST` | 服务、语言或批量参数不合法（已实现） |
| 401 | `UNAUTHENTICATED` | 未登录或会话失效 |
| 503 | `NOT_CONFIGURED` | 所选服务未配置 API 密钥（已实现） |
| 402 | `QUOTA_EXCEEDED` | 额度不足 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同键不同内容 |
| 413 | `PAYLOAD_TOO_LARGE` | 超出批量限制 |
| 429 | `RATE_LIMITED` | 触发限流 |
| 502/503 | `PROVIDER_UNAVAILABLE` | 供应商故障或熔断 |

## 3. 数据实体

| 实体 | 关键字段 | 用途 |
|---|---|---|
| User | id、状态、创建时间 | 用户 |
| Entitlement | userId、套餐、额度、周期 | 当前可用权益 |
| QuotaLedger | userId、jobId、类型（预留/结算/释放）、数量 | 用户额度账本 |
| TranslationJob | id、userId、幂等键、内容哈希、状态 | 任务与幂等 |
| ProviderUsage | jobId、供应商、计量单位、用量、成本 | 供应商成本账本 |
| Subscription / Order | — | MVP-B 加入 |

## 4. 配额与计费流程

```text
校验身份 → 校验大小与限流 → 原子预留额度
→ 调用供应商 → 按成功段落结算 → 释放未使用预留
```

规则：

1. 幂等键绑定用户与内容哈希；同键同内容返回同一任务，同键不同内容返回 409。
2. 网络超时不等于供应商未执行，成本以供应商用量对账为准。
3. 部分成功按成功段落结算，失败段落释放预留。
4. 系统内部重试产生的成本计入平台成本，不重复扣用户额度。
5. 设置单用户、单请求、平台总预算三级上限，以及供应商熔断开关。
6. 后台定时回收超时任务的未结算预留。

## 5. 数据保留（建议，待 DEC-06 确认）

| 数据 | 保留策略 |
|---|---|
| 源文与译文 | 仅用于处理；短期结果 TTL 候选 ≤ 15 分钟；不作为阅读历史 |
| 幂等与计费记录 | 与正文分离保存，不含正文 |
| 应用日志与监控 | 只记录元数据（长度、耗时、状态码），不含正文 |
| 账务数据 | 按经营地区与支付要求确定 |

删除承诺需覆盖缓存、备份、监控及供应商侧行为，不能只以业务代码删除为准。

## 6. 定价前置测算

```text
单用户毛利 = 订阅收入 − 翻译成本 − 基础设施 − 支付费用 − 退款与支持成本
```

大模型通常按 token 计价，传统翻译按字符计价，测算时需换算统一口径。定价在邀请试用取得真实用量后制定。

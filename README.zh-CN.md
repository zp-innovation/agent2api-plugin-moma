# agent2api-plugin-moma

移动云 MoMA（MobileClaw）作为 [agent2api](https://github.com/zp-innovation/agent2api) / magpie 的提供商插件：**OpenAI 兼容推理 + Token 余额 + 套餐到期**。

> Provider id：`moma`　推理端点：`https://zhenze-huhehaote.cmecloud.cn/v1`　管理端点：`https://zhenze-huhehaote.cmecloud.cn/desktop/manager`

---

## 为什么需要这个插件

移动云 MoMA 在控制台里有两套互不相通的凭据，只填 API Key 的普通「自定义提供商」只能拿到第一套：

| 用途 | 凭据 | 能查余额吗 |
| --- | --- | --- |
| 对话推理（`/v1/chat/completions`） | API Key（控制台 → API Key 管理） | ❌ 这一面**没有任何计费端点** |
| 余额 / 套餐 / 到期（`/desktop/manager/*`） | MobileClaw 客户端登录态（Bearer JWT） | ✅ 只有它能查 |

实测结论（2026-11 复核）：

- `/v1/{usage,balance,quota,billing,dashboard/billing/*}` 全部 404；`chat/completions` 的响应头里也没有任何配额字段。
- 拿 API Key 打 `/desktop/manager/*` 恒 `401 {"errorCode":"UNAUTHORIZED"}` —— 两套凭据不通用。
- `/v1/models` 是**公开**的：不带 `Authorization` 也返回 200 和完整模型目录，所以「能拉到模型」证明不了 API Key 有效。插件因此会真打一次 `/chat/completions`（`max_tokens:1`）来校验 Key。

所以本插件在登录时**同时**收集两样东西：API Key（推理用）+ 手机号与密码/短信验证码（换 MobileClaw 登录态，查余额用）。只填 API Key 也能用，只是余额列会明确写「未绑定 MobileClaw 账号」，而不是假装查过了。

## 安装

面板 → 插件 → 添加脚本插件：

```text
github:zp-innovation/agent2api-plugin-moma
```

或者从本地目录装（路径必须是**网关那台机器**上的绝对路径）：

```text
file:/data/projects/agent2api/data/script-plugins-src/agent2api-plugin-moma
```

## 添加账号

添加账号时会看到 4 个字段，只有第一个是必填的：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| API Key | ✅ | 移动云 MoMA 控制台 → API Key 管理 |
| 手机号 | 选填 | 填了才会去换 MobileClaw 登录态（余额/到期就靠它） |
| MobileClaw 登录密码 | 选填 | 在 MobileClaw 客户端里设置过登录密码才能用 |
| 短信验证码 | 选填 | 没设密码时用：先只填手机号提交一次，收到短信后把 6 位码填进来再提交 |

三种典型用法：

1. **只要推理**：只填 API Key。
2. **手机号 + 密码**（推荐，一次填完）：API Key + 手机号 + 密码。
3. **手机号 + 短信验证码**（没设密码时）：先填 API Key + 手机号提交 → 会提示「验证码已发送到 189****6066」→ 把验证码填进第 4 个字段再提交一次。

> 密码与验证码**不会落库**：`authorize` 会把它们显式置空，账号记录里只留 API Key 与 MobileClaw 的 token 对。

## 界面上会显示什么

**余额**列（分窗口额度）：

- `MobileClaw 体验额度` —— `GET /credits/v2/exp-credit` 的 `remainTokens` / `remainTokens + totalTokens`，单位 Tokens。
- `<套餐名> · MM-DD 到期` —— `GET /subscriptions/token-plans-personal/{provider}` 里每一个已购 Token 套餐，标记为「旁路」（`aside`）：套餐到期不等于当前不可用，不参与网关的额度拦截，避免把正常请求误判成配额耗尽。

**有效期**列：

- 平台给了真实到期时刻（套餐 `expireTime` 或体验额度 `expireTime`）时，写进账号记录的 `expires`，按「N 天后」显示。
- 平台没给（当前账号的 `expireTime` 就是 `null`）时显示「—」。**这是宿主的既定行为**：`account_features.long_lived` 由宿主硬编码为「仅本地提供商」，远端插件无法申报「长期有效」，见 `host/models.mjs:30`。

**模型能力**（模型页 → 模型能力弹窗）：

MoMA 的 `/v1/models` 只返回 `{id, object, created, owned_by}`，**不声明**上下文长度、最大输出、模态、工具调用与思考能力——「透传上游」在上游就没有源头。插件分两层补齐：

1. `caps.mjs`：构建期用 `node scripts/gen-caps.mjs` 把 [models.dev](https://models.dev) 的能力表按归一化 id 投影到 MoMA 的模型上（当前 98 / 141 命中，冲突时取上下文最大且 `output < context` 的来源）；
2. `inferCaps()`：匹配不到时按模型名兜底（`-128k` / `-64k` / `-1M` / `vl` / `r1` …），上下文缺省 32k。

声明字段用宿主 `host/model-records.mjs:33-39` 认的形状：`limit.context` / `limit.output` / `capabilities.toolcall` / `capabilities.reasoning` / `capabilities.input.{image,video,audio,pdf}`，并同时给扁平的 `tool_call` / `reasoning` / `modalities`。面板里不再出现「上游未声明」，也不会默认「不支持」。

复核这张表是否跟得上上游：`node scripts/gen-caps.mjs --check`（需要网络，返回非 0 表示需要重新生成）。

## 已知边界

1. **移动云 MoMA 控制台首页那张「Token 免费额度 25,000.000K / 2026-12-20 到期」读不到。**
   它是 Maas 平台侧发给 API Key 的额度，只存在于 `ecloud.10086.cn` 的 SSO 控制台（需要滑块验证码交互登录），没有任何对外 API；桌面端接口给的是另一套「MobileClaw 体验额度」（36,000,000 Tokens）。插件不会拿后者去冒充前者，窗口名就写「MobileClaw 体验额度」。
2. **API Key 消耗的额度不可观测。** 上面两套额度是分开计费的：实测用 API Key 打 `chat/completions` 前后，桌面端 `exp-credit` 的读数完全不变（delta = 0）。
3. **refresh token 是一次性的。** `POST /auth/refresh` 每次返回新的 `accessToken` + `refreshToken`，旧的立刻失效。插件每次续期都会把新的一对写回账号记录；如果写回失败（例如手动改过账号），需要重新登录绑定。
4. **access token 只有 2 小时。** 宿主对 `type:"api"` 的账号**不会**调用 `hooks.auth.refresh`（`host/accounts.mjs:72` 直接 return），所以续期发生在 `usage()` 里，查询余额时顺手续。
5. 设备指纹（deviceId / hostname / mac）在首次登录时随机生成并随账号落库，续期时原样上报。它不需要是真的，但必须稳定。

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 登录报「API Key 未被移动云 MoMA 接受：401 token expired or incorrect」 | Key 错或已删 | 到控制台重新复制 |
| 登录报「这个手机号在 MobileClaw 里还没设置登录密码」 | 服务端 `C401006` | 在 MobileClaw 客户端设置登录密码，或改用短信验证码 |
| 登录报「手机号或密码不正确」 | `C401007` | 检查手机号/密码 |
| 余额列显示「未绑定 MobileClaw 账号」 | 登录时没填手机号 | 编辑账号重新绑定 |
| 余额列显示「MobileClaw 登录态已失效」 | refresh token 被别处轮换掉了（例如桌面客户端重新登录） | 重新绑定一次 |

调试：网关侧设置 `MOMA_VERBOSE=1` 可看到插件打的 `[moma]` 日志。

## 安全

- 账号记录里只存 API Key + MobileClaw 的 `accessToken` / `refreshToken` / 设备指纹；密码与短信验证码提交后即丢弃。
- 手机号/密码在上行前用 RSA（PKCS#1 v1.5，2048 位）加密，与官方客户端同口径；公钥内联在 `index.mjs`（`RSA_N`），不引入 `node:crypto`，插件零依赖。
- 所有请求只发往 `zhenze-huhehaote.cmecloud.cn`。

## 开发

```bash
node --input-type=module -e "import('./index.mjs').then(m => console.log(Object.keys(m)))"
```

`index.mjs` 导出了 `_internal`（`rsaEncrypt` / `millis` / `jwtExp` / `newDevice` / `sessionOf` / `usageOf` / `planWindows` / `isChatModel` / `contextOf` …）便于单测。

## License

MIT

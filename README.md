# agent2api-plugin-moma

Mobile Cloud (移动云) **MoMA / MobileClaw** as an [agent2api](https://github.com/zp-innovation/agent2api) / magpie provider: **OpenAI-compatible inference + token balance + plan expiry**.

> Provider id: `moma`　Inference: `https://zhenze-huhehaote.cmecloud.cn/v1`　Management: `https://zhenze-huhehaote.cmecloud.cn/desktop/manager`

[中文说明](./README.zh-CN.md)

---

## Why this plugin exists

MoMA hands out two credentials that do not talk to each other. A plain "custom provider" entry — API key only — can use the first one and nothing else:

| Purpose | Credential | Can it read the balance? |
| --- | --- | --- |
| Chat (`/v1/chat/completions`) | API key (console → API Key management) | ❌ that surface has **no billing endpoint at all** |
| Balance / plans / expiry (`/desktop/manager/*`) | MobileClaw desktop sign-in (Bearer JWT) | ✅ only this one can |

Verified 2026-11:

- `/v1/{usage,balance,quota,billing,dashboard/billing/*}` are all 404, and `chat/completions` returns no quota headers.
- An API key against `/desktop/manager/*` is always `401 {"errorCode":"UNAUTHORIZED"}`.
- `/v1/models` is **public** — it answers 200 with the full catalogue even without `Authorization`, so a successful model listing proves nothing about the key. The plugin therefore validates the key with a real `/chat/completions` call (`max_tokens: 1`).

So the login method collects both: the API key for inference, plus a phone number with either a password or an SMS code to obtain a MobileClaw session for the balance. API key alone still works — the balance column then says "未绑定 MobileClaw 账号" instead of pretending it queried something.

## Install

Panel → Plugins → add script plugin:

```text
github:zp-innovation/agent2api-plugin-moma
```

Or from a local directory (absolute path **on the gateway host**):

```text
file:/data/projects/agent2api/data/script-plugins-src/agent2api-plugin-moma
```

## Adding an account

Four fields, only the first is required:

| Field | Required | Notes |
| --- | --- | --- |
| API Key | ✅ | MoMA console → API Key management |
| Phone | optional | Required to obtain the MobileClaw session (balance / expiry) |
| MobileClaw password | optional | Only if a sign-in password was set in the desktop client |
| SMS code | optional | No password? Submit once with only the phone, then paste the 6-digit code and submit again |

> The password and the SMS code are **never persisted**: `authorize` blanks them before the host writes the account record, which keeps only the API key and the MobileClaw token pair.

## What the panel shows

**Balance** (windowed readings), same source as the client's "usage → claim details" dialog:

- `免费额度合计` — `GET /credits/v2/exp-credit`'s `remainTokens` over `remainTokens + totalTokens`, in Tokens. This row **does** take part in the gateway's quota blocking (zero balance → 429).
- `注册礼` / `每月登录礼` / `每日打卡礼` — the per-grant allowances from `POST /token-welfare/balance` (`remainingToken` over `receivedTokenAmount`), each carrying its own `expireTime`. They are marked `aside`: the three grants feed one pool, so any single one hitting zero must not be read as "account exhausted".
- `<plan name> · MM-DD 到期` — one row per purchased token plan from `GET /subscriptions/token-plans-personal/{provider}`, also `aside`.

**Expiry**:

- Taken as the later of "earliest free-grant expiry" and "latest paid-plan expiry", written to the account's `expires` and rendered as "in N days". Currently 2026-12-20 for this account.
- If `token-welfare` is unavailable the plugin falls back to `exp-credit`, whose `expireTime` is literally `null` → the column shows "—". Do not expect "long-lived": `account_features.long_lived` is hard-coded to local providers only (`host/models.mjs:30`), so a remote plugin cannot declare it.

Three-layer fallback: `token-welfare/balance` (details + expiry) → `exp-credit` (one aggregate row, no expiry) → an `empty` message. No single failure paints the whole column red.

**Model capabilities** (Models page → capability dialog):

MoMA's `/v1/models` returns only `{id, object, created, owned_by}` — no context window, no max output, no modalities, no tool-call or reasoning flags. There is nothing upstream to pass through, so the plugin derives it in two layers:

1. `caps.mjs` — generated at build time by `node scripts/gen-caps.mjs`, which projects the [models.dev](https://models.dev) capability table onto MoMA model ids by normalized id (98 of 141 currently match; conflicting sources resolve to the largest context with `output < context`);
2. `inferCaps()` — name-based fallback (`-128k` / `-64k` / `-1M` / `vl` / `r1` …), 32k context by default.

Declarations use the shape the host reads (`host/model-records.mjs:33-39`): `limit.context`, `limit.output`, `capabilities.toolcall`, `capabilities.reasoning`, `capabilities.input.{image,video,audio,pdf}`, plus the flat `tool_call` / `reasoning` / `modalities` aliases.

Check whether the table is still in sync: `node scripts/gen-caps.mjs --check` (needs network; non-zero exit means regeneration is required).

## Known limits

1. **The console's "Token 免费额度 25,000.000K / expires 2026-12-20" card needs no separate scraping.** It is exactly the three grants from `token-welfare/balance` (25,000,000 + 10,000,000 + 1,000,000 = 36,000,000 tokens; their remaining sum, 35,783,468, equals `exp-credit`'s `remainTokens`). No `ecloud.10086.cn` SSO cookie and no slider captcha are involved.
2. **API-key consumption is unobservable.** The two pools bill separately: a `chat/completions` call with an API key leaves the desktop `exp-credit` reading unchanged (delta = 0).
3. **Refresh tokens are single-use.** Each `POST /auth/refresh` returns a new `accessToken` + `refreshToken` and invalidates the old pair. The plugin writes the new pair back to the account record on every renewal.
4. **Access tokens live 2 hours.** The host never calls `hooks.auth.refresh` for `type: "api"` accounts (`host/accounts.mjs:72` returns early), so renewal happens inside `usage()`.
5. The device fingerprint is generated on first login and stored with the account; it need not be real but must stay stable.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "API Key 未被移动云 MoMA 接受：401 token expired or incorrect" | Wrong or deleted key | Re-copy from the console |
| "这个手机号在 MobileClaw 里还没设置登录密码" | server `C401006` | Set a password in the desktop client, or use the SMS code |
| "手机号或密码不正确" | `C401007` | Check phone / password |
| Balance shows "未绑定 MobileClaw 账号" | No phone given at login | Edit the account and bind one |
| Balance shows "MobileClaw 登录态已失效" | The refresh token was rotated elsewhere | Bind again |

Set `MOMA_VERBOSE=1` on the gateway to see `[moma]` logs.

## Security

- Only the API key, the MobileClaw `accessToken` / `refreshToken` and the device fingerprint are stored; password and SMS code are dropped.
- Phone and password are RSA-encrypted (PKCS#1 v1.5, 2048-bit) exactly like the official client. The modulus is inlined in `index.mjs` so the plugin has **zero dependencies** and needs no `node:crypto`.
- Every request goes to `zhenze-huhehaote.cmecloud.cn`.

## License

MIT

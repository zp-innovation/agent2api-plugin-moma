/**
 * 移动云 MoMA / MobileClaw —— agent2api（magpie）脚本插件
 *
 * 这家平台有两套互不相通的凭据，插件同时用上：
 *
 *   ① 推理：OpenAI 兼容面 https://zhenze-huhehaote.cmecloud.cn/v1
 *      用「API Key」鉴权，175 个模型，DashScope 系后端。这一面**没有任何计费端点**
 *      （/v1/{usage,balance,quota,dashboard/billing/*} 全 404，chat/completions 的响应头
 *      里也没有配额信息）。
 *      注意 /v1/models 是公开的：不带 Authorization 也回 200 全量目录，所以它
 *      不能用来校验 API Key —— 验 key 必须真打一次 /chat/completions（见 validateKey）。
 *
 *   ② 余额：桌面客户端面 https://zhenze-huhehaote.cmecloud.cn/desktop/manager
 *      用 MobileClaw 的登录态（Bearer，JWT，2 小时）鉴权。GET /credits/v2/exp-credit
 *      给出 {expireTime, remainTokens, totalTokens}，/subscriptions/token-plans-personal
 *      给出已购 Token 套餐的到期时刻。**API Key 打这一面恒 401**，两套凭据不通用。
 *
 * 所以「余额 / 有效期」能不能显示，取决于登录时有没有一起绑定 MobileClaw 账号
 * （手机号 + 密码，或手机号 + 短信验证码）。没绑定时余额列会明确写「未绑定」，
 * 而不是假装查过了。
 *
 * 另：移动云 MoMA 控制台首页那张「Token 免费额度 25,000K / 2026-12-20 到期」是
 * Maas 平台侧的额度，只存在于 ecloud.10086.cn 的 SSO 控制台里，**没有对外 API**
 * （见 README「已知边界」），插件读不到，也不会拿桌面端的额度去冒充它。
 */

import { ICON } from "./icon.mjs";
import { CAPS } from "./caps.mjs";

const ID = "moma";
const HOST = "https://zhenze-huhehaote.cmecloud.cn";
const API = HOST + "/v1";
const MGMT = HOST + "/desktop/manager";
const CHAT = "@ai-sdk/openai-compatible";
const CLIENT_VERSION = "1.9.8";
const SERVICE_VERSION = "2.2.1";
const UA = "MobileClaw/" + CLIENT_VERSION;
const FALLBACK_PROVIDER = "CIDC-RP-48";
const FELL_BACK = Symbol.for("magpie.fellBack");
const VERBOSE = process.env.MOMA_VERBOSE === "1";
const log = (...a) => { if (VERBOSE) console.log("[moma]", ...a); };

/* ─── RSA（手机号 / 密码在客户端侧就是 RSA 加密后上行的）────────────────────
 *
 * 移动云桌面端把 phoneEnc / passwordEnc 做成 RSAES-PKCS1-v1_5 密文再 POST，
 * 明文上去只会得到「手机号不能为空」。公钥（SPKI，2048 位）来自客户端 asar。
 *
 * 这里不 import node:crypto：脚本插件在宿主的 Node 里跑，能拿到全局
 * crypto.getRandomValues，但**不能保证**能 import 内置模块（宿主未来可能收紧），
 * 所以把模数/指数直接内联，用 BigInt 做 PKCS#1 v1.5 填充 + 模幂，纯 JS、零依赖。
 */
const RSA_N = 0xbaaedbf20d6e867462b56cea831e0fb2e5ec0e926a835ee29a5cfbbd3a10200ce25fd21c725584d2c197890cec093287af8cc501273a18842c2608e987d9fb8c1cc286606e976f8a8486d7cf1cce0bfa21519597abb935382f8a8f78c3f15e8b5f08b7584d3e954e6af002771431975f82fb89bbe886e89cfc57de0c1809e816860abec09f3c428fb06353fe5d8b54e1852668c554740b5e987ab9396f0a39a1d9872a2bb98e08da4faee82538cb1676fb31788c281fbc94d4f4d7a6dc98e704ec1182c5c51240035c2543dfb5576e71d964e6a3780f4675adcc5bfacebd3bec1ca6b164974880b44fafbfcb055ff074888ce907d31a93e902fac6e3b98b9703n;
const RSA_E = 0x10001n;
const RSA_BYTES = 256;

function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function bytesToBigInt(bytes) {
  let out = 0n;
  for (const byte of bytes) out = (out << 8n) | BigInt(byte);
  return out;
}

function bigIntToBytes(value, length) {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** RSAES-PKCS1-v1_5 加密，返回 base64（与客户端 Zs.encrypt 同口径） */
export function rsaEncrypt(plain) {
  const message = new TextEncoder().encode(String(plain));
  const padLength = RSA_BYTES - 3 - message.length;
  if (padLength < 8) throw new Error("RSA 明文过长");
  const em = new Uint8Array(RSA_BYTES);
  em[0] = 0x00;
  em[1] = 0x02;
  const random = new Uint8Array(padLength);
  crypto.getRandomValues(random);
  for (let i = 0; i < padLength; i += 1) em[2 + i] = (random[i] % 255) + 1; // 非零填充
  em[2 + padLength] = 0x00;
  em.set(message, 3 + padLength);
  const cipher = modPow(bytesToBigInt(em), RSA_E, RSA_N);
  return Buffer.from(bigIntToBytes(cipher, RSA_BYTES)).toString("base64");
}

/* ─── 时间 ──────────────────────────────────────────────────────────────────
 *
 * 平台给的时间有两种：JWT 里的秒级 exp，和接口里的「不带时区的北京时间串」
 * （"2026-11-20 16:04:59" / "2026-12-20T00:00:00"）。后者直接 Date.parse 会按
 * 进程本地时区解释 —— 网关跑在容器里是 UTC，到期日会整整差 8 小时。所以显式补
 * +08:00，结果与用户看到的北京时间一致，且不依赖进程 TZ。
 */
const CN_OFFSET = 8 * 60 * 60 * 1000;
const NAIVE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

export function millis(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 && value <= 8.64e15 ? value : 0;
  if (typeof value !== "string") return 0;
  const raw = value.trim();
  if (!raw) return 0;
  const at = Date.parse(NAIVE.test(raw) ? raw.replace(" ", "T") + "+08:00" : raw);
  return Number.isFinite(at) && at > 0 && at <= 8.64e15 ? at : 0;
}

/** 北京时间的 MM-DD，用于把到期日写进窗口名（网关的 label 只取 row.name） */
function monthDay(at) {
  if (!at) return "";
  const d = new Date(at + CN_OFFSET);
  return String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}

function jwtExp(token) {
  const part = String(token ?? "").split(".")[1];
  if (!part) return 0;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    const exp = Number(claims?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/* ─── HTTP ──────────────────────────────────────────────────────────────── */

async function json(res) {
  const body = await res.text();
  if (!body) return null;
  try { return JSON.parse(body); } catch { return { __text: body }; }
}

async function openai(key, path, { signal } = {}) {
  const res = await fetch(API + path, {
    headers: { authorization: "Bearer " + key, accept: "application/json" },
    signal,
  });
  const body = await json(res);
  if (!res.ok) {
    const err = new Error(body?.error?.message || body?.message || "HTTP " + res.status);
    err.status = res.status;
    err.code = body?.error?.code;
    throw err;
  }
  return body;
}

async function mgmt(path, { method = "GET", body, token, signal } = {}) {
  const res = await fetch(MGMT + path, {
    method,
    headers: {
      "user-agent": UA,
      "service-version": SERVICE_VERSION,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const payload = await json(res);
  if (!res.ok) {
    const err = new Error(payload?.errorMessage || "HTTP " + res.status);
    err.status = res.status;
    err.code = payload?.errorCode;
    throw err;
  }
  return payload;
}

/* ─── 设备指纹 ──────────────────────────────────────────────────────────────
 *
 * /auth/* 全部要求 deviceId / hostname / mac / clientVersion / os 五个字段
 * （缺一个就是 C400999「设备 Id 不能为空」）。服务端只校验「有没有、格式对不对」，
 * 不校验真伪 —— 实测用合成指纹能走到「手机号格式不正确」这一步。
 *
 * 指纹在首次登录时生成一次并随账号落库：refresh 时会一并上报，换掉可能被判定
 * 异地登录，所以它必须稳定。
 */
export function newDevice() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const macBytes = new Uint8Array(6);
  crypto.getRandomValues(macBytes);
  return {
    deviceId: hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32),
    hostname: "agent2api-gateway",
    mac: [...macBytes].map((b) => b.toString(16).padStart(2, "0")).join(":"),
    clientVersion: CLIENT_VERSION,
    os: "10.0.26100",
  };
}

/*
 * mc 在账号记录里的位置取决于写入路径：
 *  - authorize 返回的 metadata 会被宿主整包塞进 secret，所以登录时拿到的是 auth.metadata.mc
 *    （host/auth-record.mjs:29 secret 就是 authorize 返回对象的浅拷贝，不会摊平 metadata）；
 *  - 插件续期后调 client.auth.set({ mc }) 写的是顶层 auth.mc。
 * 两个位置都要读，否则老账号永远被当成「未绑定」。
 */
function mcOf(auth) {
  return auth?.mc ?? auth?.metadata?.mc ?? null;
}

function deviceOf(auth) {
  const d = mcOf(auth)?.device;
  if (d?.deviceId) return { ...d };
  return newDevice();
}

function maskPhone(phone) {
  const s = String(phone ?? "");
  return s.length === 11 ? s.slice(0, 3) + "****" + s.slice(7) : s;
}

function normalizePhone(value) {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  return digits.length === 11 ? digits : "";
}

/* ─── MobileClaw 登录态 ─────────────────────────────────────────────────── */

function sessionOf(payload, device, phone) {
  const access = payload?.accessToken ?? "";
  const refresh = payload?.refreshToken ?? "";
  if (!access && !refresh) return null;
  const provider = typeof payload?.aiProvider === "object" ? payload.aiProvider?.provider : payload?.aiProvider;
  return {
    access,
    refresh,
    expiresAt: millis(payload?.expiresAt) || jwtExp(access),
    userId: payload?.userSubject?.userId || payload?.userId || "",
    userName: payload?.userSubject?.username || payload?.username || "",
    phoneMask: payload?.phoneMask || maskPhone(phone),
    provider: provider || "",
    device,
  };
}

/** 密码 / 短信验证码两种登录；只给了手机号时先发一条验证码，返回 null。 */
async function loginMobileClaw(inputs, device, signal) {
  const phone = normalizePhone(inputs?.phone);
  if (!phone) return null;
  const phoneEnc = rsaEncrypt(phone);
  const password = String(inputs?.password ?? "");
  const code = String(inputs?.code ?? "").trim();

  if (password) {
    const payload = await mgmt("/auth/password/login", {
      method: "POST",
      body: { ...device, phoneEnc, passwordEnc: rsaEncrypt(password) },
      signal,
    });
    return sessionOf(payload, device, phone);
  }
  if (code) {
    const payload = await mgmt("/auth/login", {
      method: "POST",
      body: { ...device, phoneEnc, captcha: code },
      signal,
    });
    return sessionOf(payload, device, phone);
  }
  await mgmt("/auth/captcha", { method: "POST", body: { ...device, phoneEnc, purpose: "login" }, signal });
  return null;
}

/**
 * 拿一个可用的 access token。
 *
 * access 是 2 小时 JWT，refresh 是无 exp 的长期 JWT。**宿主不会替我们续期** ——
 * accounts.mjs:72 对 type!=="oauth" 的账号直接 return，所以续期只能发生在这里，
 * 并且要顺手把新的一对 token 写回账号记录，否则下一次查询又用旧的。
 */
async function accessToken(auth, sync, signal) {
  const mc = mcOf(auth);
  if (!mc) return "";
  const exp = jwtExp(mc.access);
  if (mc.access && (!exp || exp - Date.now() > 5 * 60 * 1000)) return mc.access;
  if (!mc.refresh) return mc.access || "";

  const payload = await mgmt("/auth/refresh", {
    method: "POST",
    token: mc.refresh,
    signal,
    body: {
      ...deviceOf(auth),
      userId: mc.userId || "",
      ...(mc.provider ? { aiProvider: mc.provider } : {}),
    },
  });
  const next = sessionOf(payload, deviceOf(auth), "") ?? {};
  const merged = {
    ...mc,
    access: next.access || mc.access,
    refresh: next.refresh || mc.refresh,
    expiresAt: next.expiresAt || mc.expiresAt,
    userId: next.userId || mc.userId,
    userName: next.userName || mc.userName,
    provider: next.provider || mc.provider,
  };
  log("已续期 MobileClaw 登录态");
  await sync?.({ mc: merged });
  return merged.access;
}

/* ─── 模型目录 ──────────────────────────────────────────────────────────────
 *
 * /v1/models 给 175 条，其中一半不是 chat（embedding / rerank / ASR / TTS /
 * 生图 / 生视频 / 实时语音）。把它们当 chat 模型暴露出去，客户端选中就会 4xx，
 * 所以这里按名字分类，只留能走 /chat/completions 的。
 */
const NON_CHAT = /embedding|bge-|rerank|asr|cosyvoice|sensevoice|(^|[-_/])tts([-_/]|$)|qwen-image|flux|wan2|seedance|happyhorse|video-detection|kitchen|guard|live-?translate|realtime/i;
const VISION = /vl|omni|vision|qwen2-vl|qwen3-vl/i;
const REASONING = /(^|[-_/])r1([-_/]|$)|qwq|deepseek-v4-pro|reason|thinking/i;

export function isChatModel(id) {
  const name = String(id ?? "");
  if (!name) return false;
  if (NON_CHAT.test(name)) return false;
  return true;
}

export function contextOf(id) {
  const name = String(id ?? "");
  const millions = /(\d+(?:\.\d+)?)\s*m(?:$|[-_])/i.exec(name);
  if (millions) return Math.round(Number(millions[1]) * 1_000_000);
  const thousands = /(\d+)\s*k(?:$|[-_])/i.exec(name);
  if (thousands) return Number(thousands[1]) * 1024;
  return 0;
}

/* 模型能力：MoMA 的 /v1/models 只有 {id, object, created, owned_by}，
 * 上下文 / 模态 / 工具 / 思考一律不声明。宿主 model-records.mjs:33-39 读的是
 * model.limit.context|output 与 model.capabilities.{toolcall,reasoning,input.*}，
 * 不填就等于「上游未声明」。所以这里分两层给：
 *   ① CAPS[id]（caps.mjs，构建期由 models.dev 归一化匹配生成）——精确值；
 *   ② inferCaps(id) 按名字兜底（-128k / -64k / -1M / vl / r1 …）。
 * 两者都没有时才退回 32k / 8k 这种保守默认，宁可小也不虚报。 */
export function inferCaps(id) {
  const name = String(id ?? "");
  const known = CAPS[id];
  if (known) {
    return { context: known.context, output: known.output, tool: known.tool !== false,
      reasoning: known.reasoning === true, vision: known.vision === true, video: known.video === true,
      audio: known.audio === true, pdf: known.pdf === true, source: "catalog" };
  }
  let context = 0;
  const millions = /(?:^|[-_/])(\d+(?:\.\d+)?)m(?:$|[-_/])/i.exec(name);
  if (millions) context = Math.round(Number(millions[1]) * 1_000_000);
  if (!context) {
    const thousands = /(?:^|[-_/])(\d{1,3})k(?:$|[-_/])/i.exec(name);
    if (thousands) context = Number(thousands[1]) * 1024;
  }
  if (!context) context = 32768;
  return { context, output: Math.min(context, 16384), tool: true,
    reasoning: REASONING.test(name), vision: VISION.test(name), video: false, audio: false, pdf: false,
    source: "inferred" };
}

// /v1/models 拉不到时的兜底清单：只放平台上一线在售的对话模型。
const FALLBACK = [
  "deepseek-v4.1-flash-1017",
  "deepseek-v4.1-flash",
  "qwen/qwen4-max",
  "qwen/qwen3.8-max",
  "qwen/qwen3.7-max",
  "qwen/qwen3.5-plus",
  "glm-5.3",
  "glm-5.3-flash",
  "kimi/kimi-k3.1-pro",
  "minimax/minimax-m3.1-flash",
  "deepseek-r1-128k",
];

export function modelMeta(id) {
  const caps = inferCaps(id);
  return {
    id,
    name: id,
    context: caps.context,
    output: caps.output,
    tool: caps.tool,
    vision: caps.vision,
    video: caps.video,
    audio: caps.audio,
    pdf: caps.pdf,
    reasoning: caps.reasoning,
    source: caps.source,
  };
}

const inputModalities = (meta) => {
  const list = ["text"];
  if (meta.vision) list.push("image");
  if (meta.video) list.push("video");
  if (meta.audio) list.push("audio");
  if (meta.pdf) list.push("pdf");
  return list;
};

function capabilitiesOf(meta) {
  return {
    temperature: true,
    toolcall: meta.tool,
    reasoning: meta.reasoning,
    attachment: meta.vision,
    input: { text: true, image: meta.vision, audio: meta.audio, video: meta.video, pdf: meta.pdf },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  };
}

function configModel(meta) {
  return {
    name: meta.name,
    limit: { context: meta.context, output: meta.output },
    tool_call: meta.tool,
    reasoning: meta.reasoning,
    modalities: { input: inputModalities(meta), output: ["text"] },
    capabilities: capabilitiesOf(meta),
  };
}

function runtimeModel(meta) {
  return {
    id: meta.id,
    providerID: ID,
    name: meta.name,
    api: { id: meta.id, url: API, npm: CHAT },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: meta.context, output: meta.output },
    tool_call: meta.tool,
    reasoning: meta.reasoning,
    modalities: { input: inputModalities(meta), output: ["text"] },
    capabilities: capabilitiesOf(meta),
    release_date: "",
  };
}

/* ─── API Key 校验 ──────────────────────────────────────────────────────────
 *
 * /v1/models 不带鉴权也返回 200（公开目录），所以「拉得到模型列表」证明不了 key 有效。
 * 唯一能验的口子是 /chat/completions：
 *   有效          → 200
 *   key 错/过期   → 401 {"error":{"code":"401","message":"token expired or incorrect"}}
 *   没带 header   → 401 {"error":{"code":"1001","message":"Authentication parameter not received in Header…"}}
 *   额度/套餐问题 → 402 等（key 是好的，只是这个模型跑不了）→ 不算失败
 * 用 max_tokens:1 + 单字 prompt 探一次，成本可忽略。
 */
const PROBE_MODEL = "deepseek-v4.1-flash-1017";

async function validateKey(key, signal) {
  const res = await fetch(API + "/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      model: PROBE_MODEL,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    }),
    signal,
  });
  if (res.ok) return { ok: true };
  const body = await json(res);
  const code = String(body?.error?.code ?? res.status);
  const message = String(body?.error?.message ?? "") || "HTTP " + res.status;
  if (res.status === 401 || res.status === 403 || code === "401" || code === "1001") {
    return { ok: false, code, message };
  }
  // 402（无可用套餐）、429、5xx：key 本身没问题，不拦登录
  return { ok: true, warn: code + " " + message };
}

let catalog = { at: 0, key: "", ids: [] };

async function modelIds(key, signal) {
  if (catalog.ids.length && catalog.key === key && Date.now() - catalog.at < 10 * 60 * 1000) return catalog.ids;
  const body = await openai(key, "/models", { signal });
  const ids = (Array.isArray(body?.data) ? body.data : [])
    .map((m) => (typeof m === "string" ? m : m?.id))
    .filter((id) => typeof id === "string" && id)
    .filter(isChatModel);
  if (ids.length) catalog = { at: Date.now(), key, ids };
  return ids;
}

/* ─── 余额 / 有效期 ─────────────────────────────────────────────────────── */

function planWindows(plans, group) {
  const rows = [];
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (!plan || typeof plan !== "object") continue;
    const total = Number(plan.totalTokens);
    const used = Number(plan.usedTokens);
    const expiresAt = millis(plan.expireTime);
    const label = String(plan.planName || plan.planType || "套餐").trim() || "套餐";
    const day = monthDay(expiresAt);
    rows.push({
      name: day ? label + " · " + day + " 到期" : label,
      group,
      limit: Number.isFinite(total) && total > 0 ? total : undefined,
      balance: Number.isFinite(total) && Number.isFinite(used) ? Math.max(0, total - used) : undefined,
      used: Number.isFinite(total) && total > 0 && Number.isFinite(used) ? Math.max(0, Math.min(100, (used / total) * 100)) : undefined,
      unit: "Tokens",
      // aside：逐套餐的到期不等于「现在就不能用」，参与拦截会把正常请求误判成配额耗尽
      aside: true,
      resetsAt: expiresAt || undefined,
    });
  }
  return rows;
}

export function usageOf(credit, plans) {
  const windows = [];
  let expiresAt = 0;
  const remain = Number(credit?.remainTokens);
  const used = Number(credit?.totalTokens);
  if (Number.isFinite(remain)) {
    const limit = Number.isFinite(used) ? remain + used : undefined;
    windows.push({
      name: "MobileClaw 体验额度",
      group: "额度",
      limit,
      balance: remain,
      used: limit ? Math.max(0, Math.min(100, (used / limit) * 100)) : undefined,
      unit: "Tokens",
      resetsAt: millis(credit?.expireTime) || undefined,
    });
  }
  expiresAt = millis(credit?.expireTime);
  for (const row of planWindows(plans, "套餐")) {
    windows.push(row);
    if (row.resetsAt && row.resetsAt > expiresAt) expiresAt = row.resetsAt;
  }
  return { windows, expiresAt };
}

async function usage(getAuth, sync) {
  const auth = await getAuth();
  if (auth?.type !== "api" || !auth.key) return { signIn: "expired", error: "moma：未登录" };
  const mc = mcOf(auth);
  if (!mc?.refresh && !mc?.access) {
    // 没绑 MobileClaw 账号：余额不是「查失败」，是「没配」。用 empty 通道说清楚，
    // 而不是抛错把整列染红。
    return { empty: true, emptyText: "未绑定 MobileClaw 账号：编辑账号填手机号 + 验证码即可查余额" };
  }

  let token;
  try {
    token = await accessToken(auth, sync);
  } catch (e) {
    if (e?.status === 401 || e?.status === 403) {
      return { signIn: "expired", error: "MobileClaw 登录态已失效（" + (e.code || e.status) + "），请重新登录并绑定手机号" };
    }
    return { error: "续期 MobileClaw 登录态失败：" + e.message };
  }
  if (!token) return { signIn: "expired", error: "MobileClaw 登录态缺失，请重新登录" };

  const provider = mc?.provider || FALLBACK_PROVIDER;
  const credit = await mgmt("/credits/v2/exp-credit", { token }).catch((e) => {
    log("exp-credit 失败", e.message);
    return null;
  });
  let plans = [];
  try {
    const list = await mgmt("/subscriptions/token-plans-personal/" + encodeURIComponent(provider), { token });
    if (Array.isArray(list)) plans = list;
  } catch (e) {
    log("token-plans 失败", e.message);
  }

  const report = usageOf(credit, plans);
  if (!report.windows.length) {
    return { empty: true, emptyText: "平台未返回额度读数" };
  }
  const who = mc?.userName || mc?.phoneMask || "";
  await sync?.(report.expiresAt ? { expiresAt: report.expiresAt, expires: report.expiresAt } : {});
  return { ...report, ...(who ? { user: who } : {}) };
}

/* ─── 登录 ──────────────────────────────────────────────────────────────── */

export async function authorize(inputs, { signal } = {}) {
  const key = String(inputs?.key ?? "").trim();
  if (!key) return { type: "failed", error: "请填写移动云 MoMA 的 API Key" };

  // 1) 先验 API Key：这是推理要用的凭据，验不过就没必要再谈余额
  let probe = { ok: true };
  try {
    probe = await validateKey(key, signal);
  } catch (e) {
    // 网络抖动不判死：先存凭据，真出错在对话时会暴露
    log("登录期校验 API Key 失败（网络）", e.message);
  }
  if (!probe.ok) {
    return { type: "failed", error: "API Key 未被移动云 MoMA 接受：" + probe.code + " " + probe.message };
  }
  if (probe.warn) log("API Key 有效但探针返回 " + probe.warn);

  // 目录是公开的，顺手记一下规模（失败不影响登录）
  let ids = [];
  try {
    ids = await modelIds(key, signal);
  } catch (e) {
    log("登录期拉模型目录失败", e.message);
  }

  // 2) 可选：绑定 MobileClaw 账号，用于余额与有效期
  const metadata = {};
  const phone = normalizePhone(inputs?.phone);
  if (phone) {
    const device = newDevice();
    let session = null;
    try {
      session = await loginMobileClaw(inputs, device, signal);
    } catch (e) {
      const code = String(e?.code ?? "");
      if (code === "C401006") {
        return { type: "failed", error: "这个手机号在 MobileClaw 里还没设置登录密码：请在客户端里设置密码，或只填手机号、提交一次拿到短信验证码后再填验证码提交" };
      }
      if (code === "C401007") return { type: "failed", error: "手机号或密码不正确" };
      if (e?.status === 401 || e?.status === 403) return { type: "failed", error: "MobileClaw 登录被拒绝：" + (code || "") + " " + e.message };
      return { type: "failed", error: "MobileClaw 登录失败：" + e.message };
    }
    if (!session) {
      return {
        type: "failed",
        error: "验证码已发送到 " + maskPhone(phone) + "：请在「短信验证码」里填入后重新提交（其余字段不用改）",
      };
    }
    metadata.mc = session;
  }

  // 3) 敏感字段不落库：宿主会把 inputs 合并进 secret（provider.mjs:150），
  //    显式置 undefined 才能盖掉它们。
  metadata.password = undefined;
  metadata.code = undefined;
  metadata.phone = phone || undefined;
  metadata.modelCount = ids.length || undefined;

  const who = metadata.mc?.userName || "";
  return {
    type: "success",
    key,
    ...(who ? { name: who } : {}),
    ...(metadata.mc?.userId ? { uid: metadata.mc.userId } : {}),
    metadata,
  };
}

/* ─── 插件本体 ──────────────────────────────────────────────────────────── */

export async function MomaPlugin({ client } = {}) {
  // 把新读数写回账号记录。id 必须用 originalID：宿主分配出的 id 可能带 -plugin 后缀。
  const sync = async (patch) => {
    if (!client?.auth?.set) return;
    const entries = Object.entries(patch ?? {}).filter(([, v]) => v !== undefined && v !== null);
    if (!entries.length) return;
    try {
      const current = (await client.auth.get({}))?.data;
      if (!current?.key) return;
      const body = { ...current };
      let changed = false;
      for (const [k, v] of entries) {
        if (JSON.stringify(body[k]) === JSON.stringify(v)) continue;
        body[k] = v;
        changed = true;
      }
      if (!changed) return;
      await client.auth.set({ id: ID, body });
    } catch (e) {
      log("写回账号信息失败：", e.message);
    }
  };

  return {
    auth: {
      provider: ID,
      icon: ICON,
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api" || !auth.key) return {};
        return {
          baseURL: API,
          apiKey: auth.key,
          headers: {},
        };
      },
      usage: (getAuth) => usage(getAuth, sync),
      methods: [
        {
          type: "api",
          label: "API Key（移动云 MoMA → API Key 管理）",
          // 手机号这一组是可选的：只填 API Key 也能用（只是余额列会写「未绑定」）
          prompts: [
            { key: "key", label: "API Key", placeholder: "移动云 MoMA 控制台 → API Key 管理", secret: true },
            { key: "phone", label: "手机号（选填，绑定后能查余额）", placeholder: "18928906066", optional: true },
            { key: "password", label: "MobileClaw 登录密码（选填）", placeholder: "客户端里设置的登录密码", secret: true, optional: true },
            { key: "code", label: "短信验证码（选填）", placeholder: "没设密码时：先提交一次，再把收到的验证码填这里", optional: true },
          ],
          authorize,
        },
      ],
    },

    async config(config) {
      config.provider ??= {};
      const was = config.provider[ID] ?? {};
      config.provider[ID] = {
        name: "移动云 MoMA（MobileClaw）",
        npm: CHAT,
        api: API,
        ...was,
        models: {
          ...Object.fromEntries(FALLBACK.map((id) => [id, configModel(modelMeta(id))])),
          ...(was.models ?? {}),
        },
      };
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const fallback = () => {
          const out = Object.fromEntries(FALLBACK.map((id) => [id, runtimeModel(modelMeta(id))]));
          out[FELL_BACK] = true;
          return out;
        };
        if (auth?.type !== "api" || !auth.key) return fallback();
        try {
          const ids = await modelIds(auth.key);
          if (!ids.length) return fallback();
          return Object.fromEntries(ids.map((id) => [id, runtimeModel(modelMeta(id))]));
        } catch (e) {
          log("拉模型目录失败，用兜底清单：", e.message);
          return fallback();
        }
      },
    },
  };
}

export const _internal = {
  ID, API, MGMT, CHAT, FALLBACK_PROVIDER,
  rsaEncrypt, millis, jwtExp, newDevice, deviceOf, maskPhone, normalizePhone,
  isChatModel, contextOf, modelMeta, usageOf, planWindows, sessionOf,
};

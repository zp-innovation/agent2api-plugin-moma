#!/usr/bin/env node
/**
 * 生成 caps.mjs：把 models.dev 的模型能力表投影到移动云 MoMA 的模型 id 上。
 *
 * 用法：node scripts/gen-caps.mjs [--check]
 *   --check 只比对，不写文件（CI/本地核对用）
 *
 * 口径：
 *   1. 拉 https://models.dev/api.json；
 *   2. 把模型 id 归一化（小写、去掉非字母数字与点），建全局索引；
 *   3. 对 MoMA /v1/models 的每个 chat 模型 id 先按全名匹配，再按去掉厂商前缀的名字匹配；
 *   4. 同一 id 命中多个来源时取 limit.context 最大的那条（其次是 output）；
 *   5. 匹配不到的不写进表，由 index.mjs 的 inferCaps() 按名字兜底。
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const API = "https://zhenze-huhehaote.cmecloud.cn/v1/models";
const DEV = "https://models.dev/api.json";
const NON_CHAT = /embedding|bge-|rerank|asr|cosyvoice|sensevoice|(^|[-_/])tts([-_/]|$)|qwen-image|flux|wan2|seedance|happyhorse|video-detection|kitchen|guard|live-?translate|realtime/i;
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9.]/g, "");

async function json(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(url + " -> HTTP " + res.status);
  return res.json();
}

const [catalog, dev] = await Promise.all([json(API), json(DEV)]);
const ids = (catalog.data || []).map((m) => m.id).filter((id) => id && !NON_CHAT.test(id));

const index = new Map();
for (const [pid, provider] of Object.entries(dev)) {
  for (const [mid, model] of Object.entries(provider.models || {})) {
    const key = norm(mid);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ pid, mid, model });
  }
}

const table = {};
for (const id of ids) {
  const bare = id.includes("/") ? id.split("/").slice(1).join("/") : id;
  const hits = (index.get(norm(id)) || index.get(norm(bare)) || []).filter((hit) => (hit.model.limit?.context || 0) > 0);
  if (!hits.length) continue;
  // 同一 id 在 models.dev 里常有多个来源（opencode / vercel / 厂商官方），数值打架。
  // 先剔除 output >= context 的明显脏数据，再取上下文最大的那条。
  const sane = hits.filter((hit) => { const out = hit.model.limit?.output || 0; return out > 0 && out < hit.model.limit.context; });
  const best = (sane.length ? sane : hits).sort((a, b) =>
    ((b.model.limit.context || 0) - (a.model.limit.context || 0))
    || ((b.model.limit?.output || 0) - (a.model.limit?.output || 0)))[0].model;
  const input = best.modalities?.input || ["text"];
  let output = best.limit?.output || 0;
  if (!output || output >= best.limit.context) output = Math.min(best.limit.context, 65536);
  table[id] = {
    context: best.limit.context,
    output,
    tool: best.tool_call !== false,
    reasoning: best.reasoning === true,
    vision: input.includes("image"),
    video: input.includes("video"),
    audio: input.includes("audio"),
    pdf: input.includes("pdf"),
  };
}

const rows = Object.keys(table).sort().map((id) => {
  const c = table[id];
  const flags = ["tool: " + c.tool];
  for (const key of ["reasoning", "vision", "video", "audio", "pdf"]) if (c[key]) flags.push(key + ": true");
  return "  " + JSON.stringify(id) + ": { context: " + c.context + ", output: " + c.output + ", " + flags.join(", ") + " },";
}).join("\n");

const text = `/* 移动云 MoMA 模型能力表（构建期从 models.dev 归一化 id 匹配生成）
 *
 * 为什么需要这张表：MoMA 的 /v1/models 只返回 {id, object, created, owned_by}，
 * 不含上下文长度、模态、工具调用、思考能力。宿主（model-records.mjs:33-39）读的是
 * model.limit.context/output 与 model.capabilities.{toolcall,reasoning,input.*}，
 * 不声明就等于「上游未声明」，面板的「模型能力」里全是「继承上游: 不支持」。
 *
 * 生成口径：取 models.dev 里同名（去大小写与分隔符后一致）的条目，
 * 多个来源冲突时取上下文最大的那个；匹配不到的 id 由 index.mjs 的 inferCaps() 按名字兜底。
 * 重新生成：node scripts/gen-caps.mjs（需要网络）。
 */
export const CAPS = {
${rows}
};
`;

if (process.argv.includes("--check")) {
  const here = dirname(fileURLToPath(import.meta.url));
  const current = await import(new URL("../caps.mjs", import.meta.url).href);
  const same = JSON.stringify(current.CAPS) === JSON.stringify(table);
  console.log(same ? "caps.mjs 与上游一致（" + Object.keys(table).length + " 条）" : "caps.mjs 需要重新生成");
  process.exit(same ? 0 : 1);
}

const here = dirname(fileURLToPath(import.meta.url));
await writeFile(join(here, "..", "caps.mjs"), text);
console.log("caps.mjs 已更新：" + Object.keys(table).length + " 条");

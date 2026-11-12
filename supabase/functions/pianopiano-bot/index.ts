// Langtiamo — Telegram-бот: вебхук команд, синхронизация статистики из Mini App и ежедневные напоминания.
// Маршруты (один URL функции):
//   POST /                — вебхук Telegram (проверка секретного заголовка)
//   POST ?a=sync          — Mini App присылает статистику (проверка initData подписью бота)
//   POST ?a=cron          — почасовой запуск напоминаний из pg_cron (проверка секрета из pp_config)
//   GET/POST ?a=setup     — регистрирует вебхук, команды и кнопку меню (идемпотентно)
//   POST ?a=login_start / ?a=login_poll — вход на сайт через бота (одноразовый код + подтверждение в Telegram)
//   POST ?a=load / ?a=save — общий прогресс для Mini App и сайта (initData или токен сессии)
//   POST ?a=tr            — перевод IT↔RU (MyMemory) с кэшем в pp_tr
//   POST ?a=check         — проверка итальянского текста (LanguageTool)
// Команда /site в боте присылает ссылку на сайт с токеном входа (#login=…).
import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("PP_BOT_TOKEN") ?? "";
// адрес сайта задан в коде: после переименования в Langtiamo старое значение PP_APP_URL не должно мешать
const APP_URL = "https://yerassyl-alimkul.github.io/langtiamo/";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const API = `https://api.telegram.org/bot${TOKEN}`;
const SELF_URL = `${SB_URL}/functions/v1/pianopiano-bot`;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const enc = new TextEncoder();

const PHRASES: [string, string][] = [
  ["Posso pagare con la carta?", "Можно оплатить картой?"],
  ["Il conto, per favore.", "Счёт, пожалуйста."],
  ["Non ho capito.", "Я не понял."],
  ["Può ripetere, per favore?", "Можете повторить, пожалуйста?"],
  ["Quanto costa?", "Сколько стоит?"],
  ["Dov'è la fermata dell'autobus?", "Где автобусная остановка?"],
  ["Vorrei un caffè, per favore.", "Я бы хотел кофе, пожалуйста."],
  ["Più piano, per favore.", "Помедленнее, пожалуйста."],
  ["Mi trovo bene a Messina.", "Мне хорошо в Мессине."],
  ["Ci vediamo domani!", "Увидимся завтра!"],
  ["A che ora parte il treno?", "Во сколько отходит поезд?"],
  ["Basta così, grazie.", "Достаточно, спасибо."],
  ["Che bello!", "Как здорово!"],
  ["Ho bisogno di aiuto.", "Мне нужна помощь."],
  ["Prendiamo un caffè?", "Выпьем кофе?"],
];

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const appButton = (text = "▶ Открыть Langtiamo") => ({ inline_keyboard: [[{ text, web_app: { url: APP_URL } }]] });
const plural = (n: number, a: string, b: string, c: string) => {
  const m = Math.abs(n) % 100, k = m % 10;
  if (m > 10 && m < 20) return c;
  if (k > 1 && k < 5) return b;
  if (k === 1) return a;
  return c;
};

async function tg(method: string, body: unknown) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await r.json();
}
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function hmac(key: Uint8Array | ArrayBuffer, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await crypto.subtle.sign("HMAC", k, enc.encode(data));
}
async function webhookSecret() {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode("pp-webhook:" + TOKEN))).slice(0, 48);
}
// Проверка initData по документации Telegram Mini Apps
async function verifyInitData(initData: string) {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), TOKEN);
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > 86400 * 30) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch { return null; }
}
function localParts(tz: string) {
  let zone = tz;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: zone }); } catch { zone = "Europe/Rome"; }
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), dayNum: Math.floor(Date.parse(`${p.year}-${p.month}-${p.day}`) / 864e5) };
}
function cleanSched(v: unknown) {
  const out: Record<string, number> = {};
  if (v && typeof v === "object") for (const [k, n] of Object.entries(v as Record<string, unknown>).slice(0, 40)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(k)) out[k] = clampInt(n, 0, 10000);
  }
  return out;
}
const clampInt = (v: unknown, lo: number, hi: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
};

/* ---------- сессии сайта ---------- */
let SESSION_SECRET = "";
async function sessionSecret() {
  if (!SESSION_SECRET) {
    const { data } = await sb.from("pp_config").select("value").eq("key", "session_secret").maybeSingle();
    SESSION_SECRET = data?.value || "";
  }
  return SESSION_SECRET;
}
const b64u = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
async function makeToken(id: number, name: string) {
  const payload = b64u(JSON.stringify({ id, name, exp: Date.now() + 1000 * 86400 * 180 }));
  return payload + "." + hex(await hmac(enc.encode(await sessionSecret()), payload));
}
async function readToken(t: string) {
  const [payload, sig] = String(t || "").split(".");
  if (!payload || !sig) return null;
  if (hex(await hmac(enc.encode(await sessionSecret()), payload)) !== sig) return null;
  try { const o = JSON.parse(unb64u(payload)); return o.exp > Date.now() ? o : null; } catch { return null; }
}
// кто делает запрос: Mini App (initData) или сайт (токен)
async function whoami(body: any): Promise<{ id: number; first_name?: string } | null> {
  if (body?.initData) { const u = await verifyInitData(String(body.initData)); return u?.id ? u : null; }
  if (body?.token) { const o = await readToken(String(body.token)); return o ? { id: o.id, first_name: o.name } : null; }
  return null;
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });
const validNonce = (n: unknown) => typeof n === "string" && /^[A-Za-z0-9]{24,48}$/.test(n);

async function onLoginStart(body: any) {
  if (!validNonce(body?.nonce)) return json({ ok: false }, 400);
  await sb.from("pp_login").delete().lt("created_at", new Date(Date.now() - 15 * 60e3).toISOString());
  await sb.from("pp_login").upsert({ nonce: body.nonce, tg_id: null }, { onConflict: "nonce" });
  const me = await tg("getMe", {});
  return json({ ok: true, bot: me?.result?.username || "langtiamo_bot" });
}
async function onLoginPoll(body: any) {
  if (!validNonce(body?.nonce)) return json({ ok: false }, 400);
  const { data } = await sb.from("pp_login").select("*").eq("nonce", body.nonce).maybeSingle();
  if (!data) return json({ ok: false, expired: true });
  if (Date.now() - Date.parse(data.created_at) > 10 * 60e3) { await sb.from("pp_login").delete().eq("nonce", body.nonce); return json({ ok: false, expired: true }); }
  if (!data.tg_id) return json({ ok: true, pending: true });
  await sb.from("pp_login").delete().eq("nonce", body.nonce);
  return json({ ok: true, token: await makeToken(data.tg_id, data.first_name || ""), name: data.first_name || "" });
}
async function onLoad(body: any) {
  const u = await whoami(body);
  if (!u) return json({ ok: false }, 401);
  const { data } = await sb.from("pp_progress").select("state, updated_at").eq("tg_id", u.id).maybeSingle();
  return json({ ok: true, id: u.id, name: u.first_name || "", state: data?.state ?? null, updatedAt: data?.updated_at ?? 0 });
}
async function onSave(body: any) {
  const u = await whoami(body);
  if (!u) return json({ ok: false }, 401);
  const st = body?.state, at = Number(body?.updatedAt) || 0;
  if (!st || typeof st !== "object" || JSON.stringify(st).length > 900_000) return json({ ok: false }, 400);
  const { data } = await sb.from("pp_progress").select("updated_at").eq("tg_id", u.id).maybeSingle();
  // оптимистичная блокировка: клиент присылает версию, от которой он отталкивался (base)
  const conflict = data && !body.force && (body.base !== undefined ? Number(data.updated_at) !== Number(body.base) : Number(data.updated_at) > at);
  if (conflict) return json({ ok: false, stale: true, updatedAt: data.updated_at });
  await sb.from("pp_progress").upsert({ tg_id: u.id, state: st, updated_at: at, saved_at: new Date().toISOString() }, { onConflict: "tg_id" });
  return json({ ok: true });
}
async function onTr(body: any) {
  const q = String(body?.q || "").trim().slice(0, 450);
  const from = body?.from === "ru" ? "ru" : "it", to = from === "it" ? "ru" : "it";
  if (!q) return json({ ok: false }, 400);
  const key = (from + "|" + to + "|" + q.toLowerCase()).slice(0, 600);
  const { data } = await sb.from("pp_tr").select("res").eq("k", key).maybeSingle();
  if (data) return json({ ok: true, text: data.res, cached: true });
  const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${from}|${to}`);
  const j = await r.json().catch(() => null);
  const text: string = j?.responseData?.translatedText || "";
  if (!text || Number(j?.responseStatus) !== 200 || /^MYMEMORY WARNING/i.test(text)) return json({ ok: false }, 502);
  await sb.from("pp_tr").upsert({ k: key, res: text }, { onConflict: "k" });
  return json({ ok: true, text });
}
async function onCheck(body: any) {
  const text = String(body?.text || "").slice(0, 3000);
  if (!text.trim()) return json({ ok: false }, 400);
  const form = new URLSearchParams({ text, language: "it-IT", motherTongue: "ru" });
  const r = await fetch("https://api.languagetool.org/v2/check", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form,
  });
  if (!r.ok) return json({ ok: false, status: r.status }, 502);
  const raw = await r.text();
  let j: any = null;
  try { j = JSON.parse(raw); } catch { return json({ ok: false, bad: raw.slice(0, 200) }, 502); }
  const matches = (j?.matches || []).slice(0, 40).map((m: any) => ({
    o: m.offset, l: m.length, msg: m.message || "", sh: m.shortMessage || "",
    rep: (m.replacements || []).slice(0, 3).map((x: any) => x.value),
    cat: m.rule?.category?.id || "", type: m.rule?.issueType || "", rule: m.rule?.id || "",
  }));
  return json({ ok: true, matches, lang: j?.language?.code || "" });
}
async function onCallback(q: any) {
  const data: string = q.data || "";
  if (!data.startsWith("login:")) { await tg("answerCallbackQuery", { callback_query_id: q.id }); return; }
  const nonce = data.slice(6);
  const { data: row } = validNonce(nonce) ? await sb.from("pp_login").select("*").eq("nonce", nonce).maybeSingle() : { data: null };
  const fresh = row && !row.tg_id && Date.now() - Date.parse(row.created_at) < 10 * 60e3;
  if (fresh) await sb.from("pp_login").update({ tg_id: q.from.id, first_name: q.from.first_name || null }).eq("nonce", nonce);
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: fresh ? "Вход подтверждён" : "Ссылка устарела" });
  if (q.message) await tg("editMessageText", {
    chat_id: q.message.chat.id, message_id: q.message.message_id,
    text: fresh ? "✅ Вход на сайт подтверждён. Вернись в браузер, прогресс уже загружается." : "⌛ Эта ссылка для входа устарела. Нажми «Войти через Telegram» на сайте ещё раз.",
  });
}

/* ---------- команды бота ---------- */
async function onUpdate(u: any) {
  if (u.callback_query) { await onCallback(u.callback_query); return; }
  const m = u.message;
  if (!m || !m.chat || m.chat.type !== "private") return;
  const chat = m.chat.id, from = m.from || {};
  const text: string = (m.text || "").trim();
  const name = esc(from.first_name || "");
  const { data: row } = await sb.from("pp_users").select("*").eq("tg_id", from.id).maybeSingle();

  if (text.startsWith("/start login_")) {
    if (!row) await sb.from("pp_users").upsert({ tg_id: from.id, chat_id: chat, first_name: from.first_name || null }, { onConflict: "tg_id" });
    const nonce = text.slice("/start login_".length).trim();
    await tg("sendMessage", {
      chat_id: chat, parse_mode: "HTML",
      text: "🔐 <b>Вход на сайт Langtiamo</b>\n\nНажми кнопку, чтобы открыть свой прогресс в браузере.\nЕсли ты не начинал вход сам, ничего не нажимай.",
      reply_markup: { inline_keyboard: [[{ text: "✅ Подтвердить вход", callback_data: "login:" + nonce }]] },
    });
    return;
  }
  if (text.startsWith("/start") || !row) {
    await sb.from("pp_users").upsert({ tg_id: from.id, chat_id: chat, first_name: from.first_name || null }, { onConflict: "tg_id" });
    await tg("sendMessage", {
      chat_id: chat, parse_mode: "HTML", reply_markup: appButton(),
      text: `Ciao${name ? ", " + name : ""}! 👋\n\n<b>Langtiamo</b> — итальянский с нуля: карточки слов, фразы для жизни в Италии, грамматика, диалоги и тренировки на слух.\n\n⏰ Каждый день в <b>${row?.remind_hour ?? 19}:00</b> я напомню позаниматься, если ты ещё не занимался.\n\n/site — ссылка на сайт (с твоим прогрессом)\n/time 9 — поменять час напоминания\n/remind — включить или выключить напоминания\n\nНажми кнопку, чтобы начать 👇`,
    });
    return;
  }
  if (/^\/(site|web|sait)\b/i.test(text) || /^(сайт|ссылка на сайт|веб)$/i.test(text)) {
    const token = await makeToken(from.id, from.first_name || "");
    await tg("sendMessage", {
      chat_id: chat, parse_mode: "HTML", disable_web_page_preview: true,
      text: `🌐 <b>Langtiamo на сайте</b>\n\nКнопка ниже откроет сайт сразу с твоим прогрессом, входить не нужно. Удобно на ноутбуке: перешли себе это сообщение или открой бота в Telegram Desktop.\n\nОбычная ссылка: ${APP_URL}\n\n⚠️ Кнопку не пересылай другим людям: по ней открывается твой аккаунт.`,
      reply_markup: { inline_keyboard: [[{ text: "🌐 Открыть сайт с моим прогрессом", url: `${APP_URL}#login=${token}` }]] },
    });
    return;
  }
  if (text.startsWith("/time")) {
    const arg = text.split(/\s+/)[1];
    const h = Number(arg);
    if (arg === undefined || !Number.isInteger(h) || h < 0 || h > 23) {
      await tg("sendMessage", { chat_id: chat, text: `Сейчас напоминание приходит в ${row.remind_hour}:00.\nЧтобы поменять, напиши час от 0 до 23, например: /time 9` });
      return;
    }
    await sb.from("pp_users").update({ remind_hour: h, remind: true }).eq("tg_id", from.id);
    await tg("sendMessage", { chat_id: chat, text: `Готово! Напоминание будет приходить в ${h}:00 (часовой пояс: ${row.tz}).` });
    return;
  }
  if (text.startsWith("/remind")) {
    const on = !row.remind;
    await sb.from("pp_users").update({ remind: on }).eq("tg_id", from.id);
    await tg("sendMessage", { chat_id: chat, text: on ? `🔔 Напоминания включены, в ${row.remind_hour}:00.` : "🔕 Напоминания выключены. Включить обратно: /remind" });
    return;
  }
  const [it, ru] = PHRASES[Math.floor(Math.random() * PHRASES.length)];
  await tg("sendMessage", {
    chat_id: chat, parse_mode: "HTML", reply_markup: appButton(),
    text: `Все уроки внутри приложения 👇\n\nА пока фраза: <b>${esc(it)}</b> — ${esc(ru)}`,
  });
}

/* ---------- синхронизация из Mini App ---------- */
async function onSync(body: any) {
  const user = await whoami(body);
  if (!user?.id) return json({ ok: false }, 401);
  const s = body.stats || {};
  let tz = typeof s.tz === "string" ? s.tz.slice(0, 64) : "Europe/Rome";
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { tz = "Europe/Rome"; }
  const rec: Record<string, unknown> = {
    tg_id: user.id, chat_id: user.id, ...(user.first_name ? { first_name: user.first_name } : {}), tz,
    due_sched: cleanSched(s.dueSched), new_left: clampInt(s.newLeft, 0, 1000),
    new_per_day: clampInt(s.newPerDay, 0, 1000), new_avail: clampInt(s.newAvail, 0, 100000),
    streak: clampInt(s.streak, 0, 100000), xp_today: clampInt(s.xpToday, 0, 100000), goal: clampInt(s.goal, 1, 1000),
    last_day: typeof s.lastDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.lastDay) ? s.lastDay : null,
    last_sync: new Date().toISOString(),
  };
  await sb.from("pp_users").upsert(rec, { onConflict: "tg_id" });
  return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, "content-type": "application/json" } });
}

/* ---------- напоминания ---------- */
async function onCron() {
  const { data: users } = await sb.from("pp_users").select("*").eq("remind", true);
  let sent = 0;
  for (const u of users || []) {
    const lp = localParts(u.tz || "Europe/Rome");
    if (lp.hour !== u.remind_hour || u.last_sent_day === lp.day || u.last_day === lp.day) continue;
    const due = Object.entries(u.due_sched || {}).reduce((a, [k, n]) => a + (k <= lp.day ? Number(n) || 0 : 0), 0);
    const fresh = u.last_day === lp.day ? u.new_left : Math.min(u.new_per_day, u.new_avail);
    const yest = new Date(Date.parse(lp.day) - 864e5).toISOString().slice(0, 10);
    const streak = u.last_day === yest ? u.streak : 0;
    const [it, ru] = PHRASES[((lp.dayNum % PHRASES.length) + PHRASES.length) % PHRASES.length];
    const lines = [`Ciao${u.first_name ? ", " + esc(u.first_name) : ""}! Пора позаниматься итальянским 🇮🇹`, ""];
    if (due > 0) lines.push(`📚 На повтор: ${due} ${plural(due, "карточка", "карточки", "карточек")}`);
    if (fresh > 0) lines.push(`🌱 Новых слов на сегодня: ${fresh}`);
    if (streak > 0) lines.push(`🔥 Серия: ${streak} ${plural(streak, "день", "дня", "дней")}. Не прерывай её!`);
    lines.push("", `💬 Фраза дня: <b>${esc(it)}</b>\n${esc(ru)}`, "", "Хватит и 5 минут 👇");
    const r = await tg("sendMessage", { chat_id: u.chat_id, parse_mode: "HTML", text: lines.join("\n"), reply_markup: appButton("▶ Заниматься") });
    if (r.ok) { sent++; await sb.from("pp_users").update({ last_sent_day: lp.day }).eq("tg_id", u.tg_id); }
    else if (r.error_code === 403) await sb.from("pp_users").update({ remind: false }).eq("tg_id", u.tg_id);
  }
  return new Response(JSON.stringify({ ok: true, sent }), { headers: { "content-type": "application/json" } });
}

async function onSetup() {
  if (!TOKEN) return new Response(JSON.stringify({ ok: false, error: "PP_BOT_TOKEN не задан" }), { status: 500 });
  const out: Record<string, unknown> = {};
  out.webhook = await tg("setWebhook", { url: SELF_URL, secret_token: await webhookSecret(), allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
  out.commands = await tg("setMyCommands", { commands: [
    { command: "start", description: "Открыть Langtiamo" },
    { command: "site", description: "Ссылка на сайт с моим прогрессом" },
    { command: "time", description: "Час напоминания, например /time 9" },
    { command: "remind", description: "Включить или выключить напоминания" },
  ] });
  out.menu = await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Учить", web_app: { url: APP_URL } } });
  out.me = (await tg("getMe", {}))?.result?.username ?? null;
  return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  const a = new URL(req.url).searchParams.get("a");
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    if (a === "setup") return await onSetup();
    if (a === "sync") return await onSync(await req.json());
    if (a === "login_start") return await onLoginStart(await req.json());
    if (a === "login_poll") return await onLoginPoll(await req.json());
    if (a === "load") return await onLoad(await req.json());
    if (a === "save") return await onSave(await req.json());
    if (a === "tr") return await onTr(await req.json());
    if (a === "check") return await onCheck(await req.json());
    if (a === "cron") {
      const { data } = await sb.from("pp_config").select("value").eq("key", "cron_secret").maybeSingle();
      if (!data || req.headers.get("x-pp-cron") !== data.value) return new Response("forbidden", { status: 403 });
      return await onCron();
    }
    if (req.method !== "POST" || !TOKEN || req.headers.get("x-telegram-bot-api-secret-token") !== (await webhookSecret())) {
      return new Response("ok");
    }
    await onUpdate(await req.json());
    return new Response("ok");
  } catch (e) {
    console.error(e);
    const api = a && a !== "cron" && a !== "setup";
    return new Response(api ? JSON.stringify({ ok: false }) : "ok", { status: api ? 500 : 200, headers: api ? CORS : {} });
  }
});

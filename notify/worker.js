// Two of Us — notification server (Cloudflare Worker, free plan).
//
// What it does
//  - Sends Web Push notifications to the app on your phones: nudges, partner progress,
//    the evening "habits left" reminder and the "streak ends tonight" alert.
//  - Stores nothing secret that anyone has to paste in: the push keys (VAPID) are created by the
//    worker itself the first time it runs and kept in its KV store.
//  - Checks who is calling with the normal Firebase sign-in token from the app, and checks that
//    two people really share a board by asking Firestore with that same token (so the database
//    rules decide, exactly as in the app).
//
// Bindings (set in the Cloudflare dashboard): KV namespace bound as `KV`.
// Cron trigger: every 15 minutes  (*/15 * * * *).

const PROJECT_ID = "habit-us-53e58";
const ALLOWED_ORIGINS = ["https://rasheedmashood.github.io"];
const VAPID_SUB = "https://rasheedmashood.github.io/two-of-us-habits/";
const DEFAULT_PREFS = { on: true, daily: true, dailyAt: "20:00", risk: true, riskAt: "22:00", nudges: true, progress: true };
const MAX_SUBS = 6;

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const cors = corsHeaders(origin);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/vapid") {
        const v = await vapidKeys(env);
        return json({ key: v.pub }, 200, cors);
      }
      if (req.method === "GET" && url.pathname === "/") return json({ ok: true, app: "two-of-us-notify" }, 200, cors);
      if (req.method !== "POST") return json({ error: "not found" }, 404, cors);

      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const uid = await verifyIdToken(token);
      if (!uid) return json({ error: "unauthorized" }, 401, cors);
      const body = await req.json().catch(() => ({}));

      switch (url.pathname) {
        case "/subscribe": return json(await subscribe(env, uid, token, body), 200, cors);
        case "/sync": {
          const r = await sync(env, uid, body);
          return json(r, r.error ? 404 : 200, cors);
        }
        case "/unsubscribe": return json(await unsubscribe(env, uid, body), 200, cors);
        case "/notify": {
          const r = await notify(env, uid, token, body);
          return json(r, r.error ? 400 : 200, cors);
        }
        case "/test": {
          const rec = await getUser(env, uid);
          if (!rec) return json({ error: "not subscribed" }, 404, cors);
          const n = await sendToUser(env, rec, { title: "Notifications are on", body: "You'll only hear from Two of Us when there's something to do.", tag: "test" });
          return json({ sent: n }, 200, cors);
        }
      }
      return json({ error: "not found" }, 404, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env, new Date(event.scheduledTime || Date.now())));
  }
};

// ---------- endpoints ----------
const okHid = h => typeof h === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(h);

async function subscribe(env, uid, token, b) {
  if (!okHid(b.hid)) return { error: "bad board" };
  const members = await boardMembers(token, b.hid);
  if (!members || !members.includes(uid)) return { error: "not a member" };
  const sub = cleanSub(b.sub);
  if (!sub) return { error: "bad subscription" };
  const rec = (await getUser(env, uid)) || { uid, subs: [], sent: {} };
  rec.hid = b.hid;
  rec.subs = [sub, ...(rec.subs || []).filter(s => s.endpoint !== sub.endpoint)].slice(0, MAX_SUBS);
  applyState(rec, b);
  await putUser(env, rec);
  return { ok: true };
}

async function sync(env, uid, b) {
  const rec = await getUser(env, uid);
  if (!rec) return { error: "not subscribed" };
  const before = JSON.stringify(rec);
  applyState(rec, b);
  if (JSON.stringify(rec) !== before) await putUser(env, rec);
  return { ok: true };
}

async function unsubscribe(env, uid, b) {
  const rec = await getUser(env, uid);
  if (!rec) return { ok: true };
  rec.subs = (rec.subs || []).filter(s => s.endpoint !== b.endpoint);
  if (rec.subs.length) await putUser(env, rec); else await env.KV.delete("u:" + uid);
  return { ok: true };
}

// nudges and partner progress: sent straight away to the other person on the board
async function notify(env, uid, token, b) {
  if (!okHid(b.hid) || typeof b.to !== "string" || b.to === uid) return { error: "bad request" };
  const type = b.type === "nudge" ? "nudges" : b.type === "progress" ? "progress" : null;
  if (!type) return { error: "bad type" };
  const to = await getUser(env, b.to);
  if (!to || to.hid !== b.hid || !to.prefs?.on || !to.prefs?.[type]) return { ok: true, sent: 0 };
  const members = await boardMembers(token, b.hid);
  if (!members || !members.includes(uid) || !members.includes(b.to)) return { error: "not on the same board" };
  const who = clip(b.from, 30) || "Your partner", habit = clip(b.habit, 60) || "a habit";
  const msg = type === "nudges"
    ? { title: `${who} nudged you`, body: habit + (b.step ? ` · ${clip(b.step, 30)}` : ""), tag: "nudge" }
    : { title: `${who} finished ${habit}`, body: "Your turn to make it a together day", tag: "progress-" + clip(b.habitId, 40) };
  return { ok: true, sent: await sendToUser(env, to, msg) };
}

// what the phone tells us: settings, time zone, and a small summary of today's habits
function applyState(rec, b) {
  if (b.prefs && typeof b.prefs === "object") {
    const p = { ...DEFAULT_PREFS, ...(rec.prefs || {}) };
    for (const k of ["on", "daily", "risk", "nudges", "progress"]) if (typeof b.prefs[k] === "boolean") p[k] = b.prefs[k];
    for (const k of ["dailyAt", "riskAt"]) if (/^\d{2}:\d{2}$/.test(b.prefs[k] || "")) p[k] = b.prefs[k];
    rec.prefs = p;
  }
  rec.prefs = rec.prefs || { ...DEFAULT_PREFS };
  if (typeof b.tz === "string" && b.tz.length < 64 && validTz(b.tz)) rec.tz = b.tz;
  if (Number.isFinite(b.dayEnd)) rec.dayEnd = Math.max(0, Math.min(6, b.dayEnd));
  if (typeof b.name === "string") rec.name = clip(b.name, 30);
  if (b.snap && /^\d{4}-\d{2}-\d{2}$/.test(b.snap.day || "") && Array.isArray(b.snap.habits)) {
    rec.snap = {
      day: b.snap.day, rest: !!b.snap.rest,
      habits: b.snap.habits.slice(0, 40).map(h => ({
        t: clip(h.t, 60), d: !!h.d, done: !!h.done, rest: !!h.rest, must: !!h.must,
        sp: Math.max(0, Math.min(9999, h.sp | 0))
      }))
    };
  }
}

// ---------- reminders (cron) ----------
async function runReminders(env, now) {
  let cursor;
  do {
    const page = await env.KV.list({ prefix: "u:", cursor });
    for (const k of page.keys) {
      const rec = await env.KV.get(k.name, "json");
      if (rec) await remindUser(env, rec, now);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

async function remindUser(env, rec, now) {
  const p = rec.prefs || DEFAULT_PREFS;
  if (!p.on || !rec.subs?.length || !rec.snap) return;
  const plan = planFor(rec, now);
  let changed = false;
  rec.sent = rec.sent || {};
  for (const [kind, msg] of plan) {
    rec.sent[kind] = plan.day;
    changed = true;
    if (msg) await sendToUser(env, rec, msg, true);
  }
  if (changed) await putUser(env, rec);
}

// decides which reminders are due right now; exported for tests
export function planFor(rec, now) {
  const p = { ...DEFAULT_PREFS, ...(rec.prefs || {}) };
  const tz = rec.tz || "UTC", dayEnd = rec.dayEnd || 0;
  const clock = localParts(tz, now);
  const day = localParts(tz, new Date(now.getTime() - dayEnd * 3600e3)).date;
  const mins = clock.h * 60 + clock.m;
  const out = []; out.day = day;
  const due = (on, at, kind) => {
    if (!on || rec.sent?.[kind] === day) return false;
    const [h, m] = at.split(":").map(Number), t = h * 60 + m;
    return mins >= t && mins < t + 60; // an hour's grace in case a run is late
  };
  const s = rec.snap, habits = s?.habits || [];
  const fresh = s && s.day === day, fromYesterday = s && s.day === addDays(day, -1);
  if (due(p.daily, p.dailyAt, "daily")) {
    let left = [];
    if (fresh) left = s.rest ? [] : habits.filter(h => !h.done && !h.rest && (h.d || h.must));
    else if (s && s.day < day) left = habits.filter(h => h.d);
    out.push(["daily", left.length ? leftMsg(left) : null]);
  }
  if (due(p.risk, p.riskAt, "risk")) {
    let risk = [];
    if (fresh && !s.rest) risk = habits.filter(h => !h.done && !h.rest && (h.d || h.must) && h.sp >= 2).map(h => ({ t: h.t, n: h.sp, w: !h.d }));
    else if (fromYesterday) risk = habits.filter(h => h.d && h.done && h.sp + 1 >= 2).map(h => ({ t: h.t, n: h.sp + 1, w: false }));
    out.push(["risk", risk.length ? riskMsg(risk) : null]);
  }
  return out;
}

function listNames(names) {
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
function leftMsg(left) {
  const n = left.length;
  return { title: `${n} habit${n > 1 ? "s" : ""} left today`, body: `${listNames(left.map(h => h.t))}. Still time.`, tag: "daily" };
}
function riskMsg(r) {
  if (r.length === 1) {
    const x = r[0];
    return { title: `Your ${x.n}-${x.w ? "week" : "day"} streak ends tonight`, body: `${x.t} is still open. Two minutes counts.`, tag: "risk" };
  }
  return { title: `${r.length} streaks end tonight`, body: `${listNames(r.map(x => x.t))} are still open.`, tag: "risk" };
}

// ---------- push ----------
async function sendToUser(env, rec, msg, skipSave) {
  const v = await vapidKeys(env);
  let sent = 0, dead = [];
  for (const sub of rec.subs || []) {
    const r = await sendPush(sub, JSON.stringify({ ...msg, url: VAPID_SUB }), v).catch(() => null);
    if (r && (r.status === 404 || r.status === 410)) dead.push(sub.endpoint);
    else if (r && r.ok) sent++;
  }
  if (dead.length) {
    rec.subs = rec.subs.filter(s => !dead.includes(s.endpoint));
    if (!skipSave) { if (rec.subs.length) await putUser(env, rec); else await env.KV.delete("u:" + rec.uid); }
  }
  return sent;
}

// RFC 8291 (aes128gcm) payload encryption + RFC 8292 VAPID
export async function encryptPayload(sub, payload, fixed = {}) {
  const enc = new TextEncoder();
  const uaPub = b64d(sub.keys.p256dh), auth = b64d(sub.keys.auth);
  const local = fixed.local || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const hkdf = async (salt, ikm, info, bytes) => {
    const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
  };
  const ikm = await hkdf(auth, shared, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = fixed.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = cat(enc.encode(payload), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = 65; header.set(asPub, 21);
  return cat(header, ct);
}

export async function vapidJwt(endpoint, v, nowSec = Math.floor(Date.now() / 1000)) {
  const aud = new URL(endpoint).origin;
  const h = b64e(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const p = b64e(new TextEncoder().encode(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: VAPID_SUB })));
  const key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(h + "." + p)));
  return `${h}.${p}.${b64e(sig)}`;
}

async function sendPush(sub, payload, v) {
  const body = await encryptPayload(sub, payload);
  const jwt = await vapidJwt(sub.endpoint, v);
  return fetch(sub.endpoint, {
    method: "POST",
    headers: { TTL: "86400", Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: `vapid t=${jwt}, k=${v.pub}` },
    body
  });
}

async function vapidKeys(env) {
  let v = await env.KV.get("vapid", "json");
  if (v) return v;
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pub = b64e(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  v = { jwk, pub };
  await env.KV.put("vapid", JSON.stringify(v));
  return v;
}

// ---------- Firebase sign-in + board membership ----------
let jwks = null, jwksExp = 0;
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
export async function verifyIdToken(token, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return null;
  let header, claims;
  try { header = JSON.parse(new TextDecoder().decode(b64d(parts[0]))); claims = JSON.parse(new TextDecoder().decode(b64d(parts[1]))); } catch { return null; }
  if (header.alg !== "RS256") return null;
  if (claims.aud !== PROJECT_ID || claims.iss !== `https://securetoken.google.com/${PROJECT_ID}`) return null;
  if (!claims.sub || claims.exp < nowSec - 60 || claims.iat > nowSec + 300) return null;
  if (!jwks || Date.now() > jwksExp) {
    const r = await fetch(JWKS_URL);
    jwks = (await r.json()).keys || [];
    jwksExp = Date.now() + 3600e3;
  }
  const jwk = jwks.find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64d(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  return ok ? claims.sub : null;
}
export function _setJwks(keys) { jwks = keys; jwksExp = Date.now() + 3600e3; }

// reading the board with the caller's own token: Firestore's rules only allow members to read it
async function boardMembers(token, hid) {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/households/${encodeURIComponent(hid)}`, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) return null;
  const j = await r.json();
  return (j.fields?.members?.arrayValue?.values || []).map(v => v.stringValue).filter(Boolean);
}

// ---------- helpers ----------
async function getUser(env, uid) { return env.KV.get("u:" + uid, "json"); }
async function putUser(env, rec) { await env.KV.put("u:" + rec.uid, JSON.stringify(rec)); }
function cleanSub(s) {
  if (!s || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) return null;
  return { endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) } };
}
const clip = (s, n) => typeof s === "string" ? s.slice(0, n) : "";
function validTz(tz) { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } }
export function localParts(tz, d) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const o = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, h: +o.hour % 24, m: +o.minute };
}
export function addDays(key, n) {
  const d = new Date(key + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return { "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0], "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" };
}
function json(o, status, headers) { return new Response(JSON.stringify(o), { status, headers: { ...headers, "Content-Type": "application/json" } }); }
function cat(...arrs) { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let i = 0; for (const a of arrs) { out.set(a, i); i += a.length; } return out; }
function b64e(u8) { let s = ""; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64d(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

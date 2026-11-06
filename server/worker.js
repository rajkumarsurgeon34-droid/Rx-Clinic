// Rx Clinic server — Cloudflare Worker + D1 database.
// Appointments, staff PIN sign-in, and in-app video teleconsults on LiveKit
// (the same video engine and host/waiting-room logic as SRK Meet).
//
// Bindings and settings (Cloudflare → Worker → Settings):
//   DB                  D1 database binding (tables are created automatically)
//   LIVEKIT_URL         e.g. wss://your-project.livekit.cloud            (variable)
//   LIVEKIT_API_KEY     from LiveKit Cloud → Settings → Keys              (variable)
//   LIVEKIT_API_SECRET  from the same page                               (secret)
//   ANTHROPIC_API_KEY   Claude for the AI features (used first if set)   (secret)
//   CLAUDE_MODEL        optional, defaults to claude-sonnet-5-5           (variable)
//   OPENAI_API_KEY      OpenAI for the AI features, if no Claude key     (secret)
//   OPENAI_MODEL        optional, defaults to gpt-4o-mini                (variable)
//   CLINIC_TZ_MINUTES   optional, clinic time zone offset, default 330 (India)

const enc = new TextEncoder();
const DEFAULT_PINS = { doctor: "1001", staff: "2002", pharmacy: "3003", lab: "4004", diagnostics: "5005", admin: "9009" };
const STAFF_ROLES = Object.keys(DEFAULT_PINS);
const DEFAULT_CLINIC = { name: "Rx Clinic", doctor: "Dr. M. Rajkumar", qual: "MBBS, DNB General Surgery" };
const SESSIONS = [["09:00", "13:00"], ["17:00", "20:00"]];
const SLOT_MIN = 15;
const STATUSES = ["booked", "arrived", "in-call", "completed", "cancelled", "no-show"];
const ID_RE = /^[a-z0-9-]{3,64}$/;
const ROOM_RE = /^rx-[a-z0-9]{16}$/;

// ---------- small helpers ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

async function signJwt(env, claims) {
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = b64url(await hmac(env.LIVEKIT_API_SECRET, `${header}.${body}`));
  return `${header}.${body}.${sig}`;
}

function now() { return Math.floor(Date.now() / 1000); }

function randomFrom(alphabet, n) {
  const r = crypto.getRandomValues(new Uint32Array(n));
  return Array.from(r, (x) => alphabet[x % alphabet.length]).join("");
}

function digits(s, max = 10) { return String(s || "").replace(/\D/g, "").slice(-max); }
function clean(s, max) { return String(s || "").trim().slice(0, max); }
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function secret(env) {
  const s = env.APP_SECRET || env.LIVEKIT_API_SECRET;
  if (!s) throw new HttpError(500, "Server is missing LIVEKIT_API_SECRET");
  return s;
}

// Clinic-local date and minutes (the worker runs in UTC).
function clinicNow(env) {
  const off = Number(env.CLINIC_TZ_MINUTES ?? 330);
  const d = new Date(Date.now() + off * 60000);
  const iso = d.toISOString().slice(0, 10);
  return { date: iso, minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function allSlots() {
  const out = [];
  for (const [a, b] of SESSIONS) {
    let [h, m] = a.split(":").map(Number);
    const [eh, em] = b.split(":").map(Number);
    while (h * 60 + m < eh * 60 + em) {
      out.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
      m += SLOT_MIN;
      if (m >= 60) { h++; m -= 60; }
    }
  }
  return out;
}

// ---------- database ----------

let schemaReady = false;
async function db(env) {
  if (!env.DB) throw new HttpError(500, "Database not connected: add a D1 binding named DB");
  if (!schemaReady) {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)"),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL,
        mode TEXT NOT NULL, status TEXT NOT NULL, name TEXT NOT NULL, age TEXT, sex TEXT,
        phone TEXT NOT NULL, reason TEXT, lang TEXT, code TEXT NOT NULL, room TEXT, source TEXT)`),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS appt_date ON appointments(date)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS appt_code ON appointments(code)"),
      // General record store for the next stages (visits, ward, lab, pharmacy).
      env.DB.prepare("CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (coll, id))"),
    ]);
    // Older databases: add the patient link to appointments (fails harmlessly once it exists).
    try { await env.DB.prepare("ALTER TABLE appointments ADD COLUMN patient_id TEXT").run(); } catch { /* already there */ }
    schemaReady = true;
  }
  return env.DB;
}

async function getSetting(env, k, fallback) {
  const row = await (await db(env)).prepare("SELECT v FROM settings WHERE k = ?").bind(k).first();
  if (!row) return fallback;
  try { return JSON.parse(row.v); } catch { return fallback; }
}

async function setSetting(env, k, v) {
  await (await db(env)).prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .bind(k, JSON.stringify(v)).run();
}

function publicAppt(r) {
  return {
    patientId: r.patient_id || "", id: r.id, date: r.date, time: r.time, mode: r.mode, status: r.status, name: r.name, age: r.age || "",
    sex: r.sex || "", phone: r.phone, reason: r.reason || "", lang: r.lang || "en", code: r.code,
  };
}

// ---------- accounts and sessions ----------
// Staff: user accounts (username + password) created by the admin, many per role.
// Patients: registered with a Patient ID (RX100001…), linked to a mobile number and/or Aadhaar.
// Session token: role.uid.ver.exp.sig  (ver changes when the password is reset or the account is disabled).

const USER_RE = /^[a-z0-9._-]{3,32}$/;
const PBKDF2_ITER = 20000; // kept modest for the Workers CPU limit; the count is stored with each hash

async function hashPassword(pw, iter = PBKDF2_ITER, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
  return `pbkdf2$${iter}$${btoa(String.fromCharCode(...salt))}$${btoa(String.fromCharCode(...bits))}`;
}
async function checkPassword(pw, stored) {
  const [kind, iter, salt] = String(stored || "").split("$");
  if (kind !== "pbkdf2" || !salt) return false;
  return safeEqual(await hashPassword(String(pw || ""), Number(iter), salt), stored);
}
function validPassword(pw) {
  pw = String(pw || "");
  if (pw.length < 6) throw new HttpError(400, "Password must be at least 6 characters");
  if (pw.length > 72) throw new HttpError(400, "Password is too long");
  return pw;
}

// Lock an account for 15 minutes after 5 wrong passwords.
async function checkLock(env, key) {
  const f = await getDoc(env, "loginfail", key);
  if (f && f.until > Date.now()) throw new HttpError(429, "Too many wrong attempts. Try again in 15 minutes.");
}
async function noteFail(env, key) {
  const f = (await getDoc(env, "loginfail", key)) || { n: 0, until: 0 };
  f.n = f.until && f.until < Date.now() ? 1 : f.n + 1;
  f.until = f.n >= 5 ? Date.now() + 15 * 60000 : 0;
  if (f.n >= 5) f.n = 0;
  await putDoc(env, "loginfail", key, f);
}
async function clearFail(env, key) { await (await db(env)).prepare("DELETE FROM docs WHERE coll = 'loginfail' AND id = ?").bind(key).run(); }

async function makeSession(env, role, uid = "pin", ver = 0, hours = 12) {
  const exp = now() + hours * 3600;
  const sig = b64url(await hmac(secret(env), `session:${role}.${uid}.${ver}.${exp}`)).slice(0, 32);
  return `${role}.${uid}.${ver}.${exp}.${sig}`;
}

/** Checks a session token; returns { role, uid, user }. */
async function readSession(env, session) {
  const [role, uid, ver, exp, sig] = String(session || "").split(".");
  if (!role || !uid || !exp || !sig) throw new HttpError(401, "Sign in again");
  if (Number(exp) < now()) throw new HttpError(401, "Sign in again: your session expired");
  const expected = b64url(await hmac(secret(env), `session:${role}.${uid}.${ver}.${exp}`)).slice(0, 32);
  if (!safeEqual(expected, sig)) throw new HttpError(401, "Sign in again");
  if (uid === "pin") { // old PIN sign-in (app 0.5), allowed only until the admin sets up accounts
    if (await accountsReady(env)) throw new HttpError(401, "Sign in again with your username and password");
    return { role, uid, user: { name: role === "doctor" || role === "admin" ? (await clinicInfo(env)).doctor : role, role } };
  }
  const user = await getDoc(env, role === "patient" ? "patients" : "users", uid);
  if (!user || user.active === false || String(user.ver || 0) !== String(ver)) throw new HttpError(401, "Sign in again");
  if (role !== "patient" && user.role !== role) throw new HttpError(401, "Sign in again");
  return { role, uid, user };
}

async function requireUser(env, session, roles) {
  const s = await readSession(env, session);
  if (s.role === "patient" || !(roles.includes(s.role) || s.role === "admin")) throw new HttpError(403, "Your login can't open this section");
  return s;
}
async function requireStaff(env, session, roles) { return (await requireUser(env, session, roles)).role; }
async function requirePatient(env, session) {
  const s = await readSession(env, session);
  if (s.role !== "patient") throw new HttpError(401, "Sign in as a patient");
  return s;
}

async function clinicInfo(env) { return Object.assign({}, DEFAULT_CLINIC, await getSetting(env, "clinic", {})); }

/** True once the admin has signed in with the new accounts and changed the starting password. */
async function accountsReady(env) { return !!(await getSetting(env, "accounts_ready", false)); }

/** First run: create the admin account (admin / admin123, must be changed at first sign-in). */
async function ensureAdmin(env) {
  const row = await (await db(env)).prepare("SELECT id FROM docs WHERE coll = 'users' LIMIT 1").first();
  if (row) return;
  await putDoc(env, "users", "admin", {
    username: "admin", name: "Administrator", role: "admin", passHash: await hashPassword("admin123"),
    mustChange: true, active: true, ver: 0, created: Date.now(), createdBy: "setup",
  });
}

function publicUser(id, u) {
  return { id, username: u.username, name: u.name, role: u.role, qual: u.qual || "", reg: u.reg || "", phone: u.phone || "",
    active: u.active !== false, mustChange: !!u.mustChange, created: u.created || 0, lastLogin: u.lastLogin || 0 };
}

async function findUser(env, username) {
  const r = await (await db(env)).prepare("SELECT id, data FROM docs WHERE coll = 'users' AND json_extract(data, '$.username') = ?").bind(username).first();
  return r ? { id: r.id, u: JSON.parse(r.data) } : null;
}

// ----- patients -----

// Verhoeff checksum used by Aadhaar numbers.
const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
function validAadhaar(n) {
  if (!/^[2-9]\d{11}$/.test(n)) return false;
  let c = 0;
  n.split("").reverse().forEach((d, i) => { c = VD[c][VP[i % 8][Number(d)]]; });
  return c === 0;
}
// Aadhaar is never stored in full: only a keyed hash (to find the patient) and the last 4 digits.
async function aadhaarKey(env, n) { return b64url(await hmac(secret(env), "aadhaar:" + n)); }

function normAadhaar(v) {
  const n = String(v || "").replace(/\D/g, "");
  if (!n) return "";
  if (!validAadhaar(n)) throw new HttpError(400, "That Aadhaar number is not valid. Check the 12 digits.");
  return n;
}

async function nextPatientId(env) {
  const r = await (await db(env)).prepare("INSERT INTO settings (k, v) VALUES ('patient_seq', '100001') ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1 RETURNING v").first();
  return "RX" + r.v;
}

function publicPatient(id, p) {
  return { id, name: p.name, age: p.age || "", sex: p.sex || "", phone: p.phone || "", aadhaar: p.aadhaarLast4 ? "XXXX XXXX " + p.aadhaarLast4 : "",
    address: p.address || "", hasLogin: !!p.passHash, created: p.created || 0 };
}

async function patientByAadhaar(env, n) {
  const key = await aadhaarKey(env, n);
  return (await listDocs(env, "patients", "json_extract(data, '$.aadhaarKey') = ?", [key]))[0] || null;
}

/** Creates a patient record from a request body; returns { id, p }. */
async function createPatient(env, b, createdBy, password) {
  const name = clean(b.name, 60);
  if (!name) throw new HttpError(400, "Enter the patient's name");
  const phone = digits(b.phone);
  if (phone && phone.length !== 10) throw new HttpError(400, "Enter a 10-digit mobile number");
  const aadhaar = normAadhaar(b.aadhaar);
  if (!phone && !aadhaar) throw new HttpError(400, "Enter a mobile number or an Aadhaar number");
  if (aadhaar) {
    const old = await patientByAadhaar(env, aadhaar);
    if (old) throw Object.assign(new HttpError(409, "This Aadhaar number is already registered"), { existing: old.id });
  }
  const id = await nextPatientId(env);
  const p = {
    name, age: clean(b.age, 3), sex: clean(b.sex, 10), phone, address: clean(b.address, 200),
    aadhaarKey: aadhaar ? await aadhaarKey(env, aadhaar) : "", aadhaarLast4: aadhaar ? aadhaar.slice(-4) : "",
    passHash: password ? await hashPassword(validPassword(password)) : "", ver: 0, active: true, created: Date.now(), createdBy,
  };
  await putDoc(env, "patients", id, p);
  return { id, p };
}

/** Finds the patient a login refers to: Patient ID, Aadhaar, or mobile number. */
async function patientsForLogin(env, login) {
  const t = String(login || "").trim().toUpperCase().replace(/\s/g, "");
  if (/^RX\d{6,}$/.test(t)) { const p = await getDoc(env, "patients", t); return p ? [Object.assign({ id: t }, p)] : []; }
  const d = t.replace(/\D/g, "");
  if (d.length === 12) { const p = validAadhaar(d) ? await patientByAadhaar(env, d) : null; return p ? [p] : []; }
  if (d.length >= 10) return listDocs(env, "patients", "json_extract(data, '$.phone') = ?", [d.slice(-10)]);
  return [];
}

async function patientHistory(env, pid) {
  const visits = (await listDocs(env, "visits", "json_extract(data, '$.patient.id') = ?", [pid])).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 50);
  const out = [];
  for (const v of visits) {
    const orders = await listDocs(env, "orders", "json_extract(data, '$.visitId') = ?", [v.id]);
    out.push({
      id: v.id, date: v.date, token: v.token, status: v.status, complaint: visitSummary(v.id, v).complaint,
      diagnosis: v.rx?.dx || v.work?.provisional?.diagnosis || "", doctor: v.doctor?.name || "",
      rx: v.status === "sent" || v.status === "dispensed" ? v.rx : null,
      reports: orders.map((o) => ({ test: o.test, modality: o.modality, status: o.status, result: o.status === "reported" ? o.result : "", impression: o.status === "reported" ? o.impression : "", date: o.date })),
    });
  }
  return out;
}

// ---------- LiveKit (same approach as the SRK Meet server) ----------

function liveKitReady(env) { return !!(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET); }

function apiBase(env) {
  return env.LIVEKIT_URL.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/+$/, "");
}

async function roomService(env, method, body, room) {
  const token = await signJwt(env, {
    iss: env.LIVEKIT_API_KEY, sub: "rx-clinic-server", nbf: now() - 10, exp: now() + 600,
    video: { room, roomAdmin: true, roomCreate: true, roomList: true },
  });
  const res = await fetch(`${apiBase(env)}/twirp/livekit.RoomService/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `LiveKit ${method}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function getParticipant(env, room, identity) {
  try { return await roomService(env, "GetParticipant", { room, identity }, room); }
  catch (e) { if (e.status === 404) return null; throw e; }
}

function roleOf(info) {
  try { return JSON.parse(info?.metadata || "{}").role || "guest"; } catch { return "guest"; }
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "guest";
}

async function issueToken(env, { room, name, identity, role }) {
  const full = role !== "waiting";
  return signJwt(env, {
    iss: env.LIVEKIT_API_KEY, sub: identity, jti: identity, name,
    metadata: JSON.stringify({ role }),
    nbf: now() - 10, exp: now() + 4 * 3600,
    video: { room, roomJoin: true, canPublish: full, canSubscribe: full, canPublishData: full, canUpdateOwnMetadata: full },
  });
}

async function ensureRoom(env, appt) {
  if (appt.room && ROOM_RE.test(appt.room)) return appt.room;
  const room = "rx-" + randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 16);
  await (await db(env)).prepare("UPDATE appointments SET room = ? WHERE id = ?").bind(room, appt.id).run();
  return room;
}

// ---------- OpenAI ----------

const DOCTOR_SYSTEM = "You assist qualified doctors in an Indian hospital. The doctor makes every decision. Be accurate and concise.";

async function askOpenAI(env, prompt, wantJson, system = DOCTOR_SYSTEM) {
  return chatOpenAI(env, [{ role: "system", content: system }, { role: "user", content: prompt }], wantJson);
}

// Pulls one JSON object out of a model's reply (tolerates code fences or a sentence around it).
function parseJsonReply(text) {
  try { return JSON.parse(text); } catch { /* try harder */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* fall through */ } }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* fall through */ } }
  throw new HttpError(502, "The AI reply was not valid JSON. Try again.");
}

// Claude (Anthropic) is used when ANTHROPIC_API_KEY is set; otherwise OpenAI.
async function chatClaude(env, messages, wantJson) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = [];
  for (const m of messages.filter((x) => x.role !== "system")) {
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.content; // Claude needs alternating turns
    else turns.push({ role: m.role, content: m.content });
  }
  if (!turns.length || turns[0].role !== "user") turns.unshift({ role: "user", content: "Begin." });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || "claude-sonnet-5-5",
      max_tokens: 4000,
      system: system + (wantJson ? "\n\nReply with only one valid JSON object and no other text." : ""),
      messages: turns,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, data?.error?.message || `AI error (${res.status})`);
  const text = (data?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  return wantJson ? { json: parseJsonReply(text) } : { text };
}

// Cloudflare Workers AI: free daily allowance, no API key (binding "AI" in wrangler.toml).
async function chatWorkersAI(env, messages, wantJson) {
  if (!env.AI) throw new HttpError(503, "AI is not set up yet: add ANTHROPIC_API_KEY or OPENAI_API_KEY in the worker settings");
  const msgs = messages.map((m) => ({ role: m.role, content: m.content }));
  if (wantJson && msgs[0]?.role === "system") msgs[0] = { role: "system", content: msgs[0].content + "\n\nReply with only one valid JSON object and no other text." };
  let out;
  try {
    out = await env.AI.run(env.WORKERS_AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages: msgs, max_tokens: 2500 });
  } catch (e) {
    const msg = String(e?.message || e);
    if (/neuron|limit|quota|429/i.test(msg)) throw new HttpError(429, "Today's free AI allowance is used up. It resets at 5:30 am, or add a Claude or OpenAI key.");
    throw new HttpError(502, "AI error: " + msg);
  }
  const r = out?.response;
  if (r && typeof r === "object") return wantJson ? { json: r } : { text: JSON.stringify(r) };
  const text = String(r || "");
  return wantJson ? { json: parseJsonReply(text) } : { text };
}

// Order: Claude key → OpenAI key → free Cloudflare Workers AI. A paid provider that fails
// for billing reasons (no credit, quota) falls back to Workers AI so the clinic keeps working.
async function chatOpenAI(env, messages, wantJson) {
  const fallback = async (e) => {
    if (env.AI && /credit|quota|billing|insufficient|429|balance/i.test(String(e?.message))) return chatWorkersAI(env, messages, wantJson);
    throw e;
  };
  if (env.ANTHROPIC_API_KEY) { try { return await chatClaude(env, messages, wantJson); } catch (e) { return fallback(e); } }
  if (env.OPENAI_API_KEY) { try { return await chatOpenAIDirect(env, messages, wantJson); } catch (e) { return fallback(e); } }
  return chatWorkersAI(env, messages, wantJson);
}

async function chatOpenAIDirect(env, messages, wantJson) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4o-mini",
      messages,
      ...(wantJson ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, data?.error?.message || `AI error (${res.status})`);
  const text = data?.choices?.[0]?.message?.content || "";
  if (!wantJson) return { text };
  return { json: parseJsonReply(text) };
}

// ---------- patient check-in (AI history taking) ----------

const LANG_NAMES = { en: "English", ta: "Tamil", hi: "Hindi" };

function intakeRules(lang, age, sex) {
  const L = LANG_NAMES[lang] || "English";
  return `You are the history-taking assistant of an Indian outpatient clinic (general surgery and general medicine). You interview the PATIENT on a phone or tablet before the doctor sees them.
Patient: ${age} years, ${sex}.
Language: write every question and option in ${L}${lang === "en" ? "" : " script"}, in simple everyday words a non-medical person understands. Medical terms may follow in brackets.
Rules:
- One short question per turn, like a careful resident taking history. Offer 2-6 tappable answer options in the same language when sensible; set "multi": true when several may apply. The patient can also type freely.
- Cover: chief complaints with duration; history of the presenting illness explored like a clinician (site, onset, character, radiation, severity, timing, aggravating and relieving factors, associated symptoms relevant to the complaint); red-flag symptoms; past illnesses (diabetes, hypertension, TB, asthma, heart disease, thyroid, epilepsy, jaundice); past surgeries; blood transfusions; drug allergies; current medicines; habits (smoking, alcohol, tobacco chewing); diet; sleep; appetite; bowel and bladder; menstrual and obstetric history if female aged 12-55; family history.
- Never diagnose, reassure or advise treatment.
- If the patient reports an emergency symptom happening now (chest pain, severe breathlessness, heavy bleeding, fainting, confusion, thoughts of self-harm), set "urgent": true and begin that question by asking them to tell the staff immediately.
- Finish when you have enough for a complete case sheet, usually 12-20 questions.
Reply with ONLY one JSON object:
{"done": false, "question": "...", "options": ["..."], "multi": false, "urgent": false}
When finished reply: {"done": true, "closing": "<one thank-you sentence in ${L}>"}`;
}

function caseSheetPrompt(qa, age, sex, lang) {
  return `Convert this outpatient intake interview into a structured case sheet in ENGLISH for the treating doctor. The patient answered in ${LANG_NAMES[lang] || "English"}; translate faithfully. Use only what the patient said. Write "Not asked" for topics not covered and "Nil" for denied ones. Do not diagnose.
Patient: ${age} years, ${sex}.
Interview:
${qa.map((x, i) => `Q${i + 1}: ${x.q}\nA: ${x.a}`).join("\n")}
Reply with ONLY this JSON:
{"chiefComplaints":[{"complaint":"","duration":""}],"hpi":"one clinical paragraph","past":{"medical":"","surgical":"","transfusion":"","drugs":"","allergies":""},"habits":{"smoking":"","alcohol":"","tobacco":"","diet":"","sleep":"","appetiteBowelBladder":""},"menstrualObstetric":"","family":"","redFlags":[]}`;
}

async function getDoc(env, coll, id) {
  const r = await (await db(env)).prepare("SELECT data FROM docs WHERE coll = ? AND id = ?").bind(coll, id).first();
  return r ? JSON.parse(r.data) : null;
}

async function putDoc(env, coll, id, data) {
  await (await db(env)).prepare("INSERT INTO docs (coll, id, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(coll, id) DO UPDATE SET data = excluded.data, updated = excluded.updated")
    .bind(coll, id, JSON.stringify(data), Date.now()).run();
}

function visitSummary(id, v) {
  const cc = (v.caseSheet?.chiefComplaints || []).map((c) => c.complaint + (c.duration ? " · " + c.duration : "")).join("; ") || v.qa?.[0]?.a || "";
  return { id, token: v.token, date: v.date, createdAt: v.createdAt, status: v.status, urgent: !!v.urgent, lang: v.lang, patient: v.patient, complaint: cc };
}

// ---------- orders, pharmacy, nursing ----------

const IMAGING = [
  ["PET-CT", /\bpet\b|pet[- ]?ct/i], ["MRI", /\bmri\b|\bmrcp\b|magnetic resonance/i], ["CT", /\bct\b|\bcect\b|\bhrct\b|computed tomograph/i],
  ["USG", /\busg\b|ultrasound|ultrasonograph|sonograph|doppler|\becho\b|\bfast\b/i], ["X-ray", /x[- ]?ray|\bcxr\b|radiograph/i],
  ["Mammogram", /mammo/i], ["Endoscopy", /endoscop|colonoscop|\bogd\b|\bercp\b/i],
];
function classifyTest(name) {
  for (const [modality, re] of IMAGING) if (re.test(name)) return { kind: "imaging", modality };
  return { kind: "lab", modality: "Lab" };
}

async function listDocs(env, coll, where = "", args = []) {
  const rows = (await (await db(env)).prepare(`SELECT id, data FROM docs WHERE coll = ?${where ? " AND " + where : ""}`).bind(coll, ...args).all()).results || [];
  return rows.map((r) => Object.assign({ id: r.id }, JSON.parse(r.data)));
}

// ---------- routes ----------

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "OPTIONS") return json({ ok: true });

  if (request.method === "GET") {
    if (path === "/") {
      let database = false;
      try { await db(env); database = true; } catch { /* reported below */ }
      return json({ ok: true, service: "rx-clinic", database, video: liveKitReady(env), ai: !!(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.AI), aiProvider: env.ANTHROPIC_API_KEY ? "claude" : env.OPENAI_API_KEY ? "openai" : env.AI ? "cloudflare-workers-ai" : "none", freeFallback: !!env.AI });
    }
    if (path === "/api/slots") {
      const date = url.searchParams.get("date") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "Invalid date");
      const { date: today, minutes } = clinicNow(env);
      const rows = (await (await db(env)).prepare("SELECT time FROM appointments WHERE date = ? AND status != 'cancelled'").bind(date).all()).results || [];
      const taken = new Set(rows.map((r) => r.time));
      const slots = allSlots().map((t) => {
        const [h, m] = t.split(":").map(Number);
        const past = date < today || (date === today && h * 60 + m <= minutes);
        return { t, free: !taken.has(t) && !past };
      });
      return json({ date, slots });
    }
    return json({ error: "Not found" }, 404);
  }

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body = {};
  try { body = await request.json(); } catch { throw new HttpError(400, "Invalid JSON"); }
  const D = await db(env);

  switch (path) {
    // ----- patients -----
    case "/api/book": {
      const name = clean(body.name, 60), phone = digits(body.phone), date = String(body.date || ""), time = String(body.time || "");
      const mode = body.mode === "tele" ? "tele" : "clinic";
      if (!name) throw new HttpError(400, "Enter your name");
      if (phone.length !== 10) throw new HttpError(400, "Enter a 10-digit mobile number");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !allSlots().includes(time)) throw new HttpError(400, "Choose a valid day and time");
      const { date: today, minutes } = clinicNow(env);
      const [h, m] = time.split(":").map(Number);
      if (date < today || date > addDays(today, 30) || (date === today && h * 60 + m <= minutes)) throw new HttpError(400, "That time has passed. Choose another slot.");
      const clash = await D.prepare("SELECT id FROM appointments WHERE date = ? AND time = ? AND status != 'cancelled'").bind(date, time).first();
      if (clash) throw new HttpError(409, "That slot was just taken. Choose another time.");
      let patientId = null;
      if (body.patientSession) patientId = (await requirePatient(env, body.patientSession)).uid;
      const id = crypto.randomUUID();
      const code = randomFrom("0123456789", 6);
      const row = {
        id, created_at: Date.now(), date, time, mode, status: "booked", name, age: clean(body.age, 3), sex: clean(body.sex, 10),
        phone, reason: clean(body.reason, 300), lang: ["en", "ta", "hi"].includes(body.lang) ? body.lang : "en", code, room: null, source: "patient", patient_id: patientId,
      };
      await D.prepare(`INSERT INTO appointments (id, created_at, date, time, mode, status, name, age, sex, phone, reason, lang, code, room, source, patient_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(row.id, row.created_at, row.date, row.time, row.mode, row.status, row.name, row.age, row.sex, row.phone, row.reason, row.lang, row.code, row.room, row.source, patientId).run();
      return json({ appointment: publicAppt(row) });
    }

    case "/api/appt": {
      const r = await D.prepare("SELECT * FROM appointments WHERE code = ? AND phone = ? ORDER BY created_at DESC LIMIT 1")
        .bind(digits(body.code, 6), digits(body.phone)).first();
      if (!r) throw new HttpError(404, "No appointment found for that code and mobile number");
      return json({ appointment: publicAppt(r) });
    }

    // ----- staff -----
    case "/api/login": {
      // Old app (0.5) sends { role, pin }: allowed only until the admin finishes account setup.
      if (body.pin !== undefined && !body.username) {
        if (await accountsReady(env)) throw new HttpError(401, "PIN sign-in is off. Update the app and sign in with your username and password.");
        const role = String(body.role || "");
        if (!STAFF_ROLES.includes(role)) throw new HttpError(400, "Unknown role");
        const pins = Object.assign({}, DEFAULT_PINS, await getSetting(env, "pins", {}));
        if (!safeEqual(String(pins[role]), String(body.pin || ""))) throw new HttpError(401, "That PIN is not right");
        return json({ session: await makeSession(env, role), role, clinic: await clinicInfo(env) });
      }
      await ensureAdmin(env);
      const username = String(body.username || "").trim().toLowerCase();
      const lockKey = "u:" + username;
      await checkLock(env, lockKey);
      const f = USER_RE.test(username) ? await findUser(env, username) : null;
      if (!f || !(await checkPassword(body.password, f.u.passHash))) {
        if (USER_RE.test(username)) await noteFail(env, lockKey);
        throw new HttpError(401, "Wrong username or password");
      }
      if (f.u.active === false) throw new HttpError(403, "This login is disabled. Ask the admin.");
      await clearFail(env, lockKey);
      f.u.lastLogin = Date.now();
      await putDoc(env, "users", f.id, f.u);
      return json({ session: await makeSession(env, f.u.role, f.id, f.u.ver || 0), role: f.u.role, user: publicUser(f.id, f.u), clinic: await clinicInfo(env) });
    }

    case "/api/me": {
      const s = await readSession(env, body.session);
      if (s.role === "patient") return json({ role: "patient", patient: publicPatient(s.uid, s.user) });
      return json({ role: s.role, user: s.uid === "pin" ? { name: s.user.name, role: s.role, username: "" } : publicUser(s.uid, s.user), clinic: await clinicInfo(env) });
    }

    case "/api/me/password": {
      const s = await readSession(env, body.session);
      if (s.uid === "pin") throw new HttpError(400, "Sign in with a username first");
      const coll = s.role === "patient" ? "patients" : "users";
      const u = s.user;
      if (u.passHash && !(await checkPassword(body.old, u.passHash))) throw new HttpError(401, "Your current password is not right");
      const pw = validPassword(body.password);
      if (pw === String(body.old || "")) throw new HttpError(400, "Choose a new password, different from the old one");
      u.passHash = await hashPassword(pw);
      u.mustChange = false;
      u.ver = (u.ver || 0) + 1;
      await putDoc(env, coll, s.uid, u);
      if (s.role === "admin") await setSetting(env, "accounts_ready", true);
      return json({ ok: true, session: await makeSession(env, s.role, s.uid, u.ver, s.role === "patient" ? 24 * 30 : 12) });
    }

    // ----- admin: staff logins -----
    case "/api/admin/users": {
      await requireUser(env, body.session, ["admin"]);
      const list = (await listDocs(env, "users")).map((u) => publicUser(u.id, u))
        .sort((a, b) => STAFF_ROLES.indexOf(a.role) - STAFF_ROLES.indexOf(b.role) || a.name.localeCompare(b.name));
      return json({ users: list });
    }

    case "/api/admin/users/save": {
      const me = await requireUser(env, body.session, ["admin"]);
      const x = body.user || {};
      const isNew = !x.id;
      const id = isNew ? randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 10) : String(x.id);
      const u = isNew ? { created: Date.now(), createdBy: me.user.username || "admin", ver: 0 } : await getDoc(env, "users", id);
      if (!u) throw new HttpError(404, "Login not found");
      const username = String(x.username ?? u.username ?? "").trim().toLowerCase();
      if (!USER_RE.test(username)) throw new HttpError(400, "Username: 3 to 32 letters, numbers, dot, dash or underscore");
      const clash = await findUser(env, username);
      if (clash && clash.id !== id) throw new HttpError(409, "That username is taken");
      const role = String(x.role ?? u.role ?? "");
      if (!STAFF_ROLES.includes(role)) throw new HttpError(400, "Choose a role");
      const name = clean(x.name ?? u.name, 80);
      if (!name) throw new HttpError(400, "Enter the person's name");
      const active = x.active === undefined ? u.active !== false : !!x.active;
      if (!isNew && u.role === "admin" && (role !== "admin" || !active)) {
        const admins = (await listDocs(env, "users")).filter((a) => a.role === "admin" && a.active !== false && a.id !== id);
        if (!admins.length) throw new HttpError(400, "Keep at least one active admin login");
      }
      if (!isNew && (u.role !== role || (u.active !== false) !== active)) u.ver = (u.ver || 0) + 1; // signs them out
      Object.assign(u, { username, role, name, active, qual: clean(x.qual ?? u.qual, 80), reg: clean(x.reg ?? u.reg, 40), phone: digits(x.phone ?? u.phone) });
      if (isNew || x.password) {
        u.passHash = await hashPassword(validPassword(x.password));
        u.mustChange = true;
        if (!isNew) u.ver = (u.ver || 0) + 1;
      }
      await putDoc(env, "users", id, u);
      return json({ ok: true, user: publicUser(id, u) });
    }

    case "/api/settings": {
      const who = await requireStaff(env, body.session, ["doctor"]);
      if (body.clinic && typeof body.clinic === "object") {
        if (who !== "admin") throw new HttpError(403, "Only the admin can change clinic details");
        const c = await clinicInfo(env);
        for (const k of ["name", "doctor", "qual", "reg", "address", "phone", "hours"]) if (k in body.clinic) c[k] = clean(body.clinic[k], 200);
        await setSetting(env, "clinic", c);
      }
      return json({ ok: true, clinic: await clinicInfo(env) });
    }

    // ----- patient accounts -----
    case "/api/patient/register": {
      let r;
      try { r = await createPatient(env, body, "self", validPassword(body.password)); }
      catch (e) { if (e.existing) throw new HttpError(409, "This Aadhaar number is already registered. Sign in, or ask the reception to reset your password."); throw e; }
      return json({ patient: publicPatient(r.id, r.p), session: await makeSession(env, "patient", r.id, 0, 24 * 30) });
    }

    case "/api/patient/login": {
      const login = String(body.login || "").trim();
      const lockKey = "p:" + login.toUpperCase().replace(/\s/g, "");
      await checkLock(env, lockKey);
      const found = (await patientsForLogin(env, login)).filter((p) => p.passHash && p.active !== false);
      const ok = [];
      for (const p of found) if (await checkPassword(body.password, p.passHash)) ok.push(p);
      if (!ok.length) { await noteFail(env, lockKey); throw new HttpError(401, "Wrong Patient ID / mobile / Aadhaar or password"); }
      if (ok.length > 1) throw new HttpError(409, "More than one patient uses this mobile number. Sign in with your Patient ID.");
      await clearFail(env, lockKey);
      const p = ok[0];
      return json({ patient: publicPatient(p.id, p), session: await makeSession(env, "patient", p.id, p.ver || 0, 24 * 30) });
    }

    case "/api/patient/me": {
      const s = await requirePatient(env, body.session);
      const appts = (await D.prepare("SELECT * FROM appointments WHERE patient_id = ? OR (patient_id IS NULL AND phone = ? AND lower(name) = lower(?)) ORDER BY date DESC, time DESC LIMIT 30")
        .bind(s.uid, s.user.phone || "-", s.user.name).all()).results || [];
      return json({ patient: publicPatient(s.uid, s.user), visits: await patientHistory(env, s.uid), appointments: appts.map(publicAppt) });
    }

    case "/api/patient/update": {
      const s = await requirePatient(env, body.session);
      const p = s.user;
      if ("name" in body) p.name = clean(body.name, 60) || p.name;
      if ("age" in body) p.age = clean(body.age, 3);
      if ("sex" in body) p.sex = clean(body.sex, 10);
      if ("address" in body) p.address = clean(body.address, 200);
      if ("phone" in body) { const ph = digits(body.phone); if (ph && ph.length !== 10) throw new HttpError(400, "Enter a 10-digit mobile number"); p.phone = ph; }
      if (body.aadhaar) {
        const n = normAadhaar(body.aadhaar);
        const old = await patientByAadhaar(env, n);
        if (old && old.id !== s.uid) throw new HttpError(409, "This Aadhaar number is already linked to another Patient ID");
        p.aadhaarKey = await aadhaarKey(env, n); p.aadhaarLast4 = n.slice(-4);
      }
      if (!p.phone && !p.aadhaarKey) throw new HttpError(400, "Keep a mobile number or an Aadhaar number");
      await putDoc(env, "patients", s.uid, p);
      return json({ patient: publicPatient(s.uid, p) });
    }

    // ----- staff: patient registry -----
    case "/api/patients/register": {
      const me = await requireUser(env, body.session, ["staff", "doctor"]);
      try {
        const r = await createPatient(env, body, me.user.username || me.role, body.password ? body.password : "");
        return json({ patient: publicPatient(r.id, r.p) });
      } catch (e) {
        if (e.existing) throw new HttpError(409, `This Aadhaar number is already registered as ${e.existing}`);
        throw e;
      }
    }

    case "/api/patients/search": {
      await requireUser(env, body.session, ["staff", "doctor", "pharmacy", "lab", "diagnostics"]);
      const q = String(body.q || "").trim();
      let list = [];
      if (q.length >= 2) {
        list = await patientsForLogin(env, q);
        if (!list.length && !/\d/.test(q)) list = await listDocs(env, "patients", "lower(json_extract(data, '$.name')) LIKE ?", [q.toLowerCase().replace(/[%_]/g, "") + "%"]);
      }
      return json({ patients: list.slice(0, 30).map((p) => publicPatient(p.id, p)) });
    }

    case "/api/patients/get": {
      await requireUser(env, body.session, ["staff", "doctor"]);
      const id = String(body.id || "").toUpperCase();
      const p = await getDoc(env, "patients", id);
      if (!p) throw new HttpError(404, "Patient not found");
      return json({ patient: publicPatient(id, p), visits: await patientHistory(env, id) });
    }

    case "/api/patients/update": {
      await requireUser(env, body.session, ["staff", "doctor"]);
      const id = String(body.id || "").toUpperCase();
      const p = await getDoc(env, "patients", id);
      if (!p) throw new HttpError(404, "Patient not found");
      const x = body.patient || {};
      if (x.name) p.name = clean(x.name, 60);
      for (const k of ["age", "sex"]) if (k in x) p[k] = clean(x[k], k === "age" ? 3 : 10);
      if ("address" in x) p.address = clean(x.address, 200);
      if ("phone" in x) { const ph = digits(x.phone); if (ph && ph.length !== 10) throw new HttpError(400, "Enter a 10-digit mobile number"); p.phone = ph; }
      if (x.aadhaar) {
        const n = normAadhaar(x.aadhaar);
        const old = await patientByAadhaar(env, n);
        if (old && old.id !== id) throw new HttpError(409, `This Aadhaar number is already registered as ${old.id}`);
        p.aadhaarKey = await aadhaarKey(env, n); p.aadhaarLast4 = n.slice(-4);
      }
      if (x.password) { p.passHash = await hashPassword(validPassword(x.password)); p.ver = (p.ver || 0) + 1; }
      await putDoc(env, "patients", id, p);
      return json({ patient: publicPatient(id, p) });
    }

    case "/api/doctor/appointments": {
      await requireStaff(env, body.session, ["doctor"]);
      const date = String(body.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "Invalid date");
      const rows = (await D.prepare("SELECT * FROM appointments WHERE date = ? ORDER BY time").bind(date).all()).results || [];
      return json({ appointments: rows.map(publicAppt) });
    }

    case "/api/doctor/status": {
      await requireStaff(env, body.session, ["doctor"]);
      if (!STATUSES.includes(body.status)) throw new HttpError(400, "Invalid status");
      await D.prepare("UPDATE appointments SET status = ? WHERE id = ?").bind(body.status, String(body.id || "")).run();
      return json({ ok: true });
    }

    // ----- video teleconsult -----
    case "/api/tele/token": {
      if (!liveKitReady(env)) throw new HttpError(500, "Video is not set up: add LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET");
      if (body.session) {
        // Doctor: host of the teleconsult
        const me = await requireUser(env, body.session, ["doctor"]);
        const a = await D.prepare("SELECT * FROM appointments WHERE id = ?").bind(String(body.id || "")).first();
        if (!a || a.mode !== "tele") throw new HttpError(404, "Teleconsult not found");
        const room = await ensureRoom(env, a);
        if (["booked", "arrived"].includes(a.status)) await D.prepare("UPDATE appointments SET status = 'in-call' WHERE id = ?").bind(a.id).run();
        const name = me.user.name || "Doctor";
        const identity = `dr-${slug(name)}-${randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 5)}`;
        const token = await issueToken(env, { room, name, identity, role: "host" });
        return json({ url: env.LIVEKIT_URL, token, identity, role: "host", room, title: `Teleconsult · ${a.name}` });
      }
      // Patient: waits until the doctor admits them
      const a = await D.prepare("SELECT * FROM appointments WHERE code = ? AND phone = ? AND mode = 'tele' ORDER BY created_at DESC LIMIT 1")
        .bind(digits(body.code, 6), digits(body.phone)).first();
      if (!a) throw new HttpError(404, "No teleconsult found for that code and mobile number");
      if (["completed", "cancelled", "no-show"].includes(a.status)) throw new HttpError(410, "This teleconsult has ended");
      const room = await ensureRoom(env, a);
      let identity = typeof body.identity === "string" && ID_RE.test(body.identity)
        ? body.identity : `pt-${slug(a.name)}-${randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 5)}`;
      let role = "waiting";
      if (body.identity) {
        const info = await getParticipant(env, room, identity);
        if (info && roleOf(info) === "guest") role = "guest";
      }
      const token = await issueToken(env, { room, name: a.name, identity, role });
      return json({ url: env.LIVEKIT_URL, token, identity, role, room, title: "Teleconsult with your doctor" });
    }

    case "/api/meet/admit":
    case "/api/meet/remove":
    case "/api/meet/mute":
    case "/api/meet/end": {
      await requireStaff(env, body.session, ["doctor"]);
      const room = String(body.room || "");
      if (!ROOM_RE.test(room)) throw new HttpError(400, "Invalid room");
      const identity = String(body.identity || "");
      const action = path.split("/").pop();
      if (action !== "end" && !ID_RE.test(identity)) throw new HttpError(400, "Invalid participant");
      if (action === "admit") {
        await roomService(env, "UpdateParticipant", { room, identity, metadata: JSON.stringify({ role: "guest" }) }, room);
      } else if (action === "remove") {
        await roomService(env, "RemoveParticipant", { room, identity }, room);
      } else if (action === "mute") {
        const info = await getParticipant(env, room, identity);
        const tracks = (info?.tracks || []).filter((t) => t.type === "AUDIO" || t.type === 0 || t.source === "MICROPHONE" || t.source === 2);
        for (const t of tracks) if (!t.muted) await roomService(env, "MutePublishedTrack", { room, identity, track_sid: t.sid, muted: true }, room);
      } else {
        await roomService(env, "DeleteRoom", { room }, room);
        await D.prepare("UPDATE appointments SET status = 'completed' WHERE room = ? AND status = 'in-call'").bind(room).run();
      }
      return json({ ok: true });
    }

    // ----- patient check-in: AI interview -----
    case "/api/checkin/next": {
      const lang = ["en", "ta", "hi"].includes(body.lang) ? body.lang : "en";
      const turns = Array.isArray(body.turns) ? body.turns.slice(-60) : [];
      const msgs = [{ role: "system", content: intakeRules(lang, clean(body.age, 3), clean(body.sex, 10)) }];
      msgs.push({ role: "user", content: "Begin the interview now with the first question." });
      for (const t of turns) {
        if (t && (t.role === "user" || t.role === "assistant")) msgs.push({ role: t.role, content: clean(t.content, 1500) });
      }
      const r = await chatOpenAI(env, msgs, true);
      return json(r.json || {});
    }

    case "/api/checkin/finish": {
      const p = body.patient || {};
      const name = clean(p.name, 60);
      if (!name) throw new HttpError(400, "Enter the patient's name");
      const lang = ["en", "ta", "hi"].includes(body.lang) ? body.lang : "en";
      const qa = (Array.isArray(body.qa) ? body.qa : []).slice(0, 60).map((x) => ({ q: clean(x?.q, 600), a: clean(x?.a, 600) }));
      let caseSheet = null;
      try { caseSheet = (await askOpenAI(env, caseSheetPrompt(qa, clean(p.age, 3), clean(p.sex, 10), lang), true)).json || null; } catch { caseSheet = null; }
      const { date } = clinicNow(env);
      const today = (await D.prepare("SELECT data FROM docs WHERE coll = 'visits' AND json_extract(data, '$.date') = ?").bind(date).all()).results || [];
      const token = today.reduce((m, r) => Math.max(m, Number(JSON.parse(r.data).token) || 0), 0) + 1;
      // Link the visit to a Patient ID: the signed-in patient, a Patient ID with its mobile number,
      // the same name and mobile seen before, or a new registration.
      const phone = digits(p.phone);
      let pid = null, newPatient = false;
      if (body.patientSession) pid = (await requirePatient(env, body.patientSession)).uid;
      if (!pid && p.id) {
        const known = await getDoc(env, "patients", String(p.id).toUpperCase().trim());
        if (known && phone && known.phone === phone) pid = String(p.id).toUpperCase().trim();
      }
      if (!pid && phone) {
        const same = (await listDocs(env, "patients", "json_extract(data, '$.phone') = ?", [phone])).filter((x) => x.name.trim().toLowerCase() === name.toLowerCase());
        if (same.length === 1) pid = same[0].id;
      }
      if (!pid) {
        try { pid = (await createPatient(env, { name, age: p.age, sex: p.sex, phone, aadhaar: p.aadhaar }, "check-in", "")).id; newPatient = true; }
        catch (e) { if (e.existing) pid = e.existing; /* otherwise check in without an ID */ }
      }
      const id = crypto.randomUUID();
      const visit = {
        patient: { id: pid || "", name, age: clean(p.age, 3), sex: clean(p.sex, 10), phone }, lang, qa, caseSheet,
        urgent: !!body.urgent, status: "waiting", token, date, createdAt: Date.now(), work: null, rx: null,
      };
      await putDoc(env, "visits", id, visit);
      return json({ id, token, patientId: pid || "", newPatient });
    }

    // ----- doctor: OPD visits -----
    case "/api/doctor/visits": {
      await requireStaff(env, body.session, ["doctor"]);
      const date = String(body.date || clinicNow(env).date);
      const rows = (await D.prepare("SELECT id, data FROM docs WHERE coll = 'visits' AND json_extract(data, '$.date') = ? ORDER BY updated DESC").bind(date).all()).results || [];
      const list = rows.map((r) => visitSummary(r.id, JSON.parse(r.data))).sort((a, b) => (a.token || 0) - (b.token || 0));
      return json({ visits: list });
    }

    case "/api/doctor/visit": {
      await requireStaff(env, body.session, ["doctor"]);
      const v = await getDoc(env, "visits", String(body.id || ""));
      if (!v) throw new HttpError(404, "Visit not found");
      const history = v.patient?.id ? (await patientHistory(env, v.patient.id)).filter((h) => h.id !== body.id).slice(0, 10) : [];
      return json({ id: body.id, visit: v, history });
    }

    case "/api/doctor/visit/save": {
      const me = await requireUser(env, body.session, ["doctor"]);
      const id = String(body.id || "");
      const v = await getDoc(env, "visits", id);
      if (!v) throw new HttpError(404, "Visit not found");
      const patch = body.patch || {};
      for (const k of ["work", "rx", "caseSheet"]) if (k in patch) v[k] = patch[k];
      if (patch.rx && me.uid !== "pin") v.doctor = { id: me.uid, name: me.user.name, qual: me.user.qual || "", reg: me.user.reg || "" };
      if (["waiting", "consult", "sent", "dispensed", "done"].includes(patch.status)) v.status = patch.status;
      if (JSON.stringify(v).length > 900000) throw new HttpError(413, "This case sheet is too large to save");
      await putDoc(env, "visits", id, v);
      return json({ ok: true, status: v.status });
    }

    // ----- investigation orders: lab and diagnostics -----
    case "/api/orders/create": {
      await requireStaff(env, body.session, ["doctor"]);
      const visitId = String(body.visitId || "");
      const v = await getDoc(env, "visits", visitId);
      if (!v) throw new HttpError(404, "Visit not found");
      const existing = await listDocs(env, "orders", "json_extract(data, '$.visitId') = ?", [visitId]);
      const have = new Set(existing.map((o) => o.test.toLowerCase()));
      const { date } = clinicNow(env);
      const made = [];
      for (const t of (Array.isArray(body.tests) ? body.tests : []).slice(0, 30)) {
        const test = clean(t, 120);
        if (!test || have.has(test.toLowerCase())) continue;
        const c = classifyTest(test);
        const o = { visitId, patient: { id: v.patient?.id || "", name: v.patient?.name || "", age: v.patient?.age || "", sex: v.patient?.sex || "" }, token: v.token,
          test, kind: c.kind, modality: c.modality, status: "ordered", date, orderedAt: Date.now(), result: "", impression: "" };
        const id = crypto.randomUUID();
        await putDoc(env, "orders", id, o);
        have.add(test.toLowerCase()); made.push(Object.assign({ id }, o));
      }
      return json({ created: made.length, orders: made });
    }

    case "/api/orders/list": {
      const role = await requireStaff(env, body.session, ["doctor", "lab", "diagnostics"]);
      let list;
      if (body.visitId) list = await listDocs(env, "orders", "json_extract(data, '$.visitId') = ?", [String(body.visitId)]);
      else {
        const kind = role === "lab" ? "lab" : role === "diagnostics" ? "imaging" : (body.kind === "imaging" ? "imaging" : "lab");
        const since = addDays(clinicNow(env).date, -7);
        list = await listDocs(env, "orders", "json_extract(data, '$.kind') = ? AND json_extract(data, '$.date') >= ?", [kind, since]);
        list = list.filter((o) => o.status !== "reported" || o.date === clinicNow(env).date);
      }
      list.sort((a, b) => (a.orderedAt || 0) - (b.orderedAt || 0));
      return json({ orders: list });
    }

    case "/api/orders/update": {
      await requireStaff(env, body.session, ["lab", "diagnostics"]);
      const id = String(body.id || "");
      const o = await getDoc(env, "orders", id);
      if (!o) throw new HttpError(404, "Order not found");
      const st = String(body.status || "");
      if (!["ordered", "collected", "scheduled", "reported"].includes(st)) throw new HttpError(400, "Invalid status");
      o.status = st;
      if (st === "collected" || st === "scheduled") o[st + "At"] = Date.now();
      if (st === "reported") {
        o.result = clean(body.result, 6000);
        o.impression = clean(body.impression, 2000);
        if (!o.result && !o.impression) throw new HttpError(400, "Enter the report first");
        o.reportedAt = Date.now();
      }
      await putDoc(env, "orders", id, o);
      return json({ ok: true });
    }

    // ----- pharmacy -----
    case "/api/pharmacy/stock": {
      await requireStaff(env, body.session, ["pharmacy", "doctor"]);
      const list = (await listDocs(env, "stock")).sort((a, b) => a.generic.localeCompare(b.generic));
      return json({ stock: list });
    }

    case "/api/pharmacy/stock/save": {
      await requireStaff(env, body.session, ["pharmacy"]);
      const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [body.item || {}];
      let n = 0;
      for (const it of items) {
        const generic = clean(it.generic, 120);
        if (!generic) continue;
        const id = typeof it.id === "string" && ID_RE.test(it.id) ? it.id : crypto.randomUUID();
        await putDoc(env, "stock", id, { generic, brand: clean(it.brand, 80), form: clean(it.form, 20) || "Tab", strength: clean(it.strength, 40), stock: Math.max(0, Math.floor(Number(it.stock) || 0)) });
        n++;
      }
      return json({ saved: n });
    }

    case "/api/pharmacy/stock/delete": {
      await requireStaff(env, body.session, ["pharmacy"]);
      await D.prepare("DELETE FROM docs WHERE coll = 'stock' AND id = ?").bind(String(body.id || "")).run();
      return json({ ok: true });
    }

    case "/api/pharmacy/queue": {
      await requireStaff(env, body.session, ["pharmacy"]);
      const since = addDays(clinicNow(env).date, -2);
      const list = (await listDocs(env, "visits", "json_extract(data, '$.status') IN ('sent', 'dispensed') AND json_extract(data, '$.date') >= ?", [since]))
        .map((v) => ({ id: v.id, token: v.token, date: v.date, status: v.status, patient: v.patient, rx: v.rx, dispensedAt: v.dispensedAt || null }))
        .sort((a, b) => (a.status === b.status ? (b.rx?.sentAt || 0) - (a.rx?.sentAt || 0) : a.status === "sent" ? -1 : 1));
      return json({ queue: list });
    }

    case "/api/pharmacy/dispense": {
      await requireStaff(env, body.session, ["pharmacy"]);
      const id = String(body.id || "");
      const v = await getDoc(env, "visits", id);
      if (!v) throw new HttpError(404, "Prescription not found");
      v.status = "dispensed"; v.dispensedAt = Date.now();
      await putDoc(env, "visits", id, v);
      return json({ ok: true });
    }

    // ----- nursing: OPD triage vitals -----
    case "/api/nurse/queue": {
      await requireStaff(env, body.session, ["staff"]);
      const { date } = clinicNow(env);
      const list = (await listDocs(env, "visits", "json_extract(data, '$.date') = ?", [date]))
        .map((v) => Object.assign(visitSummary(v.id, v), { triage: v.triage || null }))
        .sort((a, b) => (a.token || 0) - (b.token || 0));
      return json({ visits: list });
    }

    case "/api/nurse/vitals": {
      await requireStaff(env, body.session, ["staff"]);
      const id = String(body.id || "");
      const v = await getDoc(env, "visits", id);
      if (!v) throw new HttpError(404, "Patient not found");
      const vit = {};
      for (const k of ["bp", "pulse", "temp", "spo2", "rr", "rbs", "weight", "height"]) vit[k] = clean(body.vitals?.[k], 12);
      v.triage = { vitals: vit, note: clean(body.note, 500), at: Date.now() };
      await putDoc(env, "visits", id, v);
      return json({ ok: true });
    }

    // ----- admin -----
    case "/api/admin/overview": {
      await requireStaff(env, body.session, ["admin"]);
      const { date } = clinicNow(env);
      const visits = await listDocs(env, "visits", "json_extract(data, '$.date') = ?", [date]);
      const orders = await listDocs(env, "orders", "json_extract(data, '$.date') = ?", [date]);
      const appts = (await D.prepare("SELECT mode, status FROM appointments WHERE date = ?").bind(date).all()).results || [];
      const stock = await listDocs(env, "stock");
      const users = await listDocs(env, "users");
      const pc = await D.prepare("SELECT COUNT(*) AS n FROM docs WHERE coll = 'patients'").first();
      const count = (arr, f) => arr.filter(f).length;
      return json({
        date, accountsReady: await accountsReady(env),
        people: { patients: pc?.n || 0, logins: count(users, (u) => u.active !== false) },
        opd: { checkedIn: visits.length, waiting: count(visits, (v) => v.status === "waiting"), prescribed: count(visits, (v) => v.status === "sent" || v.status === "dispensed"), urgent: count(visits, (v) => v.urgent) },
        appointments: { total: count(appts, (a) => a.status !== "cancelled"), tele: count(appts, (a) => a.mode === "tele" && a.status !== "cancelled") },
        lab: { pending: count(orders, (o) => o.kind === "lab" && o.status !== "reported"), reported: count(orders, (o) => o.kind === "lab" && o.status === "reported") },
        diagnostics: { pending: count(orders, (o) => o.kind === "imaging" && o.status !== "reported"), reported: count(orders, (o) => o.kind === "imaging" && o.status === "reported") },
        pharmacy: { toDispense: count(visits, (v) => v.status === "sent"), dispensed: count(visits, (v) => v.status === "dispensed"), outOfStock: count(stock, (x) => !x.stock) },
      });
    }

    // ----- AI (OpenAI), for the doctor's tools -----
    case "/api/ai": {
      await requireStaff(env, body.session, ["doctor"]);
      const prompt = clean(body.prompt, 60000);
      if (!prompt) throw new HttpError(400, "Empty prompt");
      return json(await askOpenAI(env, prompt, !!body.json));
    }
  }
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (e) { return json({ error: e.message || "Server error" }, e.status || 500); }
  },
};

export { allSlots, makeSession, requireStaff, issueToken, clinicNow, validAadhaar, hashPassword, checkPassword };

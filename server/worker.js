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
const DEFAULT_PINS = { doctor: "1001", staff: "2002", pharmacy: "3003", lab: "4004", diagnostics: "5005", billing: "6006", admin: "9009" };
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

// ---------- subscription plans ----------
// Bronze: 1 doctor, OPD. Silver: 2–4 doctors + inpatient. Gold: 5–20 doctors, full hospital. Platinum: 21+, OT, units, branches.
// true = included, "addon" = needs the add-on switched on, false = not in the plan.
const PLANS = {
  bronze:   { name: "Bronze",   maxDoctors: 1,    maxStaff: 3,    fee: 0,     f: { lab: "addon", diagnostics: false, ip: false, ot: false, insurance: "addon", homecare: false, mobileunit: false, chat: false, reports: false, expenses: false, goals: false, templates: false, nondrug: false, purchase: false, branches: false, bookingfee: "addon" } },
  silver:   { name: "Silver",   maxDoctors: 4,    maxStaff: 10,   fee: 2000,  f: { lab: true, diagnostics: true, ip: true, ot: false, insurance: "addon", homecare: "addon", mobileunit: false, chat: true, reports: true, expenses: true, goals: false, templates: false, nondrug: true, purchase: false, branches: false, bookingfee: "addon" } },
  gold:     { name: "Gold",     maxDoctors: 20,   maxStaff: 9999, fee: 7500,  f: { lab: true, diagnostics: true, ip: true, ot: "addon", insurance: true, homecare: true, mobileunit: "addon", chat: true, reports: true, expenses: true, goals: true, templates: true, nondrug: true, purchase: true, branches: false, bookingfee: true } },
  platinum: { name: "Platinum", maxDoctors: 9999, maxStaff: 9999, fee: 20000, f: { lab: true, diagnostics: true, ip: true, ot: true, insurance: true, homecare: true, mobileunit: true, chat: true, reports: true, expenses: true, goals: true, templates: true, nondrug: true, purchase: true, branches: "addon", bookingfee: true } },
};
const FEATURE_NAMES = { lab: "Lab", diagnostics: "Diagnostics", ip: "Inpatient", ot: "Operation theatre", insurance: "Insurance desk", homecare: "Home care", mobileunit: "Mobile unit", chat: "Patient chat", reports: "Sales reports", expenses: "Expenses ledger", goals: "Sales goals", templates: "Speciality templates", nondrug: "Non-drug items", purchase: "Supplier purchases", branches: "Branches", bookingfee: "Online booking fee" };

async function planInfo(env) {
  const p = await getSetting(env, "plan", { tier: "platinum", addons: [] }); // new installs start on Platinum (trial) so every feature can be tried
  if (!p.expires) { p.expires = addDays(clinicNow(env).date, 30); p.trial = true; await setSetting(env, "plan", p); }
  const tier = PLANS[p.tier] ? p.tier : "platinum";
  const def = PLANS[tier];
  const features = {};
  for (const [k, v] of Object.entries(def.f)) features[k] = v === true || (v === "addon" && (p.addons || []).includes(k));
  return { tier, name: def.name, maxDoctors: def.maxDoctors, maxStaff: def.maxStaff, fee: def.fee, addons: p.addons || [], available: def.f, features,
    expires: p.expires, trial: !!p.trial, expired: p.expires < clinicNow(env).date };
}
async function needFeature(env, key) {
  const pl = await planInfo(env);
  if (!pl.features[key]) throw new HttpError(403, `${FEATURE_NAMES[key] || key} is not in your ${pl.name} plan. The admin can upgrade under Admin → Plan.`);
}

// ---------- documents: certificates, referral letters, timeslips ----------
const LETTER_TYPES = { certificate: "Medical certificate", fitness: "Fitness certificate", referral: "Referral letter", timeslip: "Timeslip" };

// ---------- billing ----------
// Department bills (pharmacy, lab, diagnostics, OPD) and inpatient (IP) admissions with a final bill.
// Amounts are in rupees; medicine prices are MRP (tax included); clinical services carry no GST.

const DEPTS = { pharmacy: "PH", lab: "LB", diagnostics: "DG", opd: "OP", ip: "IP" };
const DEPT_ROLES = { pharmacy: ["pharmacy"], lab: ["lab"], diagnostics: ["diagnostics"], opd: ["billing", "staff"], ip: ["billing"] };
const PAY_MODES = ["Cash", "UPI", "Card", "Insurance", "Advance", "Other"];
const money = (x) => Math.round((Number(x) || 0) * 100) / 100;

// Example prices so billing works on day one. The admin edits them under Admin → Price list.
const DEFAULT_TARIFF = [
  ["opd", "Registration", 100, "each"], ["opd", "Consultation", 500, "each"], ["opd", "Review consultation", 300, "each"],
  ["opd", "Dressing", 200, "each"], ["opd", "Injection charges", 100, "each"], ["opd", "Minor procedure", 1500, "each"],
  ["lab", "CBC", 300, "each"], ["lab", "LFT", 600, "each"], ["lab", "RFT", 600, "each"], ["lab", "RBS", 100, "each"],
  ["lab", "FBS", 100, "each"], ["lab", "PPBS", 100, "each"], ["lab", "HbA1c", 500, "each"], ["lab", "Lipid profile", 600, "each"],
  ["lab", "Thyroid profile", 600, "each"], ["lab", "TSH", 400, "each"], ["lab", "Urine routine", 150, "each"], ["lab", "Serum electrolytes", 500, "each"],
  ["lab", "Serum amylase", 500, "each"], ["lab", "Serum lipase", 700, "each"], ["lab", "PT INR", 400, "each"], ["lab", "Blood grouping", 150, "each"],
  ["lab", "HIV HBsAg HCV", 900, "each"], ["lab", "CRP", 400, "each"], ["lab", "ESR", 100, "each"],
  ["diagnostics", "USG abdomen", 1200, "each"], ["diagnostics", "USG pelvis", 1000, "each"], ["diagnostics", "USG neck", 1000, "each"],
  ["diagnostics", "Doppler", 2000, "each"], ["diagnostics", "Chest X-ray", 400, "each"], ["diagnostics", "X-ray", 400, "each"],
  ["diagnostics", "CT brain", 2500, "each"], ["diagnostics", "CECT abdomen", 6000, "each"], ["diagnostics", "HRCT chest", 4000, "each"],
  ["diagnostics", "MRI brain", 6500, "each"], ["diagnostics", "MRI spine", 7000, "each"], ["diagnostics", "MRCP", 7500, "each"],
  ["diagnostics", "PET-CT whole body", 22000, "each"], ["diagnostics", "Mammogram", 1500, "each"], ["diagnostics", "UGI endoscopy", 2500, "each"],
  ["diagnostics", "Colonoscopy", 4500, "each"], ["diagnostics", "ECG", 250, "each"], ["diagnostics", "Echo", 2000, "each"],
  ["ip", "General ward", 1500, "per day"], ["ip", "Semi-private room", 3000, "per day"], ["ip", "Private room", 5000, "per day"],
  ["ip", "ICU", 10000, "per day"], ["ip", "Nursing charges", 500, "per day"], ["ip", "Doctor visit", 500, "each"],
  ["ip", "Surgeon fee", 20000, "each"], ["ip", "Anaesthetist fee", 8000, "each"], ["ip", "OT charges", 15000, "each"],
  ["ip", "Consumables", 0, "each"], ["ip", "Oxygen", 1000, "per day"],
];

async function tariff(env, dept) {
  let list = await listDocs(env, "tariff");
  if (!list.length && !(await getSetting(env, "tariff_seeded", false))) {
    for (const [d, name, price, unit] of DEFAULT_TARIFF) await putDoc(env, "tariff", crypto.randomUUID(), { dept: d, name, price, unit });
    await setSetting(env, "tariff_seeded", true);
    list = await listDocs(env, "tariff");
  }
  return list.filter((t) => !dept || t.dept === dept).sort((a, b) => a.dept.localeCompare(b.dept) || a.name.localeCompare(b.name));
}

/** Best price-list match for a test name (word overlap). */
function matchTariff(list, name) {
  const words = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const w = words(name);
  let best = null, score = 0;
  for (const t of list) {
    const tw = words(t.name);
    const hit = tw.filter((x) => w.includes(x)).length;
    const sc = hit / Math.max(tw.length, 1) + (t.name.toLowerCase() === name.toLowerCase() ? 1 : 0);
    if (hit && sc > score) { best = t; score = sc; }
  }
  return score >= 0.5 ? best : null;
}

/** Units to dispense from a prescription line: frequency (1-0-1) × days. */
function rxQuantity(r) {
  const form = String(r.form || "").toLowerCase();
  if (/syr|susp|cream|oint|gel|drop|lotion|inhal|spray|powder|sachet/.test(form)) return 1;
  const parts = String(r.frequency || "").match(/\d+(\.\d+)?|½/g) || [];
  let perDay = parts.reduce((a, x) => a + (x === "½" ? 0.5 : Number(x)), 0);
  if (!perDay) perDay = /sos|as needed|stat/i.test(`${r.frequency} ${r.timing}`) ? 0 : 1;
  const d = String(r.duration || "").toLowerCase();
  const n = Number((d.match(/\d+/) || [0])[0]);
  const days = /month/.test(d) ? n * 30 : /week/.test(d) ? n * 7 : n;
  const doses = String(r.dose || "").match(/^\s*(\d+(\.\d+)?)/);
  const per = doses ? Number(doses[1]) : 1;
  return Math.max(1, Math.ceil(perDay * per * (days || 1)));
}

function findStock(stock, generic) {
  const g = String(generic || "").toLowerCase();
  if (!g) return null;
  return stock.find((s) => s.generic.toLowerCase() === g) || stock.find((s) => s.generic.length >= 4 && (g.includes(s.generic.toLowerCase()) || s.generic.toLowerCase().includes(g))) || null;
}

async function nextNo(env, key, prefix) {
  const r = await (await db(env)).prepare("INSERT INTO settings (k, v) VALUES (?, '1') ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1 RETURNING v").bind("seq_" + key).first();
  return `${prefix}-${String(r.v).padStart(6, "0")}`;
}

function billPatient(p) { return { id: p?.id || "", name: clean(p?.name, 60), age: clean(p?.age, 3), sex: clean(p?.sex, 10), phone: digits(p?.phone) }; }

function computeBill(b) {
  b.items = (Array.isArray(b.items) ? b.items : []).slice(0, 200).map((it) => {
    const qty = Math.max(0, Number(it.qty) || 0), rate = Math.max(0, money(it.rate));
    return { desc: clean(it.desc, 160), qty, rate, amount: money(qty * rate), unit: clean(it.unit, 20), ref: typeof it.ref === "string" ? it.ref.slice(0, 64) : "" };
  }).filter((it) => it.desc && it.qty > 0);
  b.subtotal = money(b.items.reduce((a, it) => a + it.amount, 0));
  b.discount = Math.min(b.subtotal, Math.max(0, money(b.discount)));
  b.total = money(b.subtotal - b.discount);
  b.paid = money((b.payments || []).reduce((a, x) => a + x.amount, 0));
  b.balance = money(b.total - b.paid);
  if (b.status !== "cancelled" && b.status !== "to-ip" && b.status !== "on-ip-bill") b.status = b.total > 0 && b.paid >= b.total ? "paid" : b.paid > 0 ? "partial" : "unpaid";
  return b;
}

/** Pharmacy: keeps stock in step with what a bill dispenses. */
async function applyStock(env, bill, restore = false) {
  const want = {};
  if (!restore) for (const it of bill.items) if (it.ref) want[it.ref] = (want[it.ref] || 0) + it.qty;
  const had = bill.stockApplied || {};
  for (const ref of new Set([...Object.keys(want), ...Object.keys(had)])) {
    const delta = (want[ref] || 0) - (had[ref] || 0);
    if (!delta) continue;
    const s = await getDoc(env, "stock", ref);
    if (!s) continue;
    s.stock = Math.max(0, (Number(s.stock) || 0) - delta);
    await putDoc(env, "stock", ref, s);
  }
  bill.stockApplied = want;
}

function canDept(role, dept) { return role === "admin" || (DEPT_ROLES[dept] || []).includes(role); }

function payment(x, by) {
  const amount = money(x?.amount);
  if (amount <= 0) return null;
  const mode = PAY_MODES.includes(x.mode) ? x.mode : "Cash";
  return { amount, mode, ref: clean(x.ref, 60), at: Date.now(), by };
}

async function activeAdmission(env, pid) {
  if (!pid) return null;
  return (await listDocs(env, "admissions", "json_extract(data, '$.patient.id') = ? AND json_extract(data, '$.status') = 'admitted'", [pid]))[0] || null;
}

/** Live inpatient account: room days, charges, department bills sent to IP, advances. */
async function ipAccount(env, a) {
  const end = a.dischargedAt || Date.now();
  const days = Math.max(1, Math.ceil((end - a.admittedAt) / 86400000));
  const lines = [];
  if (a.wardRate > 0) lines.push({ desc: `${a.ward} (${days} day${days > 1 ? "s" : ""})`, qty: days, rate: a.wardRate, amount: money(days * a.wardRate), kind: "room" });
  for (const c of a.charges || []) lines.push(Object.assign({ kind: "charge" }, c));
  const deptBills = (await listDocs(env, "bills", "json_extract(data, '$.admissionId') = ?", [a.id])).filter((b) => b.status === "to-ip" || b.status === "on-ip-bill");
  for (const b of deptBills) lines.push({ desc: `${b.deptName} bill ${b.no}`, qty: 1, rate: b.total, amount: b.total, kind: "bill", billId: b.id });
  const total = money(lines.reduce((x, l) => x + l.amount, 0));
  const advance = money((a.deposits || []).reduce((x, d) => x + d.amount, 0));
  return { days, lines, total, advance, due: money(total - advance) };
}

const DEPT_NAMES = { pharmacy: "Pharmacy", lab: "Lab", diagnostics: "Diagnostics", opd: "OPD", ip: "Inpatient" };

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
    if (path === "/login" || path === "/portal" || path === "/terms") {
      const page = path === "/login" ? loginPage : path === "/portal" ? portalPage : termsPage;
      return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (path === "/api/license") {
      const pl = await planInfo(env), c = await clinicInfo(env);
      return json({ licensedTo: c.name, address: c.address, plan: pl.name, expires: pl.expires, trial: pl.trial, expired: pl.expired });
    }
    if (path === "/book") return new Response(bookingPage(await clinicInfo(env)), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
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
      if (active && (isNew || u.role !== role || u.active === false) && role !== "admin") {
        const pl = await planInfo(env);
        const others = (await listDocs(env, "users")).filter((o) => o.active !== false && o.id !== id);
        if (role === "doctor" && others.filter((o) => o.role === "doctor").length >= pl.maxDoctors)
          throw new HttpError(409, `Your ${pl.name} plan allows ${pl.maxDoctors} doctor login${pl.maxDoctors > 1 ? "s" : ""}. Upgrade under Admin → Plan, or disable another doctor login.`);
        if (role !== "doctor" && others.filter((o) => o.role !== "doctor" && o.role !== "admin").length >= pl.maxStaff)
          throw new HttpError(409, `Your ${pl.name} plan allows ${pl.maxStaff} staff logins. Upgrade under Admin → Plan.`);
        if (["lab", "diagnostics"].includes(role) && !pl.features[role]) throw new HttpError(409, `${FEATURE_NAMES[role]} is not in your ${pl.name} plan`);
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
      const who = await requireStaff(env, body.session, ["doctor", "staff", "pharmacy", "lab", "diagnostics", "billing"]);
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
      const bills = (await listDocs(env, "bills", "json_extract(data, '$.patient.id') = ?", [s.uid])).filter((b) => b.status !== "cancelled")
        .sort((a, b) => b.created - a.created).slice(0, 50).map((b) => ({ id: b.id, no: b.no, dept: b.dept, deptName: b.deptName, date: b.date, total: b.total, paid: b.paid, balance: b.balance, status: b.status, items: b.items.map((i) => ({ desc: i.desc, qty: i.qty, amount: i.amount })) }));
      return json({ patient: publicPatient(s.uid, s.user), visits: await patientHistory(env, s.uid), appointments: appts.map(publicAppt), bills });
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
      const me = await requireUser(env, body.session, ["staff", "doctor", "billing"]);
      try {
        const r = await createPatient(env, body, me.user.username || me.role, body.password ? body.password : "");
        return json({ patient: publicPatient(r.id, r.p) });
      } catch (e) {
        if (e.existing) throw new HttpError(409, `This Aadhaar number is already registered as ${e.existing}`);
        throw e;
      }
    }

    case "/api/patients/search": {
      await requireUser(env, body.session, ["staff", "doctor", "pharmacy", "lab", "diagnostics", "billing"]);
      const q = String(body.q || "").trim();
      let list = [];
      if (q.length >= 2) {
        list = await patientsForLogin(env, q);
        if (!list.length && !/\d/.test(q)) list = await listDocs(env, "patients", "lower(json_extract(data, '$.name')) LIKE ?", [q.toLowerCase().replace(/[%_]/g, "") + "%"]);
      }
      return json({ patients: list.slice(0, 30).map((p) => publicPatient(p.id, p)) });
    }

    case "/api/patients/get": {
      await requireUser(env, body.session, ["staff", "doctor", "billing"]);
      const id = String(body.id || "").toUpperCase();
      const p = await getDoc(env, "patients", id);
      if (!p) throw new HttpError(404, "Patient not found");
      return json({ patient: publicPatient(id, p), visits: await patientHistory(env, id) });
    }

    case "/api/patients/update": {
      await requireUser(env, body.session, ["staff", "doctor", "billing"]);
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
      // Emergency queue first, then by token.
      const list = rows.map((r) => visitSummary(r.id, JSON.parse(r.data))).sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || (a.token || 0) - (b.token || 0));
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
        await putDoc(env, "stock", id, { generic, brand: clean(it.brand, 80), form: clean(it.form, 20) || "Tab", strength: clean(it.strength, 40), stock: Math.max(0, Math.floor(Number(it.stock) || 0)), price: Math.max(0, money(it.price)) });
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
        .map((v) => ({ id: v.id, token: v.token, date: v.date, status: v.status, patient: v.patient, rx: v.rx, dispensedAt: v.dispensedAt || null, billId: v.pharmacyBillId || "" }))
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
      if (typeof body.urgent === "boolean") v.urgent = body.urgent;
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
        billing: await (async () => {
          const bills = (await listDocs(env, "bills", "json_extract(data, '$.date') = ?", [date])).filter((b) => b.status !== "cancelled" && b.status !== "to-ip" && b.status !== "on-ip-bill");
          const sum = (f) => money(bills.filter(f).reduce((x, b) => x + b.total, 0));
          const paid = money(bills.reduce((x, b) => x + (b.payments || []).filter((p) => p.mode !== "Advance").reduce((y, p) => y + p.amount, 0), 0));
          const inpatients = (await listDocs(env, "admissions", "json_extract(data, '$.status') = 'admitted'")).length;
          return { billed: sum(() => true), collected: paid, pharmacy: sum((b) => b.dept === "pharmacy"), lab: sum((b) => b.dept === "lab"), diagnostics: sum((b) => b.dept === "diagnostics"), opd: sum((b) => b.dept === "opd"), ip: sum((b) => b.dept === "ip"), inpatients };
        })(),
        pharmacy: { toDispense: count(visits, (v) => v.status === "sent"), dispensed: count(visits, (v) => v.status === "dispensed"), outOfStock: count(stock, (x) => !x.stock) },
      });
    }

    // ----- plan -----
    case "/api/plan": {
      await readSession(env, body.session);
      const pl = await planInfo(env);
      const users = (await listDocs(env, "users")).filter((u) => u.active !== false);
      return json({ plan: pl, usage: { doctors: users.filter((u) => u.role === "doctor").length, staff: users.filter((u) => u.role !== "doctor" && u.role !== "admin").length }, plans: Object.fromEntries(Object.entries(PLANS).map(([k, v]) => [k, { name: v.name, maxDoctors: v.maxDoctors, maxStaff: v.maxStaff, fee: v.fee, f: v.f }])), featureNames: FEATURE_NAMES });
    }

    case "/api/plan/set": {
      await requireUser(env, body.session, ["admin"]);
      const tier = String(body.tier || "");
      if (!PLANS[tier]) throw new HttpError(400, "Choose a plan");
      const users = (await listDocs(env, "users")).filter((u) => u.active !== false);
      const docs = users.filter((u) => u.role === "doctor").length;
      if (docs > PLANS[tier].maxDoctors) throw new HttpError(409, `${PLANS[tier].name} allows ${PLANS[tier].maxDoctors} doctor login${PLANS[tier].maxDoctors > 1 ? "s" : ""}; you have ${docs} active. Disable some first, or choose a bigger plan.`);
      const addons = (Array.isArray(body.addons) ? body.addons : []).filter((a) => PLANS[tier].f[a] === "addon");
      const old = await getSetting(env, "plan", {});
      const expires = /^\d{4}-\d{2}-\d{2}$/.test(body.expires || "") ? body.expires : old.expires;
      await setSetting(env, "plan", { tier, addons, expires, trial: body.expires ? false : !!old.trial, changedAt: Date.now() });
      return json({ plan: await planInfo(env) });
    }

    // ----- letters and certificates -----
    case "/api/letters/save": {
      const x = body.letter || {};
      const type = String(x.type || "");
      if (!LETTER_TYPES[type]) throw new HttpError(400, "Choose the document type");
      const me = await requireUser(env, body.session, type === "timeslip" ? ["doctor", "staff", "billing"] : ["doctor"]);
      let patient = billPatient(x.patient || {});
      if (x.patientId) {
        const p = await getDoc(env, "patients", String(x.patientId).toUpperCase());
        if (p) patient = billPatient(Object.assign({ id: String(x.patientId).toUpperCase() }, p));
      }
      if (!patient.name) throw new HttpError(400, "Choose the patient");
      const fields = {};
      for (const [k, v] of Object.entries(x.fields || {}).slice(0, 30)) fields[clean(k, 40)] = clean(v, 3000);
      const id = crypto.randomUUID();
      const doc = {
        type, title: LETTER_TYPES[type], no: await nextNo(env, "letter", "DOC"), patient, visitId: clean(x.visitId, 64), fields,
        doctor: { name: me.user.name || "", qual: me.user.qual || "", reg: me.user.reg || "" }, created: Date.now(), date: clinicNow(env).date,
      };
      await putDoc(env, "letters", id, doc);
      return json({ letter: Object.assign({ id }, doc) });
    }

    case "/api/letters/list": {
      await requireUser(env, body.session, ["doctor", "staff", "billing"]);
      const list = body.patientId
        ? await listDocs(env, "letters", "json_extract(data, '$.patient.id') = ?", [String(body.patientId).toUpperCase()])
        : await listDocs(env, "letters", "json_extract(data, '$.date') >= ?", [addDays(clinicNow(env).date, -30)]);
      return json({ letters: list.sort((a, b) => b.created - a.created).slice(0, 200) });
    }

    // ----- follow-ups (review dates) and call-backs -----
    case "/api/followups": {
      await requireUser(env, body.session, ["doctor", "staff", "billing"]);
      const today = clinicNow(env).date;
      const from = String(body.from || addDays(today, -30)), to = String(body.to || addDays(today, 7));
      const visits = await listDocs(env, "visits", "json_extract(data, '$.rx.review') >= ? AND json_extract(data, '$.rx.review') <= ?", [from, to]);
      const out = [];
      for (const v of visits) {
        const pid = v.patient?.id;
        // Came back already? Any later visit by the same patient on or after the review date minus 3 days.
        let came = false;
        if (pid) came = (await listDocs(env, "visits", "json_extract(data, '$.patient.id') = ? AND json_extract(data, '$.date') > ?", [pid, v.date])).length > 0;
        out.push({ visitId: v.id, patient: v.patient, review: v.rx.review, reviewNote: v.rx.reviewNote || "", dx: v.rx.dx || "", visitDate: v.date,
          doctor: v.doctor?.name || "", follow: v.follow || { status: came ? "came" : "due" }, came });
      }
      out.sort((a, b) => a.review.localeCompare(b.review));
      return json({ today, followups: out });
    }

    case "/api/followups/update": {
      const me = await requireUser(env, body.session, ["doctor", "staff", "billing"]);
      const id = String(body.visitId || "");
      const v = await getDoc(env, "visits", id);
      if (!v) throw new HttpError(404, "Visit not found");
      const status = ["due", "called", "no-answer", "booked", "came", "not-coming"].includes(body.status) ? body.status : "called";
      const log = (v.follow?.log || []).concat([{ status, note: clean(body.note, 300), by: me.user.name || me.role, at: Date.now() }]).slice(-20);
      v.follow = { status, note: clean(body.note, 300), log };
      await putDoc(env, "visits", id, v);
      return json({ ok: true, follow: v.follow });
    }

    case "/api/callbacks/list": {
      await requireUser(env, body.session, ["doctor", "staff", "billing"]);
      const status = body.status === "done" ? "done" : "open";
      const list = await listDocs(env, "callbacks", "json_extract(data, '$.status') = ?", [status]);
      return json({ callbacks: list.sort((a, b) => (a.due || "").localeCompare(b.due || "") || b.created - a.created).slice(0, 300) });
    }

    case "/api/callbacks/save": {
      const me = await requireUser(env, body.session, ["doctor", "staff", "billing"]);
      const x = body.callback || {};
      const id = x.id ? String(x.id) : crypto.randomUUID();
      const c = x.id ? await getDoc(env, "callbacks", id) : { created: Date.now(), createdBy: me.user.name || me.role, notes: [], status: "open" };
      if (!c) throw new HttpError(404, "Call-back not found");
      if (!x.id) {
        let patient = billPatient(x.patient || {});
        if (x.patientId) { const p = await getDoc(env, "patients", String(x.patientId).toUpperCase()); if (p) patient = billPatient(Object.assign({ id: String(x.patientId).toUpperCase() }, p)); }
        if (!patient.name || !patient.phone) throw new HttpError(400, "Enter the name and mobile number");
        c.patient = patient;
      }
      if ("reason" in x) c.reason = clean(x.reason, 300);
      if ("due" in x) c.due = /^\d{4}-\d{2}-\d{2}$/.test(x.due) ? x.due : clinicNow(env).date;
      if (x.note) c.notes = (c.notes || []).concat([{ text: clean(x.note, 300), by: me.user.name || me.role, at: Date.now() }]).slice(-30);
      if (x.status === "done" || x.status === "open") c.status = x.status;
      await putDoc(env, "callbacks", id, c);
      return json({ callback: Object.assign({ id }, c) });
    }

    // ----- billing: price list -----
    case "/api/tariff/list": {
      await requireUser(env, body.session, ["doctor", "staff", "pharmacy", "lab", "diagnostics", "billing"]);
      return json({ tariff: await tariff(env, DEPTS[body.dept] ? body.dept : "") });
    }

    case "/api/tariff/save": {
      await requireUser(env, body.session, ["admin"]);
      const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [body.item || {}];
      let n = 0;
      for (const it of items) {
        const name = clean(it.name, 100);
        if (!name || !DEPTS[it.dept] || it.dept === "pharmacy") continue;
        const id = typeof it.id === "string" && ID_RE.test(it.id) ? it.id : crypto.randomUUID();
        await putDoc(env, "tariff", id, { dept: it.dept, name, price: Math.max(0, money(it.price)), unit: it.unit === "per day" ? "per day" : "each" });
        n++;
      }
      await setSetting(env, "tariff_seeded", true);
      return json({ saved: n });
    }

    case "/api/tariff/delete": {
      await requireUser(env, body.session, ["admin"]);
      await D.prepare("DELETE FROM docs WHERE coll = 'tariff' AND id = ?").bind(String(body.id || "")).run();
      return json({ ok: true });
    }

    // ----- billing: department bills -----
    case "/api/bills/draft": {
      // Pre-filled bill for a visit: medicines from the prescription, or unbilled tests, or OPD charges.
      const dept = String(body.dept || "");
      if (!DEPTS[dept] || dept === "ip") throw new HttpError(400, "Unknown department");
      const me = await requireUser(env, body.session, DEPT_ROLES[dept]);
      if (!canDept(me.role, dept)) throw new HttpError(403, "Your login can't bill for this department");
      const v = body.visitId ? await getDoc(env, "visits", String(body.visitId)) : null;
      let patient = billPatient(v?.patient || {});
      if (!v && body.patientId) {
        const p = await getDoc(env, "patients", String(body.patientId).toUpperCase());
        if (p) patient = billPatient(Object.assign({ id: String(body.patientId).toUpperCase() }, p));
      }
      const items = [], orderIds = [];
      if (dept === "pharmacy" && v?.rx) {
        const stock = await listDocs(env, "stock");
        for (const r of v.rx.items || []) {
          const s = findStock(stock, r.generic);
          items.push({ desc: [r.form, r.generic, r.strength].filter(Boolean).join(" "), qty: rxQuantity(r), rate: s ? money(s.price) : 0, ref: s ? s.id : "", unit: "", inStock: s ? s.stock : 0 });
        }
      } else if ((dept === "lab" || dept === "diagnostics") && v) {
        const kind = dept === "lab" ? "lab" : "imaging";
        const list = await tariff(env, dept);
        for (const o of await listDocs(env, "orders", "json_extract(data, '$.visitId') = ?", [String(body.visitId)])) {
          if (o.kind !== kind || o.billId) continue;
          const t = matchTariff(list, o.test);
          items.push({ desc: o.test, qty: 1, rate: t ? t.price : 0, ref: "" });
          orderIds.push(o.id);
        }
      } else if (dept === "opd") {
        const list = await tariff(env, "opd");
        const first = patient.id ? (await listDocs(env, "visits", "json_extract(data, '$.patient.id') = ?", [patient.id])).length <= 1 : true;
        const pick = (n) => list.find((t) => t.name.toLowerCase() === n.toLowerCase());
        for (const n of first ? ["Registration", "Consultation"] : ["Review consultation"]) { const t = pick(n); if (t) items.push({ desc: t.name, qty: 1, rate: t.price, ref: "" }); }
      }
      const adm = await activeAdmission(env, patient.id);
      return json({ dept, patient, visitId: v ? String(body.visitId) : "", items, orderIds, admission: adm ? { id: adm.id, no: adm.no, ward: adm.ward, bed: adm.bed } : null });
    }

    case "/api/bills/save": {
      const x = body.bill || {};
      const dept = String(x.dept || "");
      if (!DEPTS[dept] || dept === "ip") throw new HttpError(400, "Unknown department");
      const me = await requireUser(env, body.session, DEPT_ROLES[dept]);
      if (!canDept(me.role, dept)) throw new HttpError(403, "Your login can't bill for this department");
      if (dept === "lab" || dept === "diagnostics") await needFeature(env, dept);
      const isNew = !x.id;
      const id = isNew ? crypto.randomUUID() : String(x.id);
      const b = isNew ? { dept, deptName: DEPT_NAMES[dept], payments: [], created: Date.now(), createdBy: me.user.name || me.role, date: clinicNow(env).date } : await getDoc(env, "bills", id);
      if (!b) throw new HttpError(404, "Bill not found");
      if (!isNew && (b.status === "cancelled" || b.status === "on-ip-bill" || (b.paid > 0 && me.role !== "admin"))) throw new HttpError(409, "This bill can't be changed now. Cancel it and make a new one.");
      if (isNew) b.no = await nextNo(env, dept, DEPTS[dept]);
      b.patient = billPatient(x.patient || b.patient);
      if (!b.patient.name) throw new HttpError(400, "Enter the patient's name");
      b.visitId = clean(x.visitId ?? b.visitId, 64);
      b.items = x.items; b.discount = x.discount; b.note = clean(x.note, 300);
      // Admitted patient: the bill can go on the inpatient account instead of being paid now.
      if (x.toIp) {
        const adm = await activeAdmission(env, b.patient.id);
        if (!adm) throw new HttpError(400, "This patient is not admitted");
        b.admissionId = adm.id; b.status = "to-ip";
      } else if (b.status === "to-ip") { b.status = "unpaid"; b.admissionId = ""; }
      computeBill(b);
      if (!b.items.length) throw new HttpError(400, "Add at least one item");
      const pay = b.status === "to-ip" ? null : payment(body.pay, me.user.name || me.role);
      if (pay && pay.amount > b.balance + 0.001) throw new HttpError(400, `The bill is ₹${b.balance}. Enter the amount received, up to ₹${b.balance}.`);
      if (pay) { b.payments.push(pay); computeBill(b); }
      if (dept === "pharmacy") await applyStock(env, b);
      await putDoc(env, "bills", id, b);
      for (const oid of Array.isArray(x.orderIds) ? x.orderIds.slice(0, 50) : []) {
        const o = await getDoc(env, "orders", String(oid));
        if (o && !o.billId) { o.billId = id; await putDoc(env, "orders", String(oid), o); }
      }
      if (dept === "pharmacy" && b.visitId) {
        const v = await getDoc(env, "visits", b.visitId);
        if (v) { v.pharmacyBillId = id; if (body.dispense) { v.status = "dispensed"; v.dispensedAt = Date.now(); } await putDoc(env, "visits", b.visitId, v); }
      }
      return json({ bill: Object.assign({ id }, b) });
    }

    case "/api/bills/pay": {
      const id = String(body.id || "");
      const b = await getDoc(env, "bills", id);
      if (!b) throw new HttpError(404, "Bill not found");
      const me = await requireUser(env, body.session, [...DEPT_ROLES[b.dept], "billing"]);
      if (b.status === "cancelled" || b.status === "to-ip" || b.status === "on-ip-bill") throw new HttpError(409, "This bill is not collected at the counter");
      const pay = payment(body, me.user.name || me.role);
      if (!pay) throw new HttpError(400, "Enter the amount received");
      if (pay.amount > b.balance + 0.001) throw new HttpError(400, `Only ₹${b.balance} is due on this bill`);
      b.payments.push(pay); computeBill(b);
      await putDoc(env, "bills", id, b);
      return json({ bill: Object.assign({ id }, b) });
    }

    case "/api/bills/cancel": {
      const id = String(body.id || "");
      const b = await getDoc(env, "bills", id);
      if (!b) throw new HttpError(404, "Bill not found");
      const me = await requireUser(env, body.session, DEPT_ROLES[b.dept]);
      if (b.status === "on-ip-bill") throw new HttpError(409, "This bill is already on a final inpatient bill");
      if (b.paid > 0 && me.role !== "admin") throw new HttpError(403, "Money was received on this bill. Only the admin can cancel it.");
      if (b.dept === "pharmacy") await applyStock(env, b, true);
      b.status = "cancelled"; b.cancelReason = clean(body.reason, 200); b.cancelledBy = me.user.name || me.role; b.cancelledAt = Date.now();
      await putDoc(env, "bills", id, b);
      for (const o of await listDocs(env, "orders", "json_extract(data, '$.billId') = ?", [id])) { delete o.billId; await putDoc(env, "orders", o.id, o); }
      return json({ ok: true });
    }

    case "/api/bills/list": {
      const me = await requireUser(env, body.session, ["pharmacy", "lab", "diagnostics", "billing", "staff"]);
      const conds = [], args = [];
      let dept = String(body.dept || "");
      if (["pharmacy", "lab", "diagnostics"].includes(me.role)) dept = me.role;
      if (dept) { conds.push("json_extract(data, '$.dept') = ?"); args.push(dept); }
      if (body.patientId) { conds.push("json_extract(data, '$.patient.id') = ?"); args.push(String(body.patientId).toUpperCase()); }
      else if (body.from || body.date) {
        conds.push("json_extract(data, '$.date') >= ? AND json_extract(data, '$.date') <= ?");
        args.push(String(body.from || body.date), String(body.to || body.date));
      } else { conds.push("json_extract(data, '$.date') >= ?"); args.push(addDays(clinicNow(env).date, -2)); }
      const list = (await listDocs(env, "bills", conds.join(" AND "), args)).sort((a, b) => b.created - a.created).slice(0, 300);
      return json({ bills: list });
    }

    case "/api/bills/patient": {
      // Hospital total for one patient: every department bill and inpatient stay.
      await requireUser(env, body.session, ["billing", "staff"]);
      const pid = String(body.patientId || "").toUpperCase();
      const p = await getDoc(env, "patients", pid);
      if (!p) throw new HttpError(404, "Patient not found");
      const bills = (await listDocs(env, "bills", "json_extract(data, '$.patient.id') = ?", [pid])).filter((b) => b.status !== "cancelled").sort((a, b) => b.created - a.created);
      const admissions = (await listDocs(env, "admissions", "json_extract(data, '$.patient.id') = ?", [pid])).sort((a, b) => b.admittedAt - a.admittedAt);
      const byDept = {};
      for (const d of Object.keys(DEPTS)) byDept[d] = { billed: 0, paid: 0, due: 0, count: 0 };
      for (const b of bills) {
        if (b.status === "to-ip" || b.status === "on-ip-bill") continue; // counted in the inpatient bill
        const t = byDept[b.dept]; t.billed = money(t.billed + b.total); t.paid = money(t.paid + b.paid); t.due = money(t.due + b.balance); t.count++;
      }
      const running = [];
      for (const a of admissions) if (a.status === "admitted") {
        const acc = await ipAccount(env, a);
        running.push({ id: a.id, no: a.no, total: acc.total, advance: acc.advance, due: acc.due });
        const t = byDept.ip; t.billed = money(t.billed + acc.total); t.paid = money(t.paid + acc.advance); t.due = money(t.due + acc.due); t.count++;
      }
      const total = Object.values(byDept).reduce((x, t) => ({ billed: money(x.billed + t.billed), paid: money(x.paid + t.paid), due: money(x.due + t.due) }), { billed: 0, paid: 0, due: 0 });
      return json({ patient: publicPatient(pid, p), byDept, total, bills, admissions: admissions.map((a) => ({ id: a.id, no: a.no, status: a.status, ward: a.ward, bed: a.bed, admittedAt: a.admittedAt, dischargedAt: a.dischargedAt || 0 })), running });
    }

    case "/api/bills/summary": {
      await requireUser(env, body.session, ["billing"]);
      const from = String(body.from || clinicNow(env).date), to = String(body.to || from);
      const bills = (await listDocs(env, "bills", "json_extract(data, '$.date') >= ? AND json_extract(data, '$.date') <= ?", [from, to])).filter((b) => b.status !== "cancelled");
      const byDept = {}, byMode = {};
      for (const d of Object.keys(DEPTS)) byDept[d] = { billed: 0, collected: 0, count: 0 };
      for (const b of bills) {
        const t = byDept[b.dept];
        if (b.status !== "to-ip" && b.status !== "on-ip-bill") { t.billed = money(t.billed + b.total); t.count++; }
      }
      // Money received in the period, by the day it was received
      const start = Date.parse(from + "T00:00:00Z") - Number(env.CLINIC_TZ_MINUTES ?? 330) * 60000, endT = start + (Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1) * 86400000;
      const recent = await listDocs(env, "bills", "json_extract(data, '$.date') >= ?", [addDays(from, -120)]);
      for (const b of recent) for (const pmt of b.payments || []) if (pmt.at >= start && pmt.at < endT && pmt.mode !== "Advance" && b.status !== "cancelled") {
        byDept[b.dept].collected = money(byDept[b.dept].collected + pmt.amount); byMode[pmt.mode] = money((byMode[pmt.mode] || 0) + pmt.amount);
      }
      for (const a of await listDocs(env, "admissions", "json_extract(data, '$.admittedAt') >= ?", [Date.now() - 400 * 86400000])) for (const d of a.deposits || []) if (d.at >= start && d.at < endT) {
        byDept.ip.collected = money(byDept.ip.collected + d.amount); byMode[d.mode] = money((byMode[d.mode] || 0) + d.amount);
      }
      const totals = Object.values(byDept).reduce((x, t) => ({ billed: money(x.billed + t.billed), collected: money(x.collected + t.collected) }), { billed: 0, collected: 0 });
      return json({ from, to, byDept, byMode, totals });
    }

    // ----- inpatients -----
    case "/api/ip/admit": {
      const me = await requireUser(env, body.session, ["billing", "staff", "doctor"]);
      await needFeature(env, "ip");
      const pid = String(body.patientId || "").toUpperCase();
      const p = await getDoc(env, "patients", pid);
      if (!p) throw new HttpError(404, "Find or register the patient first");
      if (await activeAdmission(env, pid)) throw new HttpError(409, "This patient is already admitted");
      const wards = await tariff(env, "ip");
      const w = wards.find((t) => t.name === body.ward && t.unit === "per day");
      const a = {
        no: await nextNo(env, "ipd", "IPD"), patient: billPatient(Object.assign({ id: pid }, p)), ward: w ? w.name : clean(body.ward, 60) || "General ward",
        wardRate: w ? w.price : Math.max(0, money(body.wardRate)), bed: clean(body.bed, 20), doctor: clean(body.doctor, 80), reason: clean(body.reason, 300),
        admittedAt: Date.now(), admittedBy: me.user.name || me.role, status: "admitted", charges: [], deposits: [],
      };
      const dep = payment(body.deposit, me.user.name || me.role);
      if (dep) a.deposits.push(dep);
      const id = crypto.randomUUID();
      await putDoc(env, "admissions", id, a);
      return json({ admission: Object.assign({ id }, a) });
    }

    case "/api/ip/list": {
      await requireUser(env, body.session, ["billing", "staff", "doctor", "pharmacy", "lab", "diagnostics"]);
      const status = body.status === "discharged" ? "discharged" : "admitted";
      let list = await listDocs(env, "admissions", "json_extract(data, '$.status') = ?", [status]);
      list = list.sort((a, b) => (status === "admitted" ? a.admittedAt - b.admittedAt : b.dischargedAt - a.dischargedAt)).slice(0, 100);
      const out = [];
      for (const a of list) { const acc = await ipAccount(env, a); out.push({ id: a.id, no: a.no, patient: a.patient, ward: a.ward, bed: a.bed, doctor: a.doctor, admittedAt: a.admittedAt, dischargedAt: a.dischargedAt || 0, status: a.status, days: acc.days, total: acc.total, advance: acc.advance, due: acc.due }); }
      return json({ admissions: out });
    }

    case "/api/ip/get": {
      await requireUser(env, body.session, ["billing", "staff", "doctor"]);
      const id = String(body.id || "");
      const a = await getDoc(env, "admissions", id);
      if (!a) throw new HttpError(404, "Admission not found");
      a.id = id;
      return json({ admission: a, account: await ipAccount(env, a), finalBill: a.finalBillId ? Object.assign({ id: a.finalBillId }, await getDoc(env, "bills", a.finalBillId)) : null });
    }

    case "/api/ip/update": {
      // Charges, advances, ward or bed change on an admitted patient.
      const me = await requireUser(env, body.session, ["billing", "staff"]);
      const id = String(body.id || "");
      const a = await getDoc(env, "admissions", id);
      if (!a) throw new HttpError(404, "Admission not found");
      if (a.status !== "admitted") throw new HttpError(409, "This patient is already discharged");
      a.id = id;
      const by = me.user.name || me.role;
      if (body.charge) {
        const c = body.charge, qty = Math.max(0, Number(c.qty) || 1), rate = Math.max(0, money(c.rate));
        if (!clean(c.desc, 160)) throw new HttpError(400, "Enter what the charge is for");
        a.charges.push({ id: randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 8), desc: clean(c.desc, 160), qty, rate, amount: money(qty * rate), date: clinicNow(env).date, by });
      }
      if (body.removeCharge) {
        if (me.role !== "billing" && me.role !== "admin") throw new HttpError(403, "Only billing can remove a charge");
        a.charges = a.charges.filter((c) => c.id !== body.removeCharge);
      }
      if (body.deposit) {
        if (me.role !== "billing" && me.role !== "admin") throw new HttpError(403, "Only billing can take an advance");
        const d = payment(body.deposit, by); if (!d) throw new HttpError(400, "Enter the amount"); a.deposits.push(d);
      }
      if (body.bed !== undefined) a.bed = clean(body.bed, 20);
      if (body.ward) {
        const w = (await tariff(env, "ip")).find((t) => t.name === body.ward && t.unit === "per day");
        if (w) {
          // Bill the days so far at the old rate, then continue at the new one.
          const acc = await ipAccount(env, a);
          if (a.wardRate > 0) a.charges.push({ id: randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 8), desc: `${a.ward} (${acc.days} day${acc.days > 1 ? "s" : ""}, before transfer)`, qty: acc.days, rate: a.wardRate, amount: money(acc.days * a.wardRate), date: clinicNow(env).date, by });
          a.ward = w.name; a.wardRate = w.price; a.admittedAt = Date.now();
          a.transfers = (a.transfers || []).concat([{ to: w.name, at: Date.now(), by }]);
        }
      }
      delete a.id;
      await putDoc(env, "admissions", id, a);
      a.id = id;
      return json({ admission: a, account: await ipAccount(env, a) });
    }

    case "/api/ip/discharge": {
      // Final inpatient bill: room days, charges, department bills sent to IP, advances, discount, balance paid.
      const me = await requireUser(env, body.session, ["billing"]);
      const id = String(body.id || "");
      const a = await getDoc(env, "admissions", id);
      if (!a) throw new HttpError(404, "Admission not found");
      if (a.status !== "admitted") throw new HttpError(409, "Already discharged");
      a.id = id;
      a.dischargedAt = Date.now();
      const acc = await ipAccount(env, a);
      const by = me.user.name || me.role;
      const b = {
        dept: "ip", deptName: "Inpatient", no: await nextNo(env, "ip", "IP"), patient: a.patient, admissionId: id, admissionNo: a.no,
        items: acc.lines.map((l) => ({ desc: l.desc, qty: l.qty, rate: l.rate, ref: l.billId || "" })), discount: body.discount, note: clean(body.note, 300),
        payments: (a.deposits || []).map((d) => ({ amount: d.amount, mode: "Advance", ref: d.mode, at: d.at, by: d.by })),
        created: Date.now(), createdBy: by, date: clinicNow(env).date, admittedAt: a.admittedAt, dischargedAt: a.dischargedAt, ward: a.ward, bed: a.bed, doctor: a.doctor,
      };
      computeBill(b);
      const pay = payment(body.pay, by);
      if (pay && pay.amount > b.balance + 0.001) throw new HttpError(400, b.balance > 0 ? `Only ₹${b.balance} is due after the advance` : "Nothing is due: the advance covers the bill");
      if (pay) { b.payments.push(pay); computeBill(b); }
      const billId = crypto.randomUUID();
      await putDoc(env, "bills", billId, b);
      for (const l of acc.lines) if (l.billId) { const db2 = await getDoc(env, "bills", l.billId); if (db2) { db2.status = "on-ip-bill"; db2.ipBillId = billId; await putDoc(env, "bills", l.billId, db2); } }
      a.status = "discharged"; a.finalBillId = billId; a.dischargedBy = by;
      delete a.id;
      await putDoc(env, "admissions", id, a);
      return json({ bill: Object.assign({ id: billId }, b) });
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


// Booking page opened from the clinic QR code. Plain HTML, no app needed.
function bookingPage(c) {
  const esc = (x) => String(x || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Book an appointment · ${esc(c.name)}</title>
<style>
:root{--bg:#f4f7f6;--card:#fff;--fg:#14201f;--muted:#5a6b68;--line:#d6e0dd;--teal:#0e6a64;--soft:#dfeeeb;--red:#b3261e}
@media(prefers-color-scheme:dark){:root{--bg:#0f1716;--card:#172221;--fg:#e6efed;--muted:#9db0ac;--line:#2a3a38;--teal:#5fc2b8;--soft:#1d3633;--red:#f2867f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px max(16px,env(safe-area-inset-left))}
main{max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:14px}h1{font:600 26px Georgia,serif;margin:0}.rx{color:var(--red)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:10px}
label{font-size:13px;color:var(--muted);display:flex;flex-direction:column;gap:4px}input,select,textarea{font:inherit;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg)}
.row{display:flex;gap:8px}.row>*{flex:1}.slots{display:flex;flex-wrap:wrap;gap:6px}.slots button{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:6px 12px;font:inherit;font-size:14px}
.slots button[aria-pressed=true]{background:var(--teal);color:#fff;border-color:var(--teal)}.slots button:disabled{opacity:.35}
.go{background:var(--teal);color:#fff;border:0;border-radius:999px;padding:13px;font:600 16px system-ui}.go:disabled{opacity:.5}.err{color:var(--red)}.ok{font-size:15px}.code{font:700 34px ui-monospace,monospace;color:var(--teal)}.muted{color:var(--muted);font-size:14px}
</style></head><body><main>
<div><h1><span class="rx">℞</span> ${esc(c.name || "Rx Clinic")}</h1><div class="muted">${esc(c.doctor)} ${c.qual ? "· " + esc(c.qual) : ""}<br>${esc(c.address)} ${c.phone ? "· " + esc(c.phone) : ""}</div></div>
<form class="card" id="f">
<label>Full name<input id="name" required maxlength="60" autocomplete="name"></label>
<div class="row"><label>Age<input id="age" inputmode="numeric" maxlength="3"></label><label>Sex<select id="sex"><option>Female</option><option>Male</option><option>Other</option></select></label></div>
<label>Mobile number<input id="phone" required inputmode="tel" maxlength="10" pattern="[0-9]{10}" autocomplete="tel"></label>
<label>Date<input id="date" type="date" required></label>
<div class="slots" id="slots"></div>
<label>Visit<select id="mode"><option value="clinic">At the clinic</option><option value="tele">Video consultation</option></select></label>
<label>Reason (optional)<textarea id="reason" rows="2" maxlength="300"></textarea></label>
<div class="err" id="err"></div>
<button class="go" id="go" type="submit">Book appointment</button>
</form>
<div class="card ok" id="done" hidden></div>
</main><script>
const $=(i)=>document.getElementById(i);let time="";
const t=new Date();const iso=(d)=>new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10);
$("date").min=iso(t);$("date").value=iso(t);
async function slots(){time="";$("slots").textContent="Loading times…";try{const r=await fetch("/api/slots?date="+$("date").value);const j=await r.json();
$("slots").innerHTML="";(j.slots||[]).forEach(s=>{const b=document.createElement("button");b.type="button";b.textContent=s.t;b.disabled=!s.free;b.setAttribute("aria-pressed","false");
b.onclick=()=>{time=s.t;[...$("slots").children].forEach(x=>x.setAttribute("aria-pressed",x===b?"true":"false"))};$("slots").appendChild(b)});
if(!$("slots").children.length)$("slots").textContent="No times left on this day. Choose another date.";}catch(e){$("slots").textContent="Couldn't load times."}}
$("date").onchange=slots;slots();
$("f").onsubmit=async(e)=>{e.preventDefault();$("err").textContent="";if(!time){$("err").textContent="Choose a time.";return}$("go").disabled=true;
try{const r=await fetch("/api/book",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:$("name").value,age:$("age").value,sex:$("sex").value,phone:$("phone").value,date:$("date").value,time,mode:$("mode").value,reason:$("reason").value,lang:"en"})});
const j=await r.json();if(!r.ok)throw new Error(j.error||"Couldn't book");const a=j.appointment;$("f").hidden=true;$("done").hidden=false;
$("done").innerHTML="<b>Booked.</b><div>"+a.date+" at "+a.time+(a.mode==="tele"?" · video consultation":"")+"</div><div class=muted>Your booking code</div><div class=code>"+a.code+"</div><div class=muted>Keep this code. "+(a.mode==="tele"?"Open the Rx Clinic app at the time and join with this code and your mobile number.":"Show it at the desk when you arrive.")+"</div>";}
catch(err){$("err").textContent=err.message}finally{$("go").disabled=false}};
</script></body></html>`;
}

// ---------- web sign-in and portal ----------
// Same look as the app's sign-in screen. Works in any browser and inside the app (WebView).

const WEB_CSS = `
:root{--bg:#eef3f2;--card:#fff;--fg:#14201f;--muted:#5a6b68;--line:#cfdcd9;--teal:#0e6a64;--teal2:#0a524d;--soft:#e3efed;--red:#b3261e;--rose:#c95c5c;--band:#eef1f1}
@media(prefers-color-scheme:dark){:root{--bg:#0d1514;--card:#16211f;--fg:#e6efed;--muted:#9db0ac;--line:#2b3b38;--teal:#5fc2b8;--teal2:#7fd3c9;--soft:#1b3330;--red:#f2867f;--rose:#d27272;--band:#1b2826}}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 "Segoe UI",Roboto,system-ui,-apple-system,sans-serif}
a{color:var(--teal)}button{font:inherit;cursor:pointer}:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
.logo{display:flex;align-items:center;justify-content:center;gap:10px;font:700 40px/1 Georgia,"Times New Roman",serif;color:var(--teal);letter-spacing:-.5px}
.logo .rx{color:var(--red);font-size:46px}.logo small{display:block;font:600 11px/1 system-ui;letter-spacing:.32em;color:var(--muted);text-transform:uppercase;margin-top:6px;text-align:center}
`;

function loginPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Sign in · Rx Clinic</title><style>${WEB_CSS}
.wrap{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px max(16px,env(safe-area-inset-left))}
.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;box-shadow:0 18px 40px -28px rgba(10,40,36,.45)}
.top{padding:36px 30px 26px;display:flex;flex-direction:column;gap:18px}
h1{font:600 30px/1.2 "Segoe UI",system-ui;text-align:center;margin:4px 0 4px}
.field{position:relative}.field input{width:100%;padding:15px 48px 15px 16px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit;font-size:17px}
.field input:focus{border-color:var(--teal);outline:0;box-shadow:0 0 0 3px var(--soft)}
.field svg{position:absolute;right:14px;top:50%;transform:translateY(-50%);width:24px;height:24px;stroke:var(--muted);fill:none;stroke-width:1.7}
.field .eye{position:absolute;right:46px;top:50%;transform:translateY(-50%);background:none;border:0;color:var(--muted);font-size:13px}
.row{display:flex;justify-content:space-between;align-items:center;font-size:15px}
.row label{display:flex;align-items:center;gap:8px;color:var(--teal);cursor:pointer}.row input{width:20px;height:20px;accent-color:var(--teal)}
.row a{display:flex;align-items:center;gap:6px;text-decoration:none}
.btns{display:flex;flex-direction:column;align-items:center;gap:0;margin-top:6px}
.btn{width:78%;display:flex;align-items:center;justify-content:center;gap:12px;border:0;color:#fff;padding:14px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;font-size:15px}
.btn.new{background:var(--rose);width:72%}.btn.go{background:var(--teal)}.btn.go:hover{background:var(--teal2)}.btn:disabled{opacity:.6}
.btn svg{width:18px;height:18px;stroke:#fff;fill:none;stroke-width:2}
.err{color:var(--red);text-align:center;min-height:1.3em;font-size:14.5px}
.lic{background:var(--band);padding:20px 30px 22px;font-size:16px;line-height:1.45}
.lic b{color:var(--teal);letter-spacing:.04em;display:flex;align-items:center;gap:8px;font-size:15px}
.lic .exp{color:var(--red)}.lic .exp strong{font-weight:700}
.foot{margin-top:18px;color:var(--muted);font-size:14px;text-align:center}
</style></head><body><div class="wrap">
<form class="card" id="f" autocomplete="on">
<div class="top">
<div><div class="logo"><span class="rx">℞</span>Rx Clinic</div><div class="logo"><small>Hospital &amp; Clinic Suite</small></div></div>
<h1>Sign in</h1>
<div class="field"><input id="u" name="username" placeholder="Username" autocomplete="username" autocapitalize="none" spellcheck="false" required>
<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg></div>
<div class="field"><input id="p" name="password" type="password" placeholder="Password" autocomplete="current-password" required>
<button type="button" class="eye" id="eye" aria-label="Show password">Show</button>
<svg viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 20 3m-3 3 2.5 2.5M14.5 8.5 17 11"/></svg></div>
<div class="row"><label><input type="checkbox" id="rem" checked>Remember me</label>
<a href="/terms"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/></svg>Terms</a></div>
<div class="err" id="err" role="alert"></div>
<div class="btns">
<button type="button" class="btn new" id="new">New session <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></button>
<button type="submit" class="btn go" id="go">Login <svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg></button>
</div></div>
<div class="lic" id="lic"><b><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.6M8.2 13.2l7.6 4.6"/></svg>LICENSED TO :</b>
<div id="who">Loading…</div><div class="exp" id="exp"></div></div>
</form>
<div class="foot">${new Date().getFullYear()} © ShazVerse Technologies · Rx Clinic</div>
</div><script>
const $=(i)=>document.getElementById(i);
const store=()=>{try{return localStorage.getItem("rx_remember")==="0"?sessionStorage:localStorage}catch{return null}};
try{const s=localStorage.getItem("rx_session")||sessionStorage.getItem("rx_session");if(s&&!location.hash.includes("new"))location.replace("/portal")}catch{}
try{$("u").value=localStorage.getItem("rx_user")||""}catch{}
$("eye").onclick=()=>{const t=$("p").type==="password";$("p").type=t?"text":"password";$("eye").textContent=t?"Hide":"Show"};
fetch("/api/license").then(r=>r.json()).then(l=>{
 const d=new Date(l.expires+"T00:00:00");const ds=d.toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}).toUpperCase();
 $("who").innerHTML=(l.licensedTo||"Rx Clinic").replace(/</g,"&lt;")+",<br>"+(l.address||"").replace(/</g,"&lt;")+(l.address?"<br>":"")+l.plan+" plan"+(l.trial?" (trial)":"");
 $("exp").innerHTML=(l.expired?"License expired on ":"License expires on ")+"<strong>"+ds+"</strong>";
}).catch(()=>{$("who").textContent="Server not reachable"});
$("new").onclick=()=>{try{["rx_session","rx_role"].forEach(k=>{localStorage.removeItem(k);sessionStorage.removeItem(k)})}catch{};$("p").value="";$("err").textContent="Started a new session. Sign in again.";$("u").focus()};
$("f").onsubmit=async(e)=>{e.preventDefault();$("err").textContent="";$("go").disabled=true;
 try{const r=await fetch("/api/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:$("u").value.trim().toLowerCase(),password:$("p").value})});
 const j=await r.json();if(!r.ok)throw new Error(j.error||"Couldn't sign in");
 try{localStorage.setItem("rx_remember",$("rem").checked?"1":"0");if($("rem").checked)localStorage.setItem("rx_user",$("u").value.trim().toLowerCase());else localStorage.removeItem("rx_user");
 const s=store();s.setItem("rx_session",j.session);s.setItem("rx_role",j.role);s.setItem("rx_name",(j.user&&j.user.name)||"");if(j.user&&j.user.mustChange)s.setItem("rx_must","1");else s.removeItem("rx_must")}catch{}
 location.href="/portal"}catch(err){$("err").textContent=err.message}finally{$("go").disabled=false}};
</script></body></html>`;
}

function portalPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Rx Clinic</title><style>${WEB_CSS}
header{background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:2}
.bar{max-width:1080px;margin:0 auto;display:flex;align-items:center;gap:14px;padding:12px max(16px,env(safe-area-inset-left))}
.bar .logo{font-size:24px;justify-content:flex-start}.bar .logo .rx{font-size:28px}.sp{flex:1}
.me{text-align:right;font-size:14px;line-height:1.3}.me b{display:block}.me span{color:var(--muted)}
.out{border:1px solid var(--line);background:none;color:var(--fg);border-radius:8px;padding:8px 12px}
main{max-width:1080px;margin:0 auto;padding:22px max(16px,env(safe-area-inset-left)) 48px;display:flex;flex-direction:column;gap:18px}
h1{font:600 26px/1.2 Georgia,serif;margin:0}.muted{color:var(--muted)}
.lic{background:var(--band);border-radius:10px;padding:10px 14px;font-size:14px;display:flex;flex-wrap:wrap;gap:6px 18px}.lic .exp{color:var(--red);font-weight:600}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}.stat small{display:block;color:var(--muted);font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;font-weight:600}
.stat b{font:600 26px ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}.stat span{display:block;color:var(--muted);font-size:13px}
.list{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.item{display:flex;gap:12px;align-items:center;padding:12px 14px;border-bottom:1px solid var(--line)}.item:last-child{border:0}
.tok{font:600 20px ui-monospace,monospace;color:var(--teal);min-width:40px}.grow{flex:1;min-width:0}.grow b{display:block}.grow span{color:var(--muted);font-size:13.5px}
.pill{font-size:12px;font-weight:600;padding:3px 9px;border-radius:999px;background:var(--soft);color:var(--teal);white-space:nowrap}.pill.r{background:rgba(179,38,30,.12);color:var(--red)}
.app{background:var(--soft);border-radius:12px;padding:14px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.app a{background:var(--teal);color:#fff;text-decoration:none;border-radius:8px;padding:10px 14px;font-weight:600}
.empty{padding:18px;color:var(--muted)}
</style></head><body>
<header><div class="bar"><div class="logo"><span class="rx">℞</span>Rx Clinic</div><div class="sp"></div><div class="me"><b id="nm"></b><span id="rl"></span></div><button class="out" id="out">Sign out</button></div></header>
<main><div class="lic" id="lic"></div><div><h1 id="hi"></h1><div class="muted" id="sub"></div></div>
<div class="stats" id="stats"></div><div id="listWrap"></div>
<div class="app"><div>Case sheets, prescribing, billing and video calls are in the Rx Clinic app. The web portal shows today's work.</div><a href="/login#new">Switch user</a></div>
</main><script>
const $=(i)=>document.getElementById(i);
const get=(k)=>{try{return localStorage.getItem(k)||sessionStorage.getItem(k)}catch{return null}};
const session=get("rx_session");if(!session)location.replace("/login");
const ROLES={doctor:"Doctor",staff:"Nursing staff",pharmacy:"Pharmacy",lab:"Lab",diagnostics:"Diagnostics",billing:"Billing",admin:"Admin"};
const esc=(s)=>String(s??"").replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const inr=(x)=>"₹"+Math.round(x||0).toLocaleString("en-IN");
async function api(p,b={}){const r=await fetch(p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({session,...b})});const j=await r.json();
 if(r.status===401){signOut();throw new Error("signed out")}if(!r.ok)throw new Error(j.error||"Error");return j}
function signOut(){try{["rx_session","rx_role","rx_name","rx_must"].forEach(k=>{localStorage.removeItem(k);sessionStorage.removeItem(k)})}catch{};location.replace("/login")}
$("out").onclick=signOut;
const stat=(l,v,s="")=>'<div class="stat"><small>'+esc(l)+'</small><b>'+esc(v)+'</b><span>'+esc(s)+'</span></div>';
const list=(rows,empty)=>'<div class="list">'+(rows.length?rows.join(""):'<div class="empty">'+esc(empty)+'</div>')+'</div>';
(async()=>{
 const me=await api("/api/me");const role=me.role;const u=me.user||{};
 $("nm").textContent=u.name||"";$("rl").textContent=ROLES[role]||role;
 const h=new Date().getHours();$("hi").textContent=(h<12?"Good morning":h<17?"Good afternoon":"Good evening")+(u.name?", "+u.name:"");
 $("sub").textContent=new Date().toLocaleDateString("en-IN",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
 fetch("/api/license").then(r=>r.json()).then(l=>{$("lic").innerHTML="<span><b>Licensed to:</b> "+esc(l.licensedTo)+"</span><span><b>Plan:</b> "+esc(l.plan)+(l.trial?" (trial)":"")+"</span><span class=exp>"+(l.expired?"License expired on ":"License expires on ")+esc(new Date(l.expires+"T00:00").toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}))+"</span>"});
 if(get("rx_must"))$("sub").textContent+=" · Please set your own password in the app.";
 let S="",L="";
 if(role==="admin"){const o=await api("/api/admin/overview");
  S=stat("OPD checked in",o.opd.checkedIn,o.opd.waiting+" waiting")+stat("Appointments",o.appointments.total,o.appointments.tele+" video")+stat("Lab pending",o.lab.pending,o.lab.reported+" reported")+stat("Scans pending",o.diagnostics.pending,o.diagnostics.reported+" reported")+stat("To dispense",o.pharmacy.toDispense,o.pharmacy.outOfStock+" out of stock")+(o.billing?stat("Billed today",inr(o.billing.billed),"collected "+inr(o.billing.collected))+stat("Inpatients",o.billing.inpatients,"admitted"):"");}
 else if(role==="doctor"||role==="staff"){const v=(role==="doctor"?await api("/api/doctor/visits"):await api("/api/nurse/queue")).visits||[];
  S=stat("Checked in",v.length)+stat("Waiting",v.filter(x=>x.status!=="sent"&&x.status!=="dispensed"&&x.status!=="done").length)+stat("Emergency",v.filter(x=>x.urgent).length);
  L=list(v.map(x=>'<div class="item"><div class="tok">'+esc(x.token)+'</div><div class="grow"><b>'+esc(x.patient&&x.patient.name)+'</b><span>'+esc([x.patient&&x.patient.age?x.patient.age+" y":"",x.patient&&x.patient.sex,x.complaint].filter(Boolean).join(" · "))+'</span></div>'+(x.urgent?'<span class="pill r">Emergency</span>':'<span class="pill">'+esc(x.status||"waiting")+'</span>')+'</div>'),"No patients have checked in today.");}
 else if(role==="pharmacy"){const q=(await api("/api/pharmacy/queue")).queue||[];const t=q.filter(x=>x.status==="sent");
  S=stat("To dispense",t.length)+stat("Dispensed",q.length-t.length);
  L=list(q.map(x=>'<div class="item"><div class="tok">'+esc(x.token)+'</div><div class="grow"><b>'+esc(x.patient&&x.patient.name)+'</b><span>'+esc(((x.rx&&x.rx.items)||[]).map(i=>i.generic).join(", "))+'</span></div><span class="pill'+(x.status==="sent"?" r":"")+'">'+(x.status==="sent"?"To dispense":"Dispensed")+'</span></div>'),"No prescriptions yet.");}
 else if(role==="lab"||role==="diagnostics"){const o=(await api("/api/orders/list",{kind:role==="lab"?"lab":"imaging"})).orders||[];const p=o.filter(x=>x.status!=="reported");
  S=stat("Pending",p.length)+stat("Reported",o.length-p.length);
  L=list(o.map(x=>'<div class="item"><div class="grow"><b>'+esc(x.test)+'</b><span>'+esc((x.patient&&x.patient.name)+" · token "+x.token)+'</span></div><span class="pill'+(x.status==="reported"?"":" r")+'">'+esc(x.status)+'</span></div>'),"No orders.");}
 else if(role==="billing"){const s=await api("/api/bills/summary");
  S=stat("Billed today",inr(s.totals.billed))+stat("Collected today",inr(s.totals.collected))+Object.entries(s.byMode||{}).map(([k,v])=>stat(k,inr(v))).join("");
  L=list(Object.entries(s.byDept).map(([k,v])=>'<div class="item"><div class="grow"><b>'+esc({opd:"OPD",pharmacy:"Pharmacy",lab:"Lab",diagnostics:"Diagnostics",ip:"Inpatient"}[k])+'</b><span>'+v.count+' bills</span></div><span class="pill">'+inr(v.billed)+' billed · '+inr(v.collected)+' collected</span></div>'),"");}
 $("stats").innerHTML=S;$("listWrap").innerHTML=L;
})().catch(e=>{if(e.message!=="signed out")$("sub").textContent=e.message});
</script></body></html>`;
}

function termsPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terms · Rx Clinic</title>
<style>${WEB_CSS}main{max-width:720px;margin:0 auto;padding:28px 18px 48px}h1{font:600 28px Georgia,serif}li{margin-bottom:8px}</style></head><body><main>
<div class="logo" style="justify-content:flex-start"><span class="rx">℞</span>Rx Clinic</div><h1>Terms of use</h1>
<ol>
<li>Rx Clinic is software for registered medical practitioners and their staff. Clinical decisions remain the responsibility of the treating doctor.</li>
<li>AI suggestions (history, diagnosis, investigations, treatment) are aids for a qualified doctor to check, edit or reject. They are not a diagnosis.</li>
<li>Each login is for one person. Do not share passwords. The clinic admin creates, resets and disables logins.</li>
<li>Patient information is confidential. Use it only for the patient's care, billing and records, as required by law.</li>
<li>Aadhaar numbers are never stored in full. Only a protected key for search and the last four digits are kept.</li>
<li>The licence is for the plan and period shown on the sign-in page. Renew before the expiry date to keep access.</li>
<li>Back up exported records and keep printed copies as your local rules require.</li>
</ol>
<p><a href="/login">Back to sign in</a></p></main></body></html>`;
}

// Rx Clinic server — Cloudflare Worker + D1 database.
// Appointments, staff PIN sign-in, and in-app video teleconsults on LiveKit
// (the same video engine and host/waiting-room logic as SRK Meet).
//
// Bindings and settings (Cloudflare → Worker → Settings):
//   DB                  D1 database binding (tables are created automatically)
//   LIVEKIT_URL         e.g. wss://your-project.livekit.cloud            (variable)
//   LIVEKIT_API_KEY     from LiveKit Cloud → Settings → Keys              (variable)
//   LIVEKIT_API_SECRET  from the same page                               (secret)
//   OPENAI_API_KEY      for the AI features                              (secret, optional for now)
//   OPENAI_MODEL        optional, defaults to gpt-4o-mini                (variable)
//   CLINIC_TZ_MINUTES   optional, clinic time zone offset, default 330 (India)

const enc = new TextEncoder();
const DEFAULT_PINS = { doctor: "1001", staff: "2002", pharmacy: "3003", lab: "4004" };
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
    id: r.id, date: r.date, time: r.time, mode: r.mode, status: r.status, name: r.name, age: r.age || "",
    sex: r.sex || "", phone: r.phone, reason: r.reason || "", lang: r.lang || "en", code: r.code,
  };
}

// ---------- staff sessions ----------

async function makeSession(env, role) {
  const exp = now() + 12 * 3600;
  const sig = b64url(await hmac(secret(env), `session:${role}.${exp}`)).slice(0, 32);
  return `${role}.${exp}.${sig}`;
}

async function requireStaff(env, session, roles) {
  const [role, exp, sig] = String(session || "").split(".");
  if (!role || !exp || !sig || !roles.includes(role)) throw new HttpError(401, "Sign in again");
  if (Number(exp) < now()) throw new HttpError(401, "Sign in again: your session expired");
  const expected = b64url(await hmac(secret(env), `session:${role}.${exp}`)).slice(0, 32);
  if (!safeEqual(expected, sig)) throw new HttpError(401, "Sign in again");
  return role;
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

async function chatOpenAI(env, messages, wantJson) {
  if (!env.OPENAI_API_KEY) throw new HttpError(503, "AI is not set up yet: add OPENAI_API_KEY in the worker settings");
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
  try { return { json: JSON.parse(text) }; } catch { throw new HttpError(502, "The AI reply was not valid JSON. Try again."); }
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

// ---------- routes ----------

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "OPTIONS") return json({ ok: true });

  if (request.method === "GET") {
    if (path === "/") {
      let database = false;
      try { await db(env); database = true; } catch { /* reported below */ }
      return json({ ok: true, service: "rx-clinic", database, video: liveKitReady(env), ai: !!env.OPENAI_API_KEY });
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
      const id = crypto.randomUUID();
      const code = randomFrom("0123456789", 6);
      const row = {
        id, created_at: Date.now(), date, time, mode, status: "booked", name, age: clean(body.age, 3), sex: clean(body.sex, 10),
        phone, reason: clean(body.reason, 300), lang: ["en", "ta", "hi"].includes(body.lang) ? body.lang : "en", code, room: null, source: "patient",
      };
      await D.prepare(`INSERT INTO appointments (id, created_at, date, time, mode, status, name, age, sex, phone, reason, lang, code, room, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(row.id, row.created_at, row.date, row.time, row.mode, row.status, row.name, row.age, row.sex, row.phone, row.reason, row.lang, row.code, row.room, row.source).run();
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
      const role = String(body.role || "");
      if (!STAFF_ROLES.includes(role)) throw new HttpError(400, "Unknown role");
      const pins = Object.assign({}, DEFAULT_PINS, await getSetting(env, "pins", {}));
      if (!safeEqual(String(pins[role]), String(body.pin || ""))) throw new HttpError(401, "That PIN is not right");
      const clinic = Object.assign({}, DEFAULT_CLINIC, await getSetting(env, "clinic", {}));
      return json({ session: await makeSession(env, role), role, clinic });
    }

    case "/api/settings": {
      await requireStaff(env, body.session, ["doctor"]);
      if (body.pins && typeof body.pins === "object") {
        const pins = Object.assign({}, DEFAULT_PINS, await getSetting(env, "pins", {}));
        for (const r of STAFF_ROLES) if (/^\d{4,8}$/.test(String(body.pins[r] || ""))) pins[r] = String(body.pins[r]);
        await setSetting(env, "pins", pins);
      }
      if (body.clinic && typeof body.clinic === "object") {
        const c = Object.assign({}, DEFAULT_CLINIC, await getSetting(env, "clinic", {}));
        for (const k of ["name", "doctor", "qual", "reg", "address", "phone", "hours"]) if (k in body.clinic) c[k] = clean(body.clinic[k], 200);
        await setSetting(env, "clinic", c);
      }
      return json({ ok: true, clinic: Object.assign({}, DEFAULT_CLINIC, await getSetting(env, "clinic", {})) });
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
        await requireStaff(env, body.session, ["doctor"]);
        const a = await D.prepare("SELECT * FROM appointments WHERE id = ?").bind(String(body.id || "")).first();
        if (!a || a.mode !== "tele") throw new HttpError(404, "Teleconsult not found");
        const room = await ensureRoom(env, a);
        if (["booked", "arrived"].includes(a.status)) await D.prepare("UPDATE appointments SET status = 'in-call' WHERE id = ?").bind(a.id).run();
        const clinic = Object.assign({}, DEFAULT_CLINIC, await getSetting(env, "clinic", {}));
        const name = clinic.doctor || "Doctor";
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
      const id = crypto.randomUUID();
      const visit = {
        patient: { name, age: clean(p.age, 3), sex: clean(p.sex, 10), phone: digits(p.phone) }, lang, qa, caseSheet,
        urgent: !!body.urgent, status: "waiting", token, date, createdAt: Date.now(), work: null, rx: null,
      };
      await putDoc(env, "visits", id, visit);
      return json({ id, token });
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
      return json({ id: body.id, visit: v });
    }

    case "/api/doctor/visit/save": {
      await requireStaff(env, body.session, ["doctor"]);
      const id = String(body.id || "");
      const v = await getDoc(env, "visits", id);
      if (!v) throw new HttpError(404, "Visit not found");
      const patch = body.patch || {};
      for (const k of ["work", "rx", "caseSheet"]) if (k in patch) v[k] = patch[k];
      if (["waiting", "consult", "sent", "dispensed", "done"].includes(patch.status)) v.status = patch.status;
      if (JSON.stringify(v).length > 900000) throw new HttpError(413, "This case sheet is too large to save");
      await putDoc(env, "visits", id, v);
      return json({ ok: true, status: v.status });
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

export { allSlots, makeSession, requireStaff, issueToken, clinicNow };

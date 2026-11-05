# Rx Clinic

AI-assisted hospital app for Android by ShazVerse Technologies: appointment booking, in-app video teleconsultation, and (in the next stages) OPD consults, ward records, lab, pharmacy and AI review calls.

Video calls are built in, using the same engine as **SRK Meet** (LiveKit): the doctor is the host, the patient waits in a waiting room until the doctor admits them. Mute, camera flip, chat, reactions and screen sharing all work inside Rx Clinic.

## What's in this version (stage 1)

- **Patient:** book a clinic visit or a video teleconsult (15-minute slots, next 7 days), keep a list of bookings on the phone, and **Join video call** at the booked time.
- **Doctor:** sign in with a PIN, see each day's appointments, **Start video call** for teleconsults, admit the patient from the waiting room, and mark visits arrived, completed, no-show or cancelled.
- Nursing staff, pharmacy and lab sign-ins are listed and come in the next stage.

## How it fits together

```
Rx Clinic app ──(booking, sign-in, video pass)──▶ Rx Clinic server (Cloudflare Worker + D1)
Rx Clinic app ◀══════════ live audio / video / chat ══════════▶ LiveKit Cloud (shared with SRK Meet)
Rx Clinic server ──(AI prompts, next stage)──▶ OpenAI
```

## Setup (one time)

### 1. Database (Cloudflare D1, free)
Nothing to do: the first deploy creates the D1 database `rxclinic-db` and links it to the worker. Tables are created automatically on first use.

### 2. The Rx Clinic server (Cloudflare Worker)
1. **Workers & Pages → Create → Import a repository →** this repo, worker name `rx-clinic` (leave the root directory as `/`).
2. In the worker's **Settings → Variables and Secrets**, add Secrets:
   - `LIVEKIT_API_SECRET`: the same LiveKit API secret SRK Meet uses
   - `OPENAI_API_KEY`: your OpenAI key (for the AI features)
3. Open `https://rx-clinic.<your-subdomain>.workers.dev`. You should see `"database": true, "video": true`.

`LIVEKIT_URL` and `LIVEKIT_API_KEY` are already set in `wrangler.toml` (at the top of the repo) (same LiveKit project as SRK Meet).

### 3. The APK
GitHub Actions builds `Rx-Clinic.apk` on every push. Download it from **Releases**.
If your worker address is not `https://rx-clinic.rajkumarsurgeon34.workers.dev`, either add a repository variable `RX_CLINIC_SERVER_URL`, or change it in the app under ⚙️ Settings.

## Default PINs

| Role | PIN |
|---|---|
| Doctor | 1001 |
| Nursing staff | 2002 |
| Pharmacy | 3003 |
| Lab & diagnostics | 4004 |

Change them before real use (the doctor can change PINs through the server's `/api/settings`; a settings screen comes next).

## Privacy

Patient records live in your own Cloudflare D1 database, and video goes through your own LiveKit project. Only use example patients until consent, access control and data-protection review (DPDP Act) are complete.

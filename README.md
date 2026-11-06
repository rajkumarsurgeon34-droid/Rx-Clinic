# Rx Clinic

AI-assisted hospital app for Android by ShazVerse Technologies: appointment booking, in-app video teleconsultation, and (in the next stages) OPD consults, ward records, lab, pharmacy and AI review calls.

Video calls are built in, using the same engine as **SRK Meet** (LiveKit): the doctor is the host, the patient waits in a waiting room until the doctor admits them. Mute, camera flip, chat, reactions and screen sharing all work inside Rx Clinic.

## What's in this version

- **Patient check-in:** an AI interview takes the history one question at a time in English, Tamil or Hindi, reads each question aloud, and sends an English case sheet to the doctor. The patient gets a token number.
- **Patient booking:** book a clinic visit or a video teleconsult (15-minute slots, next 7 days), keep a list of bookings on the phone, and **Join video call** at the booked time.
- **Doctor OPD:** the day's checked-in patients; case sheet with history, vitals and examination; AI-suggested investigations, differential and provisional diagnosis; AI analysis of typed results; AI treatment suggestions (surgical plan, medicines, advice, referrals, review date); an editable prescription that can be saved and shared.
- **Doctor appointments:** **Start video call** for teleconsults, admit the patient from the waiting room, and mark visits arrived, completed, no-show or cancelled.
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
   - `ANTHROPIC_API_KEY`: your Claude API key (for the AI features), **or** `OPENAI_API_KEY` for OpenAI. If both are set, Claude is used.
3. Open `https://rx-clinic.<your-subdomain>.workers.dev`. You should see `"database": true, "video": true`.

`LIVEKIT_URL` and `LIVEKIT_API_KEY` are already set in `wrangler.toml` (at the top of the repo) (same LiveKit project as SRK Meet).

### 3. The APK
GitHub Actions builds `Rx-Clinic.apk` on every push. Download it from **Releases**.
If your worker address is not `https://rx-clinic.rajkumarsurgeon34.workers.dev`, either add a repository variable `RX_CLINIC_SERVER_URL`, or change it in the app under ⚙️ Settings.

## Logins

**Staff** sign in with a username and password. The admin creates one login per person, so a clinic can have several doctors, nurses, pharmacists, lab and diagnostics staff, each with their own password.

1. First sign-in: username `admin`, password `admin123`. The app makes you choose a new password at once.
2. Admin → Staff logins → Add login: name, username, role (Doctor, Nursing staff, Pharmacy, Lab, Diagnostics, Admin), starting password. Doctors also get qualification and registration number for prescriptions.
3. Each person signs in and sets their own password. The admin can reset a password or disable a login; that signs the person out everywhere.

Five wrong passwords lock a login for 15 minutes. Old PIN sign-in (app 0.5) works only until the admin sets up the new password.

**Patients** get a Patient ID (RX100001, RX100002, …) linked to their mobile number and/or Aadhaar:
- Register themselves in the app (Patient → Register / sign in) and sign in with Patient ID, mobile or Aadhaar plus password.
- Or the reception registers them (Nursing → Patients, or Doctor → Patient records) and can set an app password.
- Check-in links the visit to their ID automatically (same name + mobile), or makes a new ID for a first visit.
- Aadhaar is checked (Verhoeff checksum) and never stored in full: only a keyed hash for lookup and the last 4 digits.
- Family members can share one mobile number; each gets their own Patient ID.

## Building the APK

Pushes only check that the code compiles. To make the APK: GitHub → Actions → Build APK → Run workflow.

## Privacy

Patient records live in your own Cloudflare D1 database, and video goes through your own LiveKit project. Only use example patients until consent, access control and data-protection review (DPDP Act) are complete.

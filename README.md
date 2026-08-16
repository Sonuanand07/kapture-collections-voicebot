# Kapture Finance Collections Voicebot — "Maya"

Outbound voice AI collections agent, built on [Vapi](https://vapi.ai). Authenticates the customer before disclosing any debt, negotiates a promise-to-pay, and logs a disposition on every call.

- **Task 1 (HLD):** [`docs/HLD_Document.md`](docs/HLD_Document.md) + [`docs/System_Architecture.mmd`](docs/System_Architecture.mmd) (Mermaid sequence diagram — renders natively on GitHub, or paste into [mermaid.live](https://mermaid.live) to export a PNG).
- **Task 2 (Build):** `vapi/` (system prompt + tool schemas) + `mock-server/` (deployable webhook backend).

---

## Project structure

```
kapture-collections-voicebot/
├── README.md
├── docs/
│   ├── HLD_Document.md          # Full design doc (architecture, state machine, compliance, etc.)
│   └── System_Architecture.mmd  # Mermaid sequence diagram source
├── vapi/
│   ├── system_prompt.txt        # Production Vapi system prompt (state-enforced)
│   └── tool_definitions.json    # Tool JSON schemas for the 5 functions
├── mock-server/
│   ├── server.js                # Express webhook implementing all 5 tools
│   ├── package.json
│   ├── .env.example
│   ├── Dockerfile                # Container deploy
│   ├── Procfile                  # Heroku/Railway-style start command
│   └── render.yaml                # One-click Render deploy config
└── tests/
    └── test_cases.json          # 12-case evaluation matrix (happy path + edge cases)
```

---

## 1. Deploy the mock webhook server (do this first)

The Vapi assistant needs a **public HTTPS URL** to call for tool execution. Pick one option:

### Option A — Render (recommended, free tier, ~2 minutes)
1. Push this repo to GitHub (see "Push to GitHub" below).
2. Go to [render.com](https://render.com) → **New** → **Web Service** → connect your repo.
3. Render will detect `mock-server/render.yaml` automatically (root dir `mock-server`, build `npm install`, start `npm start`, health check `/health`).
4. Deploy. Your URL will look like `https://kapture-collections-webhook.onrender.com`.
5. Test it: `curl https://<your-app>.onrender.com/health` → `{"status":"healthy"}`.

### Option B — Railway
1. `railway init` inside `mock-server/`, then `railway up` (uses the included `Procfile`).
2. Railway assigns a public domain automatically under Settings → Networking.

### Option C — Docker (any host: Fly.io, a VPS, etc.)
```bash
cd mock-server
docker build -t kapture-webhook .
docker run -p 3000:3000 --env-file .env kapture-webhook
```

### Option D — Quick local testing via ngrok (not a real deploy, but fine for a demo call)
```bash
cd mock-server
cp .env.example .env
npm install
npm start          # runs on http://localhost:3000
# in a second terminal:
ngrok http 3000     # gives you a public https URL
```

Once deployed, note your webhook URL, e.g. `https://your-app.onrender.com/webhook`.

---

## 2. Configure the Vapi assistant

1. Log in to the [Vapi dashboard](https://dashboard.vapi.ai) → **Assistants** → **Create Assistant** → **Blank Template**.
2. **Transcriber:** Deepgram, model `nova-2`, language `en` (or `multi` for the bilingual bonus).
3. **Model:** OpenAI `gpt-4o` or `gpt-4o-mini`, temperature `0.1`.
4. **Voice:** ElevenLabs or Cartesia — a calm, professional voice (e.g. ElevenLabs "Sarah").
5. **System Prompt:** paste the full contents of [`vapi/system_prompt.txt`](vapi/system_prompt.txt) into the assistant's system message.
6. **First Message:** `"Hello, this is Maya calling from Kapture Finance. Am I speaking with Mr. Rahul Sharma?"`
7. **Tools:** go to the **Tools** tab and add each function from [`vapi/tool_definitions.json`](vapi/tool_definitions.json). Before importing, replace every `https://YOUR_DEPLOYED_SERVER_URL/webhook` placeholder with your real deployed URL from step 1 (e.g. `https://kapture-collections-webhook.onrender.com/webhook`). If you set `WEBHOOK_SECRET` in the server's env, also add the header `x-webhook-secret: <your secret>` in each tool's server config.
8. Save the assistant.

## 3. Test it

Use Vapi's **Web Call** (talk to it from the browser) or connect a phone number under **Phone Numbers**, then run through the scenarios in [`tests/test_cases.json`](tests/test_cases.json). Two to record for the demo:

- **TC-004 (Happy path):** confirm identity → verify with code `1234` → agree to pay Friday → bot calls `log_promise_to_pay` + `send_payment_link` → disposition `PTP_AGREED`.
- **One edge case:** TC-005 (already paid), TC-006 (dispute), or TC-007 (wrong person) all work well for a short demo.

You can also hit `GET https://<your-app>/debug/store` on the deployed server to see every tool call and disposition it has logged, which is useful while debugging a live call.

---

## 4. Design choices

- **Deepgram Nova-2** for STT — strong multi-language/telephony performance and low latency, important for the EN/HI bonus.
- **GPT-4o-mini at temperature 0.1** — low temperature was the single highest-leverage lever for getting the model to follow the state machine literally instead of "helpfully" skipping ahead (e.g. disclosing debt before verification finished).
- **State enforcement lives mostly in the prompt**, with the disclosure-gating rule repeated twice (once as a numbered rule, once inline in STATE 1) because a single mention wasn't reliable in testing — the model would occasionally infer verification from tone. See "What broke" below.
- **JSON-file persistence** in the mock server instead of an in-memory object, so a Render free-tier restart (which happens on idle) doesn't wipe logged dispositions mid-demo. In a real system this is the LMS/CRM, accessed via an internal API — never directly by the LLM.
- **`mark_disposition` is treated as mandatory**, not optional — every branch in the prompt ends by calling it, and the closing rule tells the model to call it defensively even if it thinks it already has, since a missed disposition is the worst failure mode for a collections system (a call that "just ends" with no record).

## 5. What broke and how it was debugged

- **Early on, the model would say "Thanks Rahul, let me check your account" and then mention the loan type before the `verify_customer` tool result had actually come back** — it was pattern-matching "user gave a number" to "verification passed." Fix: the prompt now explicitly says not to disclose *even the existence of a loan* until the tool result is present, and STATE 1 repeats "DO NOT proceed... until the tool result comes back" right where the tool call happens, not just in the rules section at the top.
- **The wrong-person path initially leaked the company's purpose** ("I'm calling about a loan matter for Rahul") to whoever answered. Fixed by hard-restricting third-party disclosure to "a personal matter."
- **Silent/no-input calls had no defined limit**, so a bad connection could loop the "are you there?" prompt indefinitely. Added an explicit 2-re-prompt cap with a `NO_RESPONSE` disposition.

## 6. What I'd improve with more time

- Server-side enforcement of the auth gate (reject `log_promise_to_pay`/`send_payment_link` calls for a session with no prior successful `verify_customer`), rather than relying on the prompt alone — belt-and-suspenders against prompt injection or model drift.
- A real eval harness that plays the 12 test cases against a live Vapi call automatically (via Vapi's API) and scores transcripts against the `pass_criteria`, instead of manual review.
- Swap the JSON-file store for a real database and add structured metrics export (containment rate, PTP rate, latency, drop rate — see HLD §9) to a dashboard.
- Real SMS/WhatsApp integration (Twilio/Gupshup) behind `send_payment_link` instead of the mocked response.

---

## 7. Push to GitHub

```bash
cd kapture-collections-voicebot
git init
git add .
git commit -m "Kapture collections voicebot: HLD, Vapi config, deployable webhook server"
git branch -M main
git remote add origin https://github.com/<your-username>/kapture-collections-voicebot.git
git push -u origin main
```

After pushing, connect the repo to Render (or your chosen host) as described in step 1 for a live, auto-deploying webhook.

## 8. Testing framework at scale (bonus)

`tests/test_cases.json` is a 12-case matrix covering the happy path and every required edge case, each with an `expected_behavior` and machine-checkable `pass_criteria`. At scale this would run as: place N calls per scenario via the Vapi API with scripted TTS-driven "customer" turns → capture transcripts + tool-call logs → assert pass_criteria against the transcript and tool call sequence (e.g. regex-checking that no debt keyword appears before a successful `verify_customer` tool result) → track pass rate per scenario over time as a regression signal for prompt changes.

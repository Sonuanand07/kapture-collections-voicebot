# High-Level Design — Kapture Finance Collections Voicebot ("Maya")

**Author:** AI Delivery Intern Assignment
**Client:** Kapture Finance
**Scope:** Outbound collections voicebot for overdue-EMI customers
**Example case:** Rahul Sharma · Personal Loan · ₹8,499 overdue · 12 DPD

---

## 1. Architecture & Pipeline

```
Telephony (SIP/PSTN, Vapi-managed number)
   │  audio (µ-law/PCM, chunked)
   ▼
STT — Deepgram Nova-2 (multi-language)
   │  partial + final transcripts
   ▼
Orchestrator / LLM — GPT-4o-mini (temp 0.1) via Vapi
   │  tool calls
   ▼
Mock Webhook API (Express) — verify_customer, log_promise_to_pay,
   send_payment_link, escalate_to_agent, mark_disposition
   │
   ▼ (tool result returns to LLM)
TTS — ElevenLabs "Sarah" (or Cartesia Sonic for lower latency)
   │  synthesized audio
   ▼
Telephony out → Customer
```

Datastore: a lightweight JSON/SQLite "accounts" table sits behind the mock server (account_id, name, phone (masked), balance, DPD, verification code, disposition history). In production this would be the loan-management system (LMS) accessed via a secure internal API, not the LLM directly — the LLM only ever talks to the webhook, never to the DB.

### Latency budget (target: < 1.2s round trip, end of user speech → start of bot audio)

| Hop | Budget | Notes |
|---|---|---|
| STT (Deepgram Nova-2, streaming) | ~200ms | endpointing tuned to 300–500ms silence |
| LLM first token (GPT-4o-mini) | ~400ms | low temperature, short system prompt reduces prefill cost |
| Tool call round-trip (webhook) | ~150–250ms | only blocks the turn during `verify_customer`; async where possible |
| TTS first audio chunk | ~250–300ms | streaming synthesis, not full-utterance wait |
| Network/jitter buffer | ~150ms | Vapi-managed |
| **Total** | **~1.0–1.2s** | acceptable for natural turn-taking |

If a tool call is slow (>800ms), the bot plays a filler ("One moment while I pull that up...") rather than going silent.

---

## 2. Conversation Flow / State Machine

States are **enforced in code/config**, not left to prompt discretion — the LLM cannot skip a state because it "decided" the user is verified. Verification is gated behind an actual tool response (`verified: true`).

```
INIT
  → (greeting confirmed target speaking) → AUTH_PENDING
  → (wrong person / unavailable) → CALL_ENDED [WRONG_PERSON]

AUTH_PENDING
  → verify_customer() returns verified:true → AUTHENTICATED
  → verify_customer() returns verified:false (max 2 attempts) → CALL_ENDED [AUTH_FAILED]
  → user requests DNC before auth completes → CALL_ENDED [DO_NOT_CALL]

AUTHENTICATED  (debt may now be disclosed)
  → NEGOTIATION

NEGOTIATION
  → will-pay → PTP_COLLECTED (log_promise_to_pay, send_payment_link)
  → already-paid → CALL_ENDED [ALREADY_PAID] (mark_disposition)
  → hardship/cannot-pay → ESCALATED (escalate_to_agent, reason=HARDSHIP)
  → dispute → ESCALATED (escalate_to_agent, reason=DISPUTE)
  → hostile/abusive → 1 warning → CALL_ENDED [ABUSIVE] if repeated
  → DNC request → CALL_ENDED [DO_NOT_CALL]

PTP_COLLECTED / ESCALATED
  → CALL_ENDED (mark_disposition always called — no state exits without a logged disposition)
```

**Enforcement mechanism:** the system prompt states the rule, but the *hard* enforcement is that `send_payment_link`/`log_promise_to_pay` are only exposed as *permitted next actions* after `verify_customer` has returned successfully — the prompt instructs the model to never call these tools before a successful verification result is present in the conversation transcript. For a stricter production build, this would additionally be enforced server-side: the webhook would reject `log_promise_to_pay` / debt-disclosure-adjacent calls for a `session_id` that has no prior successful `verify_customer` record — i.e., a second, independent gate outside the LLM's control.

---

## 3. Intents & Entities

| Intent | Trigger examples | Entities extracted |
|---|---|---|
| `Confirm_Identity` | "Yes, this is Rahul" | — |
| `Provide_Verification` | "1234", "born 1995" | `verification_code` |
| `Promise_To_Pay` | "I'll pay Friday" | `ptp_date` (ISO-8601), `ptp_amount` |
| `Hardship_Claim` | "I lost my job" | `hardship_reason` |
| `Dispute_Debt` | "This isn't mine" | `dispute_reason` |
| `Already_Paid` | "I paid yesterday via UPI" | `payment_date`, `payment_mode`, `reference_no` (optional) |
| `Request_DNC` | "Stop calling me" | — |
| `Wrong_Person` | "There's no Rahul here" | — |
| `Callback_Request` | "Call me after 6pm" | `callback_time` |
| `Hostile` | abusive language | — |
| `Language_Switch` | code-switch to Hindi | `detected_language` |

---

## 4. Tools / API Calls

All tools are invoked by the LLM and answered by the mock webhook (see `mock-server/server.js`).

### `verify_customer(account_id, verification_code) → {verified, message}`
Checks the code against the account record. Must succeed before any debt-related tool or disclosure.

### `log_promise_to_pay(account_id, ptp_date, amount) → {success, ptp_id}`
Persists the PTP commitment. Called only after `AUTHENTICATED`.

### `send_payment_link(account_id, channel) → {success, message}`
Triggers a (mocked) SMS/WhatsApp payment link.

### `escalate_to_agent(account_id, reason) → {success, ticket_id}`
Routes hardship/dispute cases to a human queue. `reason` ∈ {HARDSHIP, DISPUTE, ABUSIVE_ESCALATION, OTHER}.

### `mark_disposition(account_id, status, notes) → {success, timestamp}`
Always called exactly once at call end. `status` ∈ {PTP_AGREED, ALREADY_PAID, DISPUTED, HARDSHIP_ESCALATED, WRONG_PERSON, DO_NOT_CALL, ABUSIVE_TERMINATED, NO_RESPONSE}.

Full JSON Schemas: `vapi/tool_definitions.json`.

---

## 5. Auth & Data Safety

- **No debt disclosure pre-auth:** the words "overdue," "EMI," "loan," "amount," "Kapture Finance debt" are prohibited from the bot's speech until `verify_customer` has returned `verified:true` in that call session.
- **Third-party protection:** if the person who answers isn't confirmed as the target customer, the bot only asks when the target is reachable — it never confirms that the *number* is associated with a loan, an overdue balance, or even Kapture Finance's collections purpose beyond "a personal matter."
- **Verification factor:** last 4 digits of PAN or birth year — something the LMS already holds, not something guessable from public info. In production this would be a stronger 2-factor check (e.g., OTP) rather than PAN digits, which is a reasonable trade-off but not something we'd defend as bank-grade.
- **PII masking in logs:** names logged as `Rahul S****`, phone numbers masked except last 4 digits, verification codes never logged in plaintext.
- **Transcript retention:** call recordings/transcripts retained per regulatory minimum, access-controlled, purged per data retention policy.

---

## 6. Guardrails & Compliance

- **Mandatory disclosure:** every call opens with agent name ("Maya"), company ("Kapture Finance"), and — once relevant — purpose.
- **Calling hours:** outbound dialing restricted to 08:00–19:00 local time (enforced by the dialer/campaign layer, not the LLM).
- **No threats/harassment:** system prompt hard-bans coercive language, repeated calling threats, or implying legal action the company hasn't authorized.
- **Opt-out (DNC):** any do-not-call request is honored immediately — `mark_disposition(DO_NOT_CALL)` and the call ends within one turn, no further negotiation attempted.
- **Unauthorized waivers:** the bot cannot offer discounts/waivers beyond a pre-approved ceiling (e.g., no waiver >10%, no promise of legal forbearance) — anything beyond that routes to `escalate_to_agent`.
- **Off-topic/hallucination guardrail:** the bot stays on the collections task; if asked about unrelated products, unfamiliar policies, or asked to speculate on internal decisions, it says it can't help with that and offers escalation instead of inventing an answer.
- **Abuse handling:** one calm warning, then a polite termination and disposition log — the bot doesn't argue back.

---

## 7. Edge Cases

| Case | Handling |
|---|---|
| Already paid | Ask for date/mode/reference → `mark_disposition(ALREADY_PAID)` → note 24–48h processing time → end |
| Disputes amount | Empathetic acknowledgment → `escalate_to_agent(DISPUTE)` → no argument over the LLM's own reasoning |
| Requests DNC | Immediate `mark_disposition(DO_NOT_CALL)`, no further negotiation |
| Wrong number | Confirm not the target → `mark_disposition(WRONG_NUMBER)` → end, no debt ever mentioned |
| Voicemail / no input | 2 re-prompts with increasing silence tolerance → `mark_disposition(NO_RESPONSE)` → end |
| Abusive caller | 1 warning → repeat abuse → polite termination → `mark_disposition(ABUSIVE_TERMINATED)` |
| Mid-call EN/HI switch | Bot mirrors the customer's language turn-by-turn; state and extracted entities persist across the switch |

---

## 8. Escalation & Disposition

Every terminal path calls `mark_disposition` exactly once — there is no way for a call to end without a logged outcome. Escalation (`escalate_to_agent`) is used for hardship and disputes, and generates a ticket a human agent picks up; the disposition is still logged (`HARDSHIP_ESCALATED` / `DISPUTED`) so the queue has full context on handoff.

---

## 9. Observability

**Logged per call:** account_id (hashed), call duration, full transcript (PII-masked), state transition timeline, tool calls + latencies, final disposition, language(s) used, and a flag for any guardrail near-miss (e.g., model attempted to mention debt pre-auth and was blocked/retried).

**Metrics tracked:**

| Metric | Definition | Why it matters |
|---|---|---|
| Containment rate | % of calls resolved without human escalation | core automation ROI metric |
| PTP rate | % of calls ending in a valid, logged promise-to-pay | primary business outcome |
| Avg latency (turn) | mean STT→TTS-start round trip | user experience / call abandonment risk |
| Drop rate | % of calls ending in silence/hangup with no disposition (should trend to ~0) | signals bugs or bad UX, e.g. bot talking over user |
| Auth failure rate | % of AUTH_PENDING calls that fail verification | fraud signal + UX signal (wrong prompt wording?) |
| Guardrail near-miss rate | times the model attempted a disallowed disclosure/action pre-gate | prompt/compliance regression signal |

---

## 10. Architecture Diagram (Mermaid source)

See `System_Architecture.mmd` (renders directly on GitHub, or paste into mermaid.live to export PNG).

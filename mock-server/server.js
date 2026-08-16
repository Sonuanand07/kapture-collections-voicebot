/**
 * Kapture Finance — Collections Voicebot Mock Webhook Server
 *
 * Implements the tool endpoints called by the Vapi assistant:
 *   verify_customer, log_promise_to_pay, send_payment_link,
 *   escalate_to_agent, mark_disposition
 *
 * Designed to actually deploy (Render / Railway / Fly.io / Heroku), not just
 * run locally: reads PORT from env, has a health check, structured logging,
 * optional shared-secret auth, CORS, and persists call state to a JSON file
 * so a redeploy/restart doesn't lose in-flight disposition data.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

// ---------------------------------------------------------------------------
// Persistence (simple JSON-file store — swap for a real DB in production)
// ---------------------------------------------------------------------------

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const seed = {
      accounts: {
        'ACC-88392': {
          account_id: 'ACC-88392',
          customer_name: 'Rahul Sharma',
          loan_type: 'Personal Loan',
          overdue_amount: 8499,
          days_past_due: 12,
          verification_codes: ['1234', '1995'], // last-4-PAN OR birth year, either passes
          phone_masked: '+91-98XXXXXX21',
        },
      },
      calls: [], // { timestamp, tool, args, result }
      dispositions: [], // { account_id, status, notes, timestamp }
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function writeStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function maskName(name) {
  if (!name) return name;
  const parts = name.split(' ');
  return parts
    .map((p, i) => (i === 0 ? p : p[0] + '*'.repeat(Math.max(p.length - 1, 1))))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true,
  })
);

// Optional shared-secret check for the tool webhook only
function checkSecret(req, res, next) {
  if (!WEBHOOK_SECRET) return next(); // auth disabled if not configured
  const provided = req.header('x-webhook-secret');
  if (provided !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'unauthorized: missing/invalid x-webhook-secret' });
  }
  next();
}

function log(event, payload) {
  console.log(`[${new Date().toISOString()}] ${event}`, JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Health check (used by Render/Railway/uptime monitors)
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'kapture-collections-webhook',
    time: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Convenience: inspect stored calls/dispositions while testing (remove/protect in real prod)
app.get('/debug/store', (req, res) => {
  const store = readStore();
  res.status(200).json({
    calls: store.calls.slice(-50),
    dispositions: store.dispositions.slice(-50),
  });
});

// ---------------------------------------------------------------------------
// Main Vapi tool-call webhook
// ---------------------------------------------------------------------------

app.post('/webhook', checkSecret, (req, res) => {
  try {
    const { message } = req.body || {};

    if (!message || message.type !== 'tool-calls') {
      // Other Vapi lifecycle events (status-update, end-of-call-report, etc.)
      log('event.other', { type: message && message.type });
      return res.status(200).json({ status: 'acknowledged' });
    }

    const toolCalls = message.toolCalls || [];
    const store = readStore();
    const results = [];

    for (const toolCall of toolCalls) {
      const { name, arguments: rawArgs } = toolCall.function || {};
      const callId = toolCall.id;
      const args = typeof rawArgs === 'string' ? safeParse(rawArgs) : rawArgs || {};

      log('tool.received', { name, args });

      let result;
      try {
        result = handleTool(name, args, store);
      } catch (err) {
        log('tool.error', { name, error: err.message });
        result = { success: false, error: err.message };
      }

      store.calls.push({
        timestamp: new Date().toISOString(),
        tool: name,
        args,
        result,
      });

      results.push({
        toolCallId: callId,
        result: JSON.stringify(result),
      });
    }

    writeStore(store);

    return res.status(200).json({ results });
  } catch (err) {
    console.error('Webhook fatal error:', err);
    // Vapi expects a 200 with a results array even on internal errors where possible;
    // fall back to a 500 only for truly unexpected failures so Vapi can retry/log it.
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

function safeParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function handleTool(name, args, store) {
  switch (name) {
    case 'verify_customer':
      return toolVerifyCustomer(args, store);
    case 'log_promise_to_pay':
      return toolLogPromiseToPay(args, store);
    case 'send_payment_link':
      return toolSendPaymentLink(args, store);
    case 'escalate_to_agent':
      return toolEscalateToAgent(args, store);
    case 'mark_disposition':
      return toolMarkDisposition(args, store);
    default:
      return { success: false, message: `Unknown function: ${name}` };
  }
}

function toolVerifyCustomer(args, store) {
  const { account_id, verification_code } = args;
  const account = store.accounts[account_id];

  if (!account) {
    return { verified: false, message: 'Account not found.' };
  }

  const verified = account.verification_codes.includes(String(verification_code).trim());

  return {
    verified,
    message: verified
      ? 'Identity verified successfully.'
      : 'Verification failed. The code provided does not match our records.',
    // Only reveal the name on success — never leak it on a failed attempt
    customer_name: verified ? account.customer_name : undefined,
  };
}

function toolLogPromiseToPay(args, store) {
  const { account_id, ptp_date, amount } = args;
  if (!store.accounts[account_id]) {
    return { success: false, message: 'Account not found.' };
  }
  const ptp_id = `PTP-${Math.floor(1000 + Math.random() * 9000)}`;
  return {
    success: true,
    ptp_id,
    confirmed_date: ptp_date,
    amount,
    message: `Promise to pay of ₹${amount} on ${ptp_date} logged.`,
  };
}

function toolSendPaymentLink(args, store) {
  const { account_id, channel } = args;
  const account = store.accounts[account_id];
  if (!account) {
    return { success: false, message: 'Account not found.' };
  }
  // Mock trigger — swap this block for a real SMS/WhatsApp API call (Twilio, Gupshup, etc.)
  const link = `https://pay.kapturefinance.example/collect/${account_id}`;
  log('payment_link.sent', { account_id: account_id, channel, phone_masked: account.phone_masked, link });
  return {
    success: true,
    link_sent: true,
    channel,
    message: `Payment link sent via ${channel} to registered mobile number ${account.phone_masked}.`,
  };
}

function toolEscalateToAgent(args, store) {
  const { account_id, reason } = args;
  const ticket_id = `TCK-${Math.floor(10000 + Math.random() * 89999)}`;
  return {
    success: true,
    ticket_id,
    reason,
    message: `Escalated to human agent queue (${reason}). Ticket ${ticket_id} created.`,
  };
}

function toolMarkDisposition(args, store) {
  const { account_id, status, notes } = args;
  const entry = {
    account_id,
    status,
    notes: notes || '',
    timestamp: new Date().toISOString(),
  };
  store.dispositions.push(entry);
  return {
    success: true,
    disposition_logged: status,
    timestamp: entry.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

ensureStore();

app.listen(PORT, () => {
  console.log(`Kapture Mock Collections Webhook Server running on port ${PORT}`);
  console.log(`Health check: GET /health`);
  console.log(`Tool webhook: POST /webhook`);
});

module.exports = app;

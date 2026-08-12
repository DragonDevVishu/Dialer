// server.js — run with: node server.js
// Then open http://localhost:3000 in Chrome
//
// This server does three jobs:
// 1. Serves the dialer webpage (index.html)
// 2. Generates a short lived Access Token that the browser uses to
//    connect to Twilio's Voice SDK (this replaces SIP username/password —
//    Twilio does not support plain SIP REGISTER from a browser)
// 3. Answers Twilio's "what do I do with this call" webhook, telling it
//    to dial the number the browser asked for, using whichever of your
//    Twilio numbers the browser selected as the caller ID

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const twilio = require('twilio');
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const app = express();

// Render sits behind a proxy — this is needed so secure cookies work correctly
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change-this-secret-in-env',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: 'auto', // sends secure cookies over https (Render), plain over http (localhost)
      maxAge: 1000 * 60 * 60 * 24 * 7, // stay logged in for 7 days
    },
  })
);

const PORT = process.env.PORT || 3000;

// These all come from your Twilio Console — see SETUP.md
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_CALLER_IDS, // comma separated list of your Twilio numbers, e.g. +19146043745,+447576899043
  FALLBACK_CELL_NUMBER, // your personal cell, e.g. +918329202788 — rung if the browser doesn't answer
} = process.env;

// Parse the comma separated list into a clean array, e.g.
// "+19146043745, +447576899043" -> ["+19146043745", "+447576899043"]
const CALLER_ID_LIST = (TWILIO_CALLER_IDS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

// --- Simple password gate -------------------------------------------------
// Protects the dialer page and every browser-facing route (/, /token,
// /numbers, /status) behind one shared password set via APP_PASSWORD.
// /voice and /incoming are NOT protected — those are called by Twilio
// itself (no browser, no cookie), not by a person.

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Softphone — Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#0f1117;color:#e8eaf6;font-family:'Segoe UI',system-ui,sans-serif;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem;}
  .card{background:#1a1d27;border:1px solid #2e3248;border-radius:20px;width:100%;
    max-width:340px;padding:2rem;box-shadow:0 8px 40px rgba(0,0,0,0.5);text-align:center;}
  h1{font-size:1.2rem;margin-bottom:1.4rem;}
  input{width:100%;background:#22263a;border:1px solid #2e3248;border-radius:8px;
    color:#e8eaf6;font-size:1rem;padding:12px;outline:none;margin-bottom:1rem;}
  input:focus{border-color:#4f6ef7;}
  button{width:100%;padding:10px;border-radius:10px;border:none;font-size:0.9rem;
    font-weight:600;cursor:pointer;background:#4f6ef7;color:#fff;}
  button:hover{opacity:0.88;}
  .error{color:#ef4444;font-size:0.82rem;margin-bottom:1rem;}
</style></head>
<body>
  <div class="card">
    <h1>📞 Softphone Login</h1>
    <form method="POST" action="/login">
      {{ERROR}}
      <input type="password" name="password" placeholder="Password" autofocus required>
      <button type="submit">Unlock</button>
    </form>
  </div>
</body></html>`;

app.get('/login', (req, res) => {
  res.type('html').send(LOGIN_PAGE.replace('{{ERROR}}', ''));
});

app.post('/login', (req, res) => {
  const submitted = (req.body.password || '').trim();
  const expected = (process.env.APP_PASSWORD || '').trim();

  // TEMPORARY debug log — only prints lengths, never the actual password.
  // Remove this once login is working.
  console.log(
    `[login attempt] submitted length=${submitted.length}, expected length=${expected.length}, expected set=${!!process.env.APP_PASSWORD}`
  );

  if (expected && submitted === expected) {
    req.session.authenticated = true;
    return res.redirect('/');
  }
  res
    .type('html')
    .send(
      LOGIN_PAGE.replace(
        '{{ERROR}}',
        '<div class="error">Wrong password. Try again.</div>'
      )
    );
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Everything below this line requires a logged-in session, EXCEPT
// /voice and /incoming, which Twilio itself calls and can't log into.
app.use((req, res, next) => {
  if (
    req.path === '/login' ||
    req.path === '/voice' ||
    req.path === '/incoming'
  ) {
    return next();
  }
  if (req.session && req.session.authenticated) {
    return next();
  }
  if (req.path.startsWith('/token') || req.path.startsWith('/numbers') || req.path.startsWith('/status')) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  return res.redirect('/login');
});

app.use(express.static(__dirname));
// --------------------------------------------------------------------------

function checkConfig(res) {
  const missing = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_API_KEY_SID',
    'TWILIO_API_KEY_SECRET',
    'TWILIO_TWIML_APP_SID',
    'TWILIO_CALLER_IDS',
  ].filter((key) => !process.env[key]);

  if (!missing.length && CALLER_ID_LIST.length === 0) {
    missing.push('TWILIO_CALLER_IDS (empty after parsing)');
  }

  if (missing.length) {
    res.status(500).json({
      error: 'Server is missing Twilio configuration',
      missing,
      hint: 'Fill these in your .env file — see SETUP.md',
    });
    return false;
  }
  return true;
}

// 1. Browser calls this first, on page load, to get a token to connect with
app.get('/token', (req, res) => {
  if (!checkConfig(res)) return;
  const identity = 'dialer-user';
  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: TWILIO_TWIML_APP_SID,
    incomingAllow: true, // lets the browser receive calls routed to it via /incoming
  });
  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY_SID,
    TWILIO_API_KEY_SECRET,
    { identity, ttl: 3600 }
  );
  token.addGrant(voiceGrant);
  res.json({ token: token.toJwt(), identity });
});

// 1b. Browser calls this to find out which Twilio numbers it's allowed to
//     call from, so it can populate the "Call From" dropdown. The server is
//     the source of truth here — the browser can never pick a caller ID
//     that isn't in this list (see /voice below).
app.get('/numbers', (req, res) => {
  if (!checkConfig(res)) return;
  res.json({ numbers: CALLER_ID_LIST });
});

// 2. Twilio calls this URL the moment a call is placed from the browser,
//    asking "who should this call actually reach, and from which number".
//    Configure your TwiML App's Voice Request URL to point here (see SETUP.md).
app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const to = req.body.To;

  // The browser sends the number it wants to call FROM as a custom param
  // named CallerId (set in the device.connect({ params: ... }) call).
  // We only ever trust it if it's in our own configured list — otherwise
  // we fall back to the first configured number. This stops a tampered
  // client from spoofing an arbitrary caller ID.
  const requestedCallerId = req.body.CallerId;
  const callerId = CALLER_ID_LIST.includes(requestedCallerId)
    ? requestedCallerId
    : CALLER_ID_LIST[0];

  if (to && /^[\d+\-() ]+$/.test(to)) {
    const dial = twiml.dial({ callerId });
    dial.number(to);
  } else {
    twiml.say('The number to dial was missing or invalid.');
  }
  res.type('text/xml');
  res.send(twiml.toString());
});

// 3. Twilio calls THIS URL when someone dials one of your real Twilio
//    numbers from the outside world (a real caller on the PSTN). This is
//    NOT hit when you place a call from the browser — that goes to /voice.
//    Configure this as the "A call comes in" webhook on EACH of your
//    Twilio numbers, in the Twilio Console (Phone Numbers → your number →
//    Voice Configuration → A call comes in → Webhook → https://<your
//    render url>/incoming). Do this for both +19146043745 and
//    +447576899043 — they can both point at the same URL.
app.post('/incoming', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const calledNumber = req.body.To; // which of your Twilio numbers was dialed
  const caller = req.body.From; // who's calling

  // Step 1: ring the browser softphone (identity must match /token).
  // If the tab isn't open / nobody answers within 20s, execution falls
  // through to step 2 below.
  const dial = twiml.dial({ timeout: 20 });
  const client = dial.client();
  client.identity('dialer-user');
  client.parameter({ name: 'CalledNumber', value: calledNumber || '' });

  // Step 2: forward to your personal cell. Only reached if step 1 timed
  // out / wasn't answered. Caller ID is set to the Twilio number that was
  // originally dialed, so your phone shows which number the call came in
  // on rather than a raw Twilio-internal number.
  if (FALLBACK_CELL_NUMBER) {
    const cellDial = twiml.dial({
      timeout: 20,
      callerId: calledNumber || CALLER_ID_LIST[0],
    });
    cellDial.number(FALLBACK_CELL_NUMBER);
  }

  // Step 3: only reached if step 2 also wasn't answered (or isn't
  // configured) — take a voicemail instead of just hanging up.
  twiml.say('Sorry, nobody is available right now. Please leave a message after the tone.');
  twiml.record({
    maxLength: 120,
    playBeep: true,
    trim: 'trim-silence',
  });
  twiml.say('No message was received. Goodbye.');
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

// Simple status check so you can confirm the server sees your .env
app.get('/status', (req, res) => {
  const configured =
    [
      'TWILIO_ACCOUNT_SID',
      'TWILIO_API_KEY_SID',
      'TWILIO_API_KEY_SECRET',
      'TWILIO_TWIML_APP_SID',
    ].every((key) => !!process.env[key]) && CALLER_ID_LIST.length > 0;
  res.json({ configured, numbers: CALLER_ID_LIST });
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.listen(PORT, () => {
  console.log(`✅ Twilio dialer running at http://localhost:${PORT}`);
  console.log(`   Open this in Chrome (Twilio's Voice SDK needs a modern browser)`);
  console.log(`   Press Ctrl+C to stop`);
});

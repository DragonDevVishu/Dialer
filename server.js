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
const twilio = require('twilio');
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const app = express();
app.use(express.static(__dirname));
app.use(express.urlencoded({ extended: false }));
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

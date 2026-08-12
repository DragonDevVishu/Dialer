// server.js — run with: node server.js
// Then open http://localhost:3000 in Chrome
//
// This server does two jobs:
// 1. Serves the dialer webpage (index.html)
// 2. Generates a short lived Access Token that the browser uses to
//    connect to Twilio's Voice SDK (this replaces SIP username/password —
//    Twilio does not support plain SIP REGISTER from a browser)
// 3. Answers Twilio's "what do I do with this call" webhook, telling it
//    to dial the number the browser asked for, using your Twilio number
//    as the caller ID

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
  TWILIO_CALLER_ID, // your Twilio phone number, e.g. +14155551234
} = process.env;

function checkConfig(res) {
  const missing = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_API_KEY_SID',
    'TWILIO_API_KEY_SECRET',
    'TWILIO_TWIML_APP_SID',
    'TWILIO_CALLER_ID',
  ].filter((key) => !process.env[key]);

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
    incomingAllow: false, // this dialer only makes outbound calls
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

// 2. Twilio calls this URL the moment a call is placed from the browser,
//    asking "who should this call actually reach". Configure your TwiML
//    App's Voice Request URL to point here (see SETUP.md).
app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const to = req.body.To;

  if (to && /^[\d+\-() ]+$/.test(to)) {
    const dial = twiml.dial({ callerId: TWILIO_CALLER_ID });
    dial.number(to);
  } else {
    twiml.say('The number to dial was missing or invalid.');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// Simple status check so you can confirm the server sees your .env
app.get('/status', (req, res) => {
  const configured = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_API_KEY_SID',
    'TWILIO_API_KEY_SECRET',
    'TWILIO_TWIML_APP_SID',
    'TWILIO_CALLER_ID',
  ].every((key) => !!process.env[key]);
  res.json({ configured });
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.listen(PORT, () => {
  console.log(`✅ Twilio dialer running at http://localhost:${PORT}`);
  console.log(`   Open this in Chrome (Twilio's Voice SDK needs a modern browser)`);
  console.log(`   Press Ctrl+C to stop`);
});

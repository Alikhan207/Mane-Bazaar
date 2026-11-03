# Mane Bazaar

A chat-native assistant for women home sellers in Hubballi. A seller says "hi", picks her language
(Kannada, English or Hindi), and the agent creates her account, sets her profile photo, and records
what she is selling today from text, voice notes (Kannada) or photos.

## Meta models used
- **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`): Kannada and English voice notes to text.
- **Muse Spark 1.3** (`muse-spark-1.3`): conversation in the seller's language, tool calling
  (`save_profile`, `set_todays_items`, `set_profile_photo`, `attach_item_photo`), and vision
  (photo classification, reading item lists from notebook pages).

## Engineering constraint: WhatsApp delivery and what we did instead
WhatsApp is the target channel, because that is where the sellers already are.
1. **Meta WhatsApp Cloud API:** the app, test number and webhook worked and API calls returned HTTP 200 with
   message IDs, but WhatsApp Manager showed the test messaging account as **restricted** (0 messages sent),
   requiring business verification. We had no registered business and chose not to submit details for one
   we do not run. Screenshots: `docs/meta-restriction/`.
2. **Twilio WhatsApp Sandbox:** inbound messages reached our webhook (Twilio logs show "Received" and our server
   logged them). Outbound replies failed: a TwiML reply produced no outgoing message, and a REST send returned
   error 21654 "ContentSid Required". The cause is unconfirmed.
3. **What we shipped:** the same agent behind a **Telegram bot** (no business verification needed).
   Channel code is isolated in `server.js`, so a WhatsApp adapter can replace it once a verified account exists.

## Run it
```
npm i better-sqlite3 dotenv express ffmpeg-static grammy openai
cp .env.example .env   # fill MODEL_API_KEY and TELEGRAM_TOKEN
node server.js         # website on http://localhost:3000
```

## What is new in this repo
Everything here was written from Oct 27, 2026 onward. An earlier prototype (UI and database) existed;
its WhatsApp integration never worked.

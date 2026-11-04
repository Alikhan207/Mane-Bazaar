# Mane Bazaar

**Her shop, in her language, in the chat she already uses.**

Mane Bazaar is a chat-first marketplace for women who run businesses from home and for small farmers in Karnataka. A seller sets up a shop, lists her products and manages her orders entirely from a chat: by speaking Kannada, sending a photo of her notebook, recording a short video, or tapping a button. Her shop appears at once on a public website where buyers can find her and order.

Built for the **Meta Global AI Developer Hackathon 2026**, track *Build for Your World*, on **Meta Model API**.

---

## The problem

Around us in Karnataka, women sell holige, pickles, snacks, children's clothes and tailoring from home, and small farmers sell produce nearby. Their businesses are real but invisible:

- Orders live in a **paper notebook**; sales travel by **word of mouth**.
- Online marketplaces expect **English, typing, forms, photography and a website**.
- With records on paper, there is no clear picture of **what sells, who comes back, or what to prepare**.

Mane Bazaar does not ask them to learn a new app. It turns the chat they already use into a layer that does the digital work for them.

## What it does

### For sellers (in Telegram)

| She does this | Mane Bazaar does this |
|---|---|
| Says "hi" | Asks her language (ಕನ್ನಡ / English / हिंदी) with buttons, then sets up her shop one question at a time |
| Sends a **Kannada voice note** ("holige, 30 rupees, 50 pieces") | Transcribes it, reads the item back, saves it after her "yes" |
| Photographs her **notebook page** | Reads the handwritten list (even sideways), flags unclear digits, adds the items after she confirms |
| Records a **short video** of her batch while saying the prices | Watches the clip and listens to it, combines both into one list |
| Sends a **product photo** | Attaches it to the right item and offers to clean up the background (original always kept) |
| Asks "do I need FSSAI?" | Answers from official sources with links |
| Opens the chat the next morning | Shows her current list and asks *Same as before / Change some items / Start a new list* |
| Sends `/review` | Gets a weekly review: what sold, what didn't, repeat buyers, what to prepare next week |

Every change is **read back and saved only after she says yes**.

### For buyers (public website)

- Browse shops by **home seller or farmer, category, region and delivery terms**.
- Ask in plain words: *"pickles under 200 in Bagalkot?"* An assistant answers **only from live listings** and highlights the matching shops.
- **Order in chat** opens the bot for that shop. The seller is notified instantly, and the buyer gets a **UPI link that pays the seller directly**. Mane Bazaar never holds money.

### For sellers who prefer a screen (private dashboard)

Kannada / English dashboard to open or pause the shop, edit items, move orders from *new* to *handed over*, record payments, read the daily brief and the weekly review, and print a business record.

---

## Meta models used

| Model | What it does here |
|---|---|
| **Muse Spark 1.3** | The agent: tool-calling loop for onboarding, items, photos, orders and payments; reading photos and handwritten notebooks; **native video understanding**; **search grounding** for licence questions; the public website assistant; the daily brief |
| **Muse Voice Transcribe** | Kannada / English / Hindi voice notes, and the speech inside videos |
| **Muse Wonder** | The weekly business review, written from figures computed in code (Muse Spark is the fallback) |
| **Muse Image** | Redraws a product photo on a clean background; the original is kept |
| **SAM 3.1** | Called to locate the named product in the photo before clean-up. *In this version its result is logged, not yet used; the next step is to pass its mask to Muse Image so only the background changes.* |

**Design rule:** every number a seller sees (totals, money due, best sellers, repeat buyers) is **computed in code**. The models explain the numbers; they never produce them.

---

## How it works

```
 Seller / buyer on Telegram                 Public website + seller dashboard
            │                                          │
            ▼                                          ▼
   server.js  (grammY bot)  ─────────────►  Express API  (/api/shops, /api/ask,
            │                                /api/me, /api/review, order actions)
            ▼                                          │
   src/agent.js  ── Muse Spark tool-calling loop ──────┤
   │  tools: save_profile, add_items, update_item,     │
   │  remove_items, attach/polish photo, place_order,  │
   │  update_order, ask_rules, ...                     │
   ▼                                                   ▼
   src/meta.js  ── Meta Model API                src/db.js  ── SQLite (node:sqlite)
      chat completions · responses (video,          sellers · items · orders ·
      web_search, SAM) · asr/transcribe ·           photos · messages · visits
      images/edits
```

The agent core (`src/agent.js`) is channel-independent: it takes a message and returns a reply with optional buttons. Telegram is wired in `server.js`.

---

## Run it

**Requirements:** Node.js **22.5 or newer** (uses the built-in `node:sqlite`), **ffmpeg** on PATH (for voice notes and video audio), a Meta Model API key and a Telegram bot token.

```bash
git clone https://github.com/Alikhan207/Mane-Bazaar.git
cd Mane-Bazaar
npm install
cp .env.example .env        # fill in MODEL_API_KEY and TELEGRAM_TOKEN
node server.js
```

- Website: <http://localhost:3000>
- Bot: message your bot on Telegram and send `/start`

On Windows, ffmpeg installs with `winget install Gyan.FFmpeg`.

### Bot commands

| Command | What it does |
|---|---|
| `/start` | Start or continue onboarding (from a shop link: start an order) |
| `/dashboard` | Private dashboard link and public page link |
| `/brief` | Today's brief |
| `/review` | Weekly business review (Muse Wonder) |
| `/rules [question]` | Licence and registration guidance with sources |
| `/shop` | Leave a shop you were ordering from and go back to your own |

---

## Project structure

```
server.js            Telegram bot, website API, photo clean-up pipeline, morning brief
src/agent.js         Agent prompts and tools, website assistant, weekly review
src/meta.js          Meta Model API calls: chat, transcription, photo and video reading,
                     search grounding, SAM 3.1, Muse Image, UPI links
src/db.js            SQLite schema and small migrations
public/index.html    Public marketplace with filters and the Ask box
public/dashboard.html  Seller dashboard (Kannada / English)
public/app.css       Shared styles
docs/JOURNEY.md      How we built it: what failed and what we did instead
```

---

## Why Telegram and not WhatsApp

WhatsApp is the channel these sellers actually use, and we built for the **WhatsApp Cloud API** first. Meta restricts messaging on test numbers until **business verification**, which we could not honestly complete without a registered business. Twilio's WhatsApp sandbox received our messages but would not send replies. So the live demo runs on **Telegram** with the same agent core, and WhatsApp is the intended production channel. The full story, with screenshots, is in **[docs/JOURNEY.md](docs/JOURNEY.md)**.

## Known limitations

- One Telegram account runs one shop.
- Data is stored in a local SQLite file; this is a prototype, not a hosted service.
- The dashboard is protected by a private link, not a login.
- UPI links are generated, not verified; "paid" means the seller confirmed it.
- SAM 3.1's mask is not yet used in the photo clean-up.
- Licence answers are general guidance, not legal advice.
- Use photos you took yourself; listings are public.

## Built during the hackathon

All code in this repository was written during the Meta Global AI Developer Hackathon (building period Oct 27 – Nov 4, 2026). The commit history starts on Nov 3, 2026.

**Team:** Mohammed Ali Khan

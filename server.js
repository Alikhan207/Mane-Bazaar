import "dotenv/config";
import express from "express";
import fs from "node:fs";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { db, today, ensureSeller } from "./src/db.js";
import { handle, brief } from "./src/agent.js";
import { transcribe, analyzePhoto, segmentItem, polishPhoto, analyzeVideo } from "./src/meta.js";

const TOKEN = process.env.TELEGRAM_TOKEN;
const bot = new Bot(TOKEN);
let BOT_USERNAME = "";

const notify = (chatId, text) => bot.api.sendMessage(chatId, text).catch((e) => console.error("notify:", e.message));
const download = async (ctx) => {
  const f = await ctx.getFile();
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`);
  return Buffer.from(await r.arrayBuffer());
};
// Last set of choices offered per chat, so callback_data can stay short.
const choices = new Map();

const LANGS = ["ಕನ್ನಡ", "English", "हिंदी"];

const say = async (ctx, id, out) => {
  const r = typeof out === "string" ? { text: out, buttons: [] } : out;
  if (!r.buttons?.length) {
    const row = db.prepare("SELECT language FROM sellers WHERE chat_id=?").get(id);
    if (!row?.language) r.buttons = LANGS;
  }
  if (r.buttons?.length) {
    choices.set(id, r.buttons);
    const kb = new InlineKeyboard();
    r.buttons.forEach((b, i) => { kb.text(b.slice(0, 40), "c:" + i); if (i % 2 === 1) kb.row(); });
    return ctx.reply(r.text, { reply_markup: kb });
  }
  choices.delete(id);
  return ctx.reply(r.text);
};

// SAM 3.1 finds the product, Muse Image redraws it on a clean background.
async function polishItem(chatId, info) {
  try {
    const src = fs.readFileSync(info.photo.replace(/^\//, ""));
    const seg = await segmentItem(src, info.name);
    if (seg) console.log("sam: found", info.name);
    const out = await polishPhoto(src, info.name);
    if (!out) {
      return bot.api.sendMessage(chatId, `I could not clean up the ${info.name} photo just now. Your original photo is still on your page.`);
    }
    const file = `uploads/${chatId}-${Date.now()}-clean.jpg`;
    fs.writeFileSync(file, out);
    const row = db.prepare("SELECT photo, original_photo FROM items WHERE id=?").get(info.item_id);
    db.prepare("UPDATE items SET photo=?, original_photo=COALESCE(original_photo,?) WHERE id=?")
      .run("/" + file, row?.photo ?? null, info.item_id);
    await bot.api.sendPhoto(chatId, new InputFile(file),
      { caption: `${info.name}: cleaned up and now on your page. Your original photo is kept.` });
  } catch (e) {
    console.error("polish:", e.message);
    bot.api.sendMessage(chatId, "Sorry, the photo clean-up did not work. Your original photo is unchanged.").catch(() => {});
  }
}

const guard = (fn) => async (ctx) => {
  const id = String(ctx.chat.id);
  ensureSeller(id);
  try {
    await ctx.replyWithChatAction("typing");
    await say(ctx, id, await fn(id, ctx));
  } catch (e) {
    console.error(e);
    await ctx.reply("Sorry, something went wrong. Please try again.");
  }
};

// A tapped choice becomes the buyer's or seller's next message.
bot.on("callback_query:data", async (ctx) => {
  const id = String(ctx.chat?.id || ctx.from.id);
  const picked = choices.get(id)?.[Number(ctx.callbackQuery.data.split(":")[1])];
  await ctx.answerCallbackQuery(picked ? { text: picked.slice(0, 190) } : {});
  if (!picked) return;
  try {
    const original = ctx.callbackQuery.message?.text || "";
    await ctx.editMessageText(`${original}\n\n✓ ${picked}`);
  } catch {
    try { await ctx.editMessageReplyMarkup(); } catch {}
  }
  ensureSeller(id);
  try {
    await ctx.replyWithChatAction("typing");
    await say(ctx, id, await handle(id, picked, notify, polishItem));
  } catch (e) {
    console.error(e);
    await ctx.reply("Sorry, something went wrong. Please try again.");
  }
});

// Deep link from the public site: t.me/<bot>?start=shop_<token>
bot.command("start", guard(async (id, ctx) => {
  const payload = (ctx.match || "").trim();
  if (payload.startsWith("shop_")) {
    db.prepare("INSERT INTO visits(chat_id,shop_token) VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET shop_token=excluded.shop_token")
      .run(id, payload.slice(5));
    return handle(id, "[buyer opened this shop from the website]", notify, polishItem);
  }
  db.prepare("DELETE FROM visits WHERE chat_id=?").run(id);
  return handle(id, "hi", notify, polishItem);
}));

bot.command("shop", guard(async (id) => {
  db.prepare("DELETE FROM visits WHERE chat_id=?").run(id);
  return handle(id, "[switched back to my own shop]", notify, polishItem);
}));

bot.command("dashboard", guard(async (id) => {
  const s = ensureSeller(id);
  const base = process.env.PUBLIC_URL || "http://localhost:3000";
  return { text: `Your dashboard: ${base}/dashboard.html?s=${s.token}\nYour public page: ${base}/#shop-${s.token}\nKeep the dashboard link private.`, buttons: [] };
}));

bot.command("brief", guard(async (id) => {
  const s = ensureSeller(id);
  const b = await brief(id, s.language || "en");
  return { text: b.text || "Nothing to report yet.", buttons: [] };
}));

// Morning brief, once a day at 08:00 in the seller's local time.
async function sendMorningBriefs() {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000); // IST
  if (now.getUTCHours() !== 8) return;
  const day = now.toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT chat_id, language FROM sellers
    WHERE business_name IS NOT NULL AND (brief_sent IS NULL OR brief_sent <> ?)`).all(day);
  for (const r of rows) {
    try {
      const b = await brief(r.chat_id, r.language || "en");
      if (b.text) await bot.api.sendMessage(r.chat_id, "☀ " + b.text);
      db.prepare("UPDATE sellers SET brief_sent=? WHERE chat_id=?").run(day, r.chat_id);
    } catch (e) { console.error("brief push:", e.message); }
  }
}
setInterval(() => sendMorningBriefs().catch(() => {}), 10 * 60 * 1000);

bot.command("rules", guard(async (id, ctx) => {
  const q = (ctx.match || "").trim() || "Which registrations does a small home food seller in Karnataka need, and which are optional at low turnover?";
  return handle(id, "Please look this up for me: " + q, notify, polishItem);
}));

bot.on("message:text", guard((id, ctx) => handle(id, ctx.message.text, notify, polishItem)));

bot.on("message:voice", guard(async (id, ctx) => {
  const text = await transcribe(await download(ctx));
  await ctx.reply("Heard: " + text);
  return handle(id, "[voice note] " + text, notify, polishItem);
}));

// A short clip of today's batch: Muse Spark lists the items it sees.
const onVideo = guard(async (id, ctx) => {
  const v = ctx.message.video || ctx.message.video_note || ctx.message.animation;
  if (v?.file_size && v.file_size > 19 * 1024 * 1024) {
    return { text: "That video is too big for me. Please send a short clip, about 15 seconds.", buttons: [] };
  }
  await ctx.reply("Watching your video…");
  const analysis = await analyzeVideo(await download(ctx));
  return handle(id, `[video] analysis: ${JSON.stringify(analysis)}`, notify, polishItem);
});
bot.on("message:video", onVideo);
bot.on("message:video_note", onVideo);

bot.on("message:photo", guard(async (id, ctx) => {
  const buf = await download(ctx);
  const analysis = await analyzePhoto(buf);
  const file = `uploads/${id}-${Date.now()}.jpg`;
  fs.writeFileSync(file, buf);
  const pid = db.prepare("INSERT INTO photos(chat_id,path,kind) VALUES(?,?,?)").run(id, file, analysis.kind).lastInsertRowid;
  return handle(id, `[photo id=${pid}] analysis: ${JSON.stringify(analysis)}`, notify, polishItem);
}));

const app = express();
app.use("/uploads", express.static("uploads"));
app.use(express.static("public"));

app.get("/api/config", (_q, res) => res.json({ bot: BOT_USERNAME }));

// Public marketplace: no chat ids, no phone numbers.
app.get("/api/shops", (_q, res) => {
  const items = db.prepare("SELECT chat_id,name,price,unit,photo FROM items WHERE day=?").all(today());
  const shops = db.prepare(`SELECT chat_id,token,business_name,name,role,category,area,region,delivery,about,photo,open
    FROM sellers WHERE business_name IS NOT NULL ORDER BY created_at DESC`).all();
  res.json(shops.map((s) => ({
    token: s.token, business_name: s.business_name, seller_name: s.name, role: s.role,
    category: s.category, area: s.area, region: s.region, delivery: s.delivery,
    about: s.about, photo: s.photo, open: !!s.open,
    items: items.filter((i) => i.chat_id === s.chat_id).map(({ chat_id, ...i }) => i),
  })));
});

const bySession = (req) => db.prepare("SELECT * FROM sellers WHERE token=?").get(String(req.query.s || req.params.s || ""));

// Seller dashboard, keyed by the private token the bot sends.
app.get("/api/me", (req, res) => {
  const s = bySession(req);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json({
    shop: { business_name: s.business_name, name: s.name, role: s.role, category: s.category,
      area: s.area, region: s.region, delivery: s.delivery, about: s.about, photo: s.photo,
      language: s.language, open: !!s.open, token: s.token },
    items: db.prepare("SELECT id,name,price,unit,qty,photo FROM items WHERE chat_id=? AND day=?").all(s.chat_id, today()),
    orders: db.prepare("SELECT id,buyer_name,item_name,qty,total,status,paid,ts FROM orders WHERE seller_chat_id=? ORDER BY id DESC").all(s.chat_id),
  });
});

app.use(express.json());

// Dashboard actions. Keyed by the private token the bot sends.
app.post("/api/shop/open", (req, res) => {
  const s = bySession(req);
  if (!s) return res.status(404).json({ error: "not found" });
  const open = req.body?.open ? 1 : 0;
  db.prepare("UPDATE sellers SET open=? WHERE chat_id=?").run(open, s.chat_id);
  notify(s.chat_id, open ? "Your shop is open again on Mane Bazaar." : "Your shop is paused. New orders are paused; existing orders are unchanged.");
  res.json({ ok: true, open: !!open });
});

app.post("/api/items/:id", (req, res) => {
  const s = bySession(req);
  if (!s) return res.status(404).json({ error: "not found" });
  const b = req.body || {};
  if (b.remove) {
    db.prepare("DELETE FROM items WHERE id=? AND chat_id=?").run(req.params.id, s.chat_id);
    return res.json({ ok: true });
  }
  const r = db.prepare(`UPDATE items SET name=COALESCE(?,name), price=COALESCE(?,price),
    unit=COALESCE(?,unit), qty=COALESCE(?,qty) WHERE id=? AND chat_id=?`)
    .run(b.name ?? null, b.price ?? null, b.unit ?? null, b.qty ?? null, req.params.id, s.chat_id);
  res.json(r.changes ? { ok: true } : { error: "not found" });
});

app.post("/api/orders/:id", (req, res) => {
  const s = bySession(req);
  if (!s) return res.status(404).json({ error: "not found" });
  const o = db.prepare("SELECT * FROM orders WHERE id=? AND seller_chat_id=?").get(req.params.id, s.chat_id);
  if (!o) return res.status(404).json({ error: "not found" });
  const b = req.body || {};
  db.prepare("UPDATE orders SET status=COALESCE(?,status), paid=COALESCE(?,paid) WHERE id=?")
    .run(b.status ?? null, b.paid === undefined ? null : (b.paid ? 1 : 0), o.id);
  if (b.status && o.buyer_chat_id) {
    const word = { accepted: "accepted", ready: "ready for you", completed: "completed", declined: "declined" }[b.status];
    if (word) notify(o.buyer_chat_id, `Order #${o.id} (${o.qty} x ${o.item_name}) from ${s.business_name || "the shop"} is ${word}.`);
  }
  res.json({ ok: true });
});

app.get("/api/brief", async (req, res) => {
  const s = bySession(req);
  if (!s) return res.status(404).json({ error: "not found" });
  try { res.json(await brief(s.chat_id, String(req.query.lang || s.language || "en"))); }
  catch (e) { res.status(502).json({ error: String(e.message) }); }
});

app.listen(3000, () => console.log("Website: http://localhost:3000"));
bot.start({ onStart: (b) => { BOT_USERNAME = b.username; console.log("Telegram bot running as @" + b.username); } });

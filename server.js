import "dotenv/config";
import express from "express";
import fs from "node:fs";
import { Bot } from "grammy";
import { db, today } from "./src/db.js";
import { handle } from "./src/agent.js";
import { transcribe, analyzePhoto } from "./src/meta.js";

const TOKEN = process.env.TELEGRAM_TOKEN;
const bot = new Bot(TOKEN);

const ensure = (id) => db.prepare("INSERT OR IGNORE INTO sellers(chat_id) VALUES(?)").run(id);
const download = async (ctx) => {
  const f = await ctx.getFile();
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`);
  return Buffer.from(await r.arrayBuffer());
};
const guard = (fn) => async (ctx) => {
  const id = String(ctx.chat.id);
  ensure(id);
  try {
    await ctx.replyWithChatAction("typing");
    await ctx.reply(await fn(id, ctx));
  } catch (e) {
    console.error(e);
    await ctx.reply("Sorry, something went wrong. Please try again.");
  }
};

bot.on("message:text", guard((id, ctx) => handle(id, ctx.message.text)));

bot.on("message:voice", guard(async (id, ctx) => {
  const text = await transcribe(await download(ctx));
  await ctx.reply("Heard: " + text);
  return handle(id, "[voice note] " + text);
}));

bot.on("message:photo", guard(async (id, ctx) => {
  const buf = await download(ctx);
  const analysis = await analyzePhoto(buf);
  const file = `uploads/${id}-${Date.now()}.jpg`;
  fs.writeFileSync(file, buf);
  const pid = db.prepare("INSERT INTO photos(chat_id,path,kind) VALUES(?,?,?)").run(id, file, analysis.kind).lastInsertRowid;
  return handle(id, `[photo id=${pid}] analysis: ${JSON.stringify(analysis)}`);
}));

const app = express();
app.use("/uploads", express.static("uploads"));
app.use(express.static("public"));
app.get("/api/sellers", (_q, res) => {
  const items = db.prepare("SELECT * FROM items WHERE day=?").all(today());
  res.json(db.prepare("SELECT * FROM sellers ORDER BY created_at DESC").all()
    .map((s) => ({ ...s, chat_id: undefined, items: items.filter((i) => i.chat_id === s.chat_id) })));
});
app.listen(3000, () => console.log("Website: http://localhost:3000"));
bot.start({ onStart: (b) => console.log("Telegram bot running as @" + b.username) });

// Node's built-in SQLite (node:sqlite, Node 22.5+). No npm package, nothing to download.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import crypto from "node:crypto";

fs.mkdirSync("data", { recursive: true });
fs.mkdirSync("uploads", { recursive: true });
const sq = new DatabaseSync("data/mane.db");

export const db = {
  exec: (s) => sq.exec(s),
  prepare(sql) {
    const st = sq.prepare(sql);
    return {
      get: (...a) => st.get(...a),
      all: (...a) => st.all(...a),
      run: (...a) => {
        const r = st.run(...a);
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
    };
  },
};

db.exec(`
CREATE TABLE IF NOT EXISTS sellers(
  chat_id TEXT PRIMARY KEY, token TEXT UNIQUE, name TEXT, business_name TEXT,
  role TEXT, category TEXT, area TEXT, region TEXT, delivery TEXT, about TEXT,
  language TEXT, photo TEXT, open INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, name TEXT,
  price REAL, unit TEXT, qty REAL, photo TEXT, day TEXT);
CREATE TABLE IF NOT EXISTS photos(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, path TEXT,
  kind TEXT, ts TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, role TEXT,
  content TEXT, ts TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT, seller_chat_id TEXT,
  buyer_chat_id TEXT, buyer_name TEXT, item_name TEXT, qty REAL, total REAL, note TEXT,
  status TEXT DEFAULT 'new', paid INTEGER DEFAULT 0, ts TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS visits(chat_id TEXT PRIMARY KEY, shop_token TEXT);
`);

export const today = () => new Date().toISOString().slice(0, 10);

export function ensureSeller(chatId) {
  db.prepare("INSERT OR IGNORE INTO sellers(chat_id,token) VALUES(?,?)")
    .run(chatId, crypto.randomBytes(8).toString("hex"));
  return db.prepare("SELECT * FROM sellers WHERE chat_id=?").get(chatId);
}

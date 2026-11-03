// Node's built-in SQLite (node:sqlite, Node 22.5+). No npm package, nothing to download.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

fs.mkdirSync("data", { recursive: true });
fs.mkdirSync("uploads", { recursive: true });
const sq = new DatabaseSync("data/mane.db");

// Thin better-sqlite3-style wrapper so the rest of the code is unchanged.
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
CREATE TABLE IF NOT EXISTS sellers(chat_id TEXT PRIMARY KEY, name TEXT, business_name TEXT, role TEXT, category TEXT, area TEXT, region TEXT, delivery TEXT, about TEXT, language TEXT, photo TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, name TEXT, price REAL, unit TEXT, qty REAL, photo TEXT, day TEXT);
CREATE TABLE IF NOT EXISTS photos(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, path TEXT, kind TEXT, ts TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, role TEXT, content TEXT, ts TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT, seller_chat_id TEXT, buyer_chat_id TEXT, buyer_name TEXT, details TEXT, total REAL, status TEXT DEFAULT 'new', ts TEXT DEFAULT CURRENT_TIMESTAMP);
`);
export const today = () => new Date().toISOString().slice(0, 10);

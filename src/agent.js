import { db, today } from "./db.js";
import { meta, MODEL } from "./meta.js";

const fn = (name, description, properties = {}, required = []) => ({
  type: "function", function: { name, description, parameters: { type: "object", properties, required } },
});

const tools = [
  fn("save_profile", "Create or update the seller's account details.", {
    language: { type: "string", enum: ["kn", "en", "hi"] }, name: { type: "string" },
    business_name: { type: "string" }, area: { type: "string" },
  }),
  fn("set_todays_items", "Replace today's list of items for sale. Call only after the seller said yes to the read-back.", {
    items: { type: "array", items: { type: "object", properties: {
      name: { type: "string" }, price: { type: "number" }, unit: { type: "string" }, qty: { type: "number" },
    }, required: ["name", "price"] } },
  }, ["items"]),
  fn("set_profile_photo", "Use a photo the seller sent as her profile picture.", { photo_id: { type: "number" } }, ["photo_id"]),
  fn("attach_item_photo", "Attach a photo to one of today's items.", { photo_id: { type: "number" }, item_name: { type: "string" } }, ["photo_id", "item_name"]),
  fn("get_my_shop", "Read the seller's account and today's items."),
];

const getShop = (id) => ({
  seller: db.prepare("SELECT name,business_name,area,language,photo FROM sellers WHERE chat_id=?").get(id),
  today_items: db.prepare("SELECT name,price,unit,qty FROM items WHERE chat_id=? AND day=?").all(id, today()),
});
const photoPath = (id, pid) => db.prepare("SELECT path FROM photos WHERE id=? AND chat_id=?").get(pid, id)?.path;

const exec = {
  save_profile(id, a) {
    db.prepare("UPDATE sellers SET language=COALESCE(?,language), name=COALESCE(?,name), business_name=COALESCE(?,business_name), area=COALESCE(?,area) WHERE chat_id=?")
      .run(a.language ?? null, a.name ?? null, a.business_name ?? null, a.area ?? null, id);
    return getShop(id);
  },
  set_todays_items(id, a) {
    db.prepare("DELETE FROM items WHERE chat_id=? AND day=?").run(id, today());
    const ins = db.prepare("INSERT INTO items(chat_id,name,price,unit,qty,day) VALUES(?,?,?,?,?,?)");
    for (const i of a.items) ins.run(id, i.name, i.price, i.unit ?? null, i.qty ?? null, today());
    return getShop(id);
  },
  set_profile_photo(id, a) {
    const p = photoPath(id, a.photo_id);
    if (!p) return { error: "photo not found" };
    db.prepare("UPDATE sellers SET photo=? WHERE chat_id=?").run("/" + p, id);
    return { ok: true };
  },
  attach_item_photo(id, a) {
    const p = photoPath(id, a.photo_id);
    if (!p) return { error: "photo not found" };
    const r = db.prepare("UPDATE items SET photo=? WHERE chat_id=? AND day=? AND lower(name)=lower(?)").run("/" + p, id, today(), a.item_name);
    return r.changes ? { ok: true } : { error: "item not found in today's list" };
  },
  get_my_shop: (id) => getShop(id),
};

const system = (id) => `You are Mane Bazaar, a friendly helper for women who sell homemade food and goods in Hubballi, India. You talk to them in a chat app.
Current account: ${JSON.stringify(getShop(id))}
Rules:
- If the seller has no language yet, greet in Kannada, English and Hindi and ask which she prefers, then call save_profile with language kn, en or hi. Then ask her name, then her shop name, one question at a time.
- Always reply in her language (kn = Kannada script, hi = Hindi, en = English). Keep messages short and simple.
- When she tells you what she is selling today, read the list back (item, price, unit, quantity) and ask for a yes. Only after yes, call set_todays_items.
- Photos arrive as "[photo id=N] analysis: {...}". If kind is profile, call set_profile_photo right away and tell her. If product, ask which item it belongs to, then call attach_item_photo. If notebook, read the extracted items back for her to confirm.
- Voice notes arrive as "[voice note] transcript". The transcript may have small mistakes, so confirm numbers.
- Never invent prices or quantities. Make no health or nutrition claims.`;

export async function handle(id, text) {
  const hist = db.prepare("SELECT role,content FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 12").all(id).reverse();
  const messages = [{ role: "system", content: system(id) }, ...hist, { role: "user", content: text }];
  for (let i = 0; i < 6; i++) {
    const m = (await meta.chat.completions.create({ model: MODEL, messages, tools })).choices[0].message;
    if (!m.tool_calls?.length) {
      const ins = db.prepare("INSERT INTO messages(chat_id,role,content) VALUES(?,?,?)");
      ins.run(id, "user", text); ins.run(id, "assistant", m.content || "");
      return m.content || "...";
    }
    messages.push(m);
    for (const c of m.tool_calls) {
      let out;
      try { out = exec[c.function.name](id, JSON.parse(c.function.arguments || "{}")); }
      catch (e) { out = { error: String(e.message) }; }
      console.log("tool:", c.function.name, JSON.stringify(out).slice(0, 200));
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out) });
    }
  }
  return "Sorry, something went wrong. Please try again.";
}

import { db, today, ensureSeller } from "./db.js";
import { meta, MODEL } from "./meta.js";

const fn = (name, description, properties = {}, required = []) => ({
  type: "function", function: { name, description, parameters: { type: "object", properties, required } },
});

const CATEGORIES = ["homemade_food", "pickles_masala", "snacks_sweets", "cloth_tailoring", "crafts", "farm_produce", "other"];
const REGIONS = ["Hubballi-Dharwad", "Belagavi", "Bagalkot", "Vijayapura", "Gadag", "Haveri", "Davanagere", "Kalaburagi", "Bengaluru", "Mysuru", "Other Karnataka"];
const DELIVERY = ["pickup_only", "within_hubli", "across_karnataka"];

const tools = [
  fn("save_profile", "Create or update the seller's or farmer's account. Call it as soon as you learn any field; you do not need them all at once.", {
    language: { type: "string", enum: ["kn", "en", "hi"] },
    role: { type: "string", enum: ["home_seller", "farmer"] },
    name: { type: "string" }, business_name: { type: "string" },
    category: { type: "string", enum: CATEGORIES },
    area: { type: "string", description: "Neighbourhood or village, e.g. Vidyanagar" },
    region: { type: "string", enum: REGIONS },
    delivery: { type: "string", enum: DELIVERY },
    about: { type: "string", description: "One or two sentences in her own words, for the public page." },
  }),
  fn("set_todays_items", "Replace today's list of items. Call only after she said yes to the read-back.", {
    items: { type: "array", items: { type: "object", properties: {
      name: { type: "string" }, price: { type: "number" }, unit: { type: "string" }, qty: { type: "number" },
    }, required: ["name", "price"] } },
  }, ["items"]),
  fn("set_profile_photo", "Use a photo she sent as her profile picture.", { photo_id: { type: "number" } }, ["photo_id"]),
  fn("attach_item_photo", "Attach a photo to one of today's items.", { photo_id: { type: "number" }, item_name: { type: "string" } }, ["photo_id", "item_name"]),
  fn("get_my_shop", "Read her account, today's items and her orders."),
  fn("update_order", "Change the status of one of her orders, or mark it paid.", {
    order_id: { type: "number" }, status: { type: "string", enum: ["accepted", "ready", "completed", "declined"] },
    paid: { type: "boolean" },
  }, ["order_id"]),
  fn("set_shop_open", "Open or pause her shop on the public page.", { open: { type: "boolean" } }, ["open"]),
  fn("place_order", "Record an order a BUYER is placing from the shop she is visiting. Call only after reading the order back and getting a yes.", {
    item_name: { type: "string" }, qty: { type: "number" }, buyer_name: { type: "string" }, note: { type: "string" },
  }, ["item_name", "qty", "buyer_name"]),
  fn("list_shops", "List shops on Mane Bazaar for a buyer who has not come from a shop link.", {
    category: { type: "string" }, region: { type: "string" },
  }),
];

const shopOf = (id) => {
  const seller = db.prepare("SELECT name,business_name,role,category,area,region,delivery,about,language,photo,open FROM sellers WHERE chat_id=?").get(id);
  return {
    seller,
    today_items: db.prepare("SELECT name,price,unit,qty FROM items WHERE chat_id=? AND day=?").all(id, today()),
    orders: db.prepare("SELECT id,buyer_name,item_name,qty,total,status,paid FROM orders WHERE seller_chat_id=? ORDER BY id DESC LIMIT 15").all(id),
  };
};
const photoPath = (id, pid) => db.prepare("SELECT path FROM photos WHERE id=? AND chat_id=?").get(pid, id)?.path;
const visiting = (id) => {
  const v = db.prepare("SELECT shop_token FROM visits WHERE chat_id=?").get(id);
  if (!v?.shop_token) return null;
  return db.prepare("SELECT * FROM sellers WHERE token=?").get(v.shop_token) || null;
};

const exec = {
  save_profile(id, a) {
    db.prepare(`UPDATE sellers SET language=COALESCE(?,language), role=COALESCE(?,role), name=COALESCE(?,name),
      business_name=COALESCE(?,business_name), category=COALESCE(?,category), area=COALESCE(?,area),
      region=COALESCE(?,region), delivery=COALESCE(?,delivery), about=COALESCE(?,about) WHERE chat_id=?`)
      .run(a.language ?? null, a.role ?? null, a.name ?? null, a.business_name ?? null, a.category ?? null,
        a.area ?? null, a.region ?? null, a.delivery ?? null, a.about ?? null, id);
    return shopOf(id);
  },
  set_todays_items(id, a) {
    db.prepare("DELETE FROM items WHERE chat_id=? AND day=?").run(id, today());
    const ins = db.prepare("INSERT INTO items(chat_id,name,price,unit,qty,day) VALUES(?,?,?,?,?,?)");
    for (const i of a.items) ins.run(id, i.name, i.price, i.unit ?? null, i.qty ?? null, today());
    return shopOf(id);
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
    const r = db.prepare("UPDATE items SET photo=? WHERE chat_id=? AND day=? AND lower(name)=lower(?)")
      .run("/" + p, id, today(), a.item_name);
    return r.changes ? { ok: true } : { error: "item not in today's list" };
  },
  get_my_shop: (id) => shopOf(id),
  update_order(id, a) {
    const o = db.prepare("SELECT * FROM orders WHERE id=? AND seller_chat_id=?").get(a.order_id, id);
    if (!o) return { error: "order not found" };
    db.prepare("UPDATE orders SET status=COALESCE(?,status), paid=COALESCE(?,paid) WHERE id=?")
      .run(a.status ?? null, a.paid === undefined ? null : (a.paid ? 1 : 0), a.order_id);
    return { ok: true, orders: shopOf(id).orders };
  },
  set_shop_open(id, a) {
    db.prepare("UPDATE sellers SET open=? WHERE chat_id=?").run(a.open ? 1 : 0, id);
    return { ok: true, open: a.open };
  },
  place_order(id, a) {
    const shop = visiting(id);
    if (!shop) return { error: "no shop selected" };
    const item = db.prepare("SELECT name,price FROM items WHERE chat_id=? AND day=? AND lower(name)=lower(?)")
      .get(shop.chat_id, today(), a.item_name);
    if (!item) return { error: "item not on this shop's list today" };
    const total = Math.round(item.price * a.qty * 100) / 100;
    const dupe = db.prepare(`SELECT id FROM orders WHERE buyer_chat_id=? AND seller_chat_id=? AND lower(item_name)=lower(?)
      AND qty=? AND ts > datetime('now','-15 minutes') ORDER BY id DESC LIMIT 1`)
      .get(id, shop.chat_id, item.name, a.qty);
    if (dupe) return { already_placed: true, order_id: dupe.id, item: item.name, qty: a.qty, total,
      note: "This exact order already exists. Do not place it again. Tell the buyer it is already confirmed." };
    const oid = db.prepare("INSERT INTO orders(seller_chat_id,buyer_chat_id,buyer_name,item_name,qty,total,note) VALUES(?,?,?,?,?,?,?)")
      .run(shop.chat_id, id, a.buyer_name, item.name, a.qty, total, a.note ?? null).lastInsertRowid;
    return { ok: true, order_id: oid, item: item.name, qty: a.qty, total, shop: shop.business_name,
      _notify: { chat_id: shop.chat_id, text: `New order #${oid}: ${a.qty} x ${item.name} - Rs ${total}, from ${a.buyer_name}.${a.note ? " Note: " + a.note : ""}` } };
  },
  list_shops(_id, a) {
    let sql = "SELECT business_name,role,category,area,region,delivery,about,token FROM sellers WHERE business_name IS NOT NULL AND open=1";
    const p = [];
    if (a.category) { sql += " AND category=?"; p.push(a.category); }
    if (a.region) { sql += " AND region=?"; p.push(a.region); }
    return db.prepare(sql + " LIMIT 15").all(...p);
  },
};

function system(id) {
  const shop = visiting(id);
  const me = shopOf(id);
  if (shop) {
    const items = db.prepare("SELECT name,price,unit,qty FROM items WHERE chat_id=? AND day=?").all(shop.chat_id, today());
    return `You are Mane Bazaar, helping a BUYER who opened the page of one shop.
Shop: ${JSON.stringify({ business_name: shop.business_name, area: shop.area, region: shop.region, delivery: shop.delivery, about: shop.about })}
Today's items: ${JSON.stringify(items)}
Orders this buyer has ALREADY placed at this shop (do not place these again): ${JSON.stringify(
      db.prepare("SELECT id,item_name,qty,total,status FROM orders WHERE buyer_chat_id=? AND seller_chat_id=? ORDER BY id DESC LIMIT 10")
        .all(id, shop.chat_id))}
Rules:
- Call place_order ONLY when the buyer asks for something new and has just confirmed it in this message or the one before.
- "ok", "thanks", "thank you", "good", a tick or any similar closing word is NOT a new order. Reply with a short acknowledgement and call no tool.
- Never re-place an order that is already in the list above. If the buyer seems to repeat an order, ask whether they want MORE on top of it before calling place_order.
- Greet, name the shop, and list today's items with prices in rupees.
- Ask what she or he wants and how much, then the buyer's name.
- Read the order back with the total, ask for a yes, and only then call place_order.
- Mention the shop's delivery terms before confirming.
- Reply in the buyer's language (Kannada, Hindi or English), short and simple.
- Never invent items or prices. Never promise a delivery time the seller has not given.
TAPPABLE CHOICES: when your message asks the buyer to pick from a small set, end it with one line of the form
[[buttons: First | Second | Third]] (2 to 6 choices, each under 30 characters, in the buyer's language). Use it for
choosing an item and for confirming an order (for example [[buttons: Yes, place the order | No]]). Do not use it for
free text such as a name or a quantity. Never mention the brackets in your words.`;
  }
  return `You are Mane Bazaar, a friendly helper for women who run home businesses and for farmers in Karnataka. You talk to them in a chat app.
Their account: ${JSON.stringify(me)}
Onboarding, one question per message, in this order, calling save_profile as each answer arrives:
1. If no language: greet in Kannada, English and Hindi and ask which she prefers (kn, en, hi).
2. If no role: ask whether she sells homemade things (home_seller) or farm produce (farmer).
3. Name. 4. Shop or farm name. 5. Category, from: ${CATEGORIES.join(", ")}.
6. Area (neighbourhood or village) and region, from: ${REGIONS.join(", ")}.
7. Delivery: pickup_only, within_hubli, or across_karnataka.
8. A one or two sentence description in her own words, for her public page (about).
Then ask what she is selling today.
Rules:
- Always reply in her language (kn = Kannada script, hi = Hindi, en = English). Keep it short and simple.
- When she tells you items, read the list back (item, price, unit, quantity) and ask for a yes. Only after yes, call set_todays_items.
- Photos arrive as "[photo id=N] analysis: {...}". kind profile means call set_profile_photo now. kind product means ask which item, then attach_item_photo. kind notebook means read the extracted items back for her to confirm.
- Voice notes arrive as "[voice note] transcript". The transcript can have small mistakes, so confirm numbers.
- If she asks about orders, money or what to do first, call get_my_shop and answer from it. You may use update_order when she accepts, declines or completes an order, or records payment.
- Never invent prices, quantities or orders. Make no health or nutrition claims. Do not promise loans or credit.
TAPPABLE CHOICES: whenever your message asks her to pick from a small set, end the message with one line of the form
[[buttons: First | Second | Third]] (2 to 6 choices, each under 30 characters, written in her language).
Use it for the language question, seller or farmer, category, region, delivery, and for every yes/no confirmation
(for example [[buttons: Yes, save it | No, change it]]). Do not use it when the answer is free text such as her name,
a price or a description. Never mention the brackets in your words; the app turns that line into buttons.`;
}

function splitButtons(out) {
  const m = /\[\[buttons:([^\]]*)\]\]/i.exec(out || "");
  if (!m) return { text: (out || "").trim(), buttons: [] };
  const buttons = m[1].split("|").map((x) => x.trim()).filter(Boolean).slice(0, 6);
  return { text: (out.slice(0, m.index) + out.slice(m.index + m[0].length)).trim(), buttons };
}

export async function handle(id, text, notify) {
  ensureSeller(id);
  const hist = db.prepare("SELECT role,content FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 12").all(id).reverse();
  const messages = [{ role: "system", content: system(id) }, ...hist, { role: "user", content: text }];
  for (let i = 0; i < 6; i++) {
    const m = (await meta.chat.completions.create({ model: MODEL, messages, tools })).choices[0].message;
    if (!m.tool_calls?.length) {
      const ins = db.prepare("INSERT INTO messages(chat_id,role,content) VALUES(?,?,?)");
      ins.run(id, "user", text); ins.run(id, "assistant", m.content || "");
      const out = splitButtons(m.content);
      return { text: out.text || "...", buttons: out.buttons };
    }
    messages.push(m);
    for (const c of m.tool_calls) {
      let out;
      try { out = exec[c.function.name](id, JSON.parse(c.function.arguments || "{}")); }
      catch (e) { out = { error: String(e.message) }; }
      console.log("tool:", c.function.name, JSON.stringify(out).slice(0, 160));
      if (out?._notify && notify) { notify(out._notify.chat_id, out._notify.text); delete out._notify; }
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out) });
    }
  }
  return { text: "Sorry, something went wrong. Please try again.", buttons: [] };
}

// Website co-pilot: Muse Spark writes the seller's brief from numbers computed in code.
export async function brief(chatId, lang = "en") {
  const s = shopOf(chatId);
  const pending = s.orders.filter((o) => o.status === "new" || o.status === "accepted");
  const unpaid = s.orders.filter((o) => !o.paid && o.status === "completed");
  const facts = {
    items_today: s.today_items.length,
    pending_orders: pending.length,
    pending_value: pending.reduce((a, o) => a + (o.total || 0), 0),
    unpaid_completed: unpaid.length,
    unpaid_value: unpaid.reduce((a, o) => a + (o.total || 0), 0),
    shop_open: !!s.seller?.open,
    profile_complete: !!(s.seller?.business_name && s.seller?.category && s.seller?.region && s.seller?.delivery),
  };
  const r = await meta.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: `Write a short daily brief for a woman running a home business on Mane Bazaar. She reads it on her dashboard.
These are the only facts, and you must not invent or restate any number that is zero: ${JSON.stringify(facts)}
Write two plain sentences: what to do first, then one encouraging or practical line. Skip anything that is zero rather than mentioning it. Do not list numbers that are zero. Do not greet her. No emoji. Under 40 words. Language: ${lang === "kn" ? "Kannada script" : lang === "hi" ? "Hindi" : "English"}. Never mention loans, credit or health.` }],
  });
  return { text: r.choices[0].message.content?.trim() || "", facts };
}

import { db, today, ensureSeller } from "./db.js";
import { meta, MODEL, upiLink, groundedAnswer } from "./meta.js";

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
    upi_id: { type: "string", description: "Her UPI ID, such as name@okaxis, so buyers can pay her directly. Optional; never guess it." },
  }),
  fn("set_todays_items", "Replace her WHOLE list with a new one. Only when she chooses to start a new list. Call only after she said yes to the read-back.", {
    items: { type: "array", items: { type: "object", properties: {
      name: { type: "string" }, price: { type: "number" }, unit: { type: "string" }, qty: { type: "number" },
    }, required: ["name", "price"] } },
  }, ["items"]),
  fn("set_profile_photo", "Use a photo she sent as her profile picture.", { photo_id: { type: "number" } }, ["photo_id"]),
  fn("attach_item_photo", "Attach a photo to one of today's items.", { photo_id: { type: "number" }, item_name: { type: "string" } }, ["photo_id", "item_name"]),
  fn("add_items", "ADD items to today's list, keeping the ones already there. Use this for a notebook photo or when she adds a few more. Call only after she said yes to the read-back.", {
    items: { type: "array", items: { type: "object", properties: {
      name: { type: "string" }, price: { type: "number" }, unit: { type: "string" }, qty: { type: "number" },
    }, required: ["name", "price"] } },
  }, ["items"]),
  fn("update_item", "Change one of her existing items: price, quantity, unit or name. Only the fields given change.", {
    item_name: { type: "string" }, new_name: { type: "string" }, price: { type: "number" },
    unit: { type: "string" }, qty: { type: "number" },
  }, ["item_name"]),
  fn("remove_items", "Take items off her list.", { names: { type: "array", items: { type: "string" } } }, ["names"]),
  fn("keep_items", "She confirmed her list is the same as before. Marks it as checked for today; changes nothing else."),
  fn("polish_item_photo", "Clean up the photo of one of today's items: find the product in the picture and redraw it on a plain background. Ask her first, and tell her the original is kept.", {
    item_name: { type: "string" },
  }, ["item_name"]),
  fn("ask_rules", "Look up registrations or rules for her kind of home business (FSSAI, Udyam, GST, shop licence) using live web search. Use only when she asks about licences, registration, rules or compliance.", {
    question: { type: "string", description: "Her question, rewritten to be specific, e.g. 'Does a home pickle seller in Karnataka with small sales need FSSAI registration?'" },
  }, ["question"]),
  fn("get_my_shop", "Read her account, today\'s items and her orders."),
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
    today_items: db.prepare("SELECT name,price,unit,qty,photo IS NOT NULL AS has_photo FROM items WHERE chat_id=?").all(id),
    items_last_confirmed: db.prepare("SELECT MAX(day) d FROM items WHERE chat_id=?").get(id)?.d || null,
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
      region=COALESCE(?,region), delivery=COALESCE(?,delivery), about=COALESCE(?,about),
      upi_id=COALESCE(?,upi_id) WHERE chat_id=?`)
      .run(a.language ?? null, a.role ?? null, a.name ?? null, a.business_name ?? null, a.category ?? null,
        a.area ?? null, a.region ?? null, a.delivery ?? null, a.about ?? null, a.upi_id ?? null, id);
    return shopOf(id);
  },
  set_todays_items(id, a) {
    db.prepare("DELETE FROM items WHERE chat_id=?").run(id);
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
    const r = db.prepare("UPDATE items SET photo=? WHERE chat_id=? AND lower(name)=lower(?)")
      .run("/" + p, id, a.item_name);
    return r.changes ? { ok: true } : { error: "item not in today's list" };
  },
  add_items(id, a) {
    const ins = db.prepare("INSERT INTO items(chat_id,name,price,unit,qty,day) VALUES(?,?,?,?,?,?)");
    const have = new Set(db.prepare("SELECT lower(name) n FROM items WHERE chat_id=?")
      .all(id).map((r) => r.n));
    let added = 0, skipped = [];
    for (const i of a.items) {
      if (have.has(String(i.name).toLowerCase())) { skipped.push(i.name); continue; }
      ins.run(id, i.name, i.price, i.unit ?? null, i.qty ?? null, today());
      added++;
    }
    return { added, already_listed: skipped, ...shopOf(id) };
  },
  polish_item_photo(id, a) {
    const it = db.prepare("SELECT id,name,photo FROM items WHERE chat_id=? AND lower(name)=lower(?)")
      .get(id, a.item_name);
    if (!it) return { error: "item not in today's list" };
    if (!it.photo) return { error: "that item has no photo yet; ask her to send one" };
    return { _polish: { item_id: it.id, name: it.name, photo: it.photo },
      note: "Tell her you are cleaning up the photo now and it will take a few seconds." };
  },
  async ask_rules(id, a) {
    const lang = db.prepare("SELECT language FROM sellers WHERE chat_id=?").get(id)?.language || "en";
    try { return await groundedAnswer(a.question, lang); }
    catch (e) { return { error: "lookup failed", detail: String(e.message).slice(0, 120) }; }
  },
  update_item(id, a) {
    const r = db.prepare(`UPDATE items SET name=COALESCE(?,name), price=COALESCE(?,price), unit=COALESCE(?,unit),
      qty=COALESCE(?,qty), day=? WHERE chat_id=? AND lower(name)=lower(?)`)
      .run(a.new_name ?? null, a.price ?? null, a.unit ?? null, a.qty ?? null, today(), id, a.item_name);
    return r.changes ? shopOf(id) : { error: "no item with that name; check the list and ask her which one" };
  },
  remove_items(id, a) {
    const del = db.prepare("DELETE FROM items WHERE chat_id=? AND lower(name)=lower(?)");
    const removed = a.names.filter((n) => del.run(id, n).changes);
    return { removed, not_found: a.names.filter((n) => !removed.includes(n)), ...shopOf(id) };
  },
  keep_items(id) {
    db.prepare("UPDATE items SET day=? WHERE chat_id=?").run(today(), id);
    return { ok: true, ...shopOf(id) };
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
    const item = db.prepare("SELECT name,price FROM items WHERE chat_id=? AND lower(name)=lower(?)")
      .get(shop.chat_id, a.item_name);
    if (!item) return { error: "item not on this shop's list today" };
    const total = Math.round(item.price * a.qty * 100) / 100;
    const dupe = db.prepare(`SELECT id FROM orders WHERE buyer_chat_id=? AND seller_chat_id=? AND lower(item_name)=lower(?)
      AND qty=? AND ts > datetime('now','-15 minutes') ORDER BY id DESC LIMIT 1`)
      .get(id, shop.chat_id, item.name, a.qty);
    if (dupe) return { already_placed: true, order_id: dupe.id, item: item.name, qty: a.qty, total,
      note: "This exact order already exists. Do not place it again. Tell the buyer it is already confirmed." };
    const oid = db.prepare("INSERT INTO orders(seller_chat_id,buyer_chat_id,buyer_name,item_name,qty,total,note) VALUES(?,?,?,?,?,?,?)")
      .run(shop.chat_id, id, a.buyer_name, item.name, a.qty, total, a.note ?? null).lastInsertRowid;
    const pay = upiLink({ vpa: shop.upi_id, name: shop.business_name, amount: total, note: `Mane Bazaar order ${oid}` });
    return { ok: true, order_id: oid, item: item.name, qty: a.qty, total, shop: shop.business_name,
      payment_link: pay || undefined,
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
    const items = db.prepare("SELECT name,price,unit,qty FROM items WHERE chat_id=?").all(shop.chat_id);
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
- place_order may return a payment_link. If it does, give it to the buyer on its own line and say it opens their UPI app and pays the seller directly, and that Mane Bazaar does not take the money. If there is no link, say payment is on pickup or delivery, as the seller arranges.
- Reply in the buyer's language (Kannada, Hindi or English), short and simple.
- Never invent items or prices. Never promise a delivery time the seller has not given.
${me.seller?.business_name ? `- This buyer also runs their own shop (${me.seller.business_name}). When the order is done, tell them in one line that they can send /shop to go back to managing it.` : ""}
TAPPABLE CHOICES: when your message asks the buyer to pick from a small set, end it with one line of the form
[[buttons: First | Second | Third]] (2 to 6 choices, each under 30 characters, in the buyer's language). Use it for
choosing an item and for confirming an order (for example [[buttons: Yes, place the order | No]]). Do not use it for
free text such as a name or a quantity. Never mention the brackets in your words.`;
  }
  return `You are Mane Bazaar, a friendly helper for women who run home businesses and for farmers in Karnataka. You talk to them in a chat app.
Their account: ${JSON.stringify(me)}
${me.today_items.length && me.items_last_confirmed && me.items_last_confirmed !== today()
  ? `DAILY CHECK: her list was last confirmed on ${me.items_last_confirmed}, not today. Before anything else, show her current items in one short numbered list (name and price) and ask whether anything changed, with [[buttons: Same as before | Change some items | Start a new list]]. "Same as before" means call keep_items. "Change some items" means ask what to add, remove or change, then use add_items, update_item or remove_items. "Start a new list" means take the new list, read it back, and call set_todays_items after a yes. If her first message today already says what changed, skip the question and do it.`
  : ""}
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
- Her items stay listed from day to day until she changes them. When she tells you new items, read them back (item, price, unit, quantity), ask for a yes, then call add_items. Use update_item to change a price, quantity, unit or name, and remove_items to take items off. Use set_todays_items only when she chooses to start a new list. Never re-list items she already has.
- Photos arrive as "[photo id=N] analysis: {...}". kind profile means call set_profile_photo now. kind product means ask which item, then attach_item_photo, and afterwards offer once to clean up the photo background with polish_item_photo.
- kind notebook means she photographed her paper book. Read the extracted items back as a numbered list: name, price per unit, unit, quantity. Mention anything in notes (such as an offer) in one line. For any item with an unsure field or a missing price, ask about that item specifically instead of guessing. Ask for a yes, then call add_items (not set_todays_items, so nothing she already listed is lost).
- When she corrects a number, use exactly what she says and read the whole list back again before saving.
- Videos arrive as "[video] analysis: {...}" with the items seen in her clip, and sometimes "What she said in the video: ...". Combine both: what she said is the best source for names, prices and quantities, and what was seen confirms which items. Read the combined list back, ask only for whatever is still missing, then ask for a yes and call add_items. Never invent prices.
- If she asks about FSSAI, Udyam, GST, licences or rules, call ask_rules. Reply with its answer in short sentences and then list the sources as plain links on their own lines. Keep its wording on what the law requires; do not soften a requirement into something optional.
- Ask for her UPI ID once, after the shop is set up, so buyers can pay her directly. Make clear it is optional and that Mane Bazaar never holds her money. Save it with save_profile. Never invent a UPI ID.
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

export async function handle(id, text, notify, onPolish) {
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
      try { out = await exec[c.function.name](id, JSON.parse(c.function.arguments || "{}")); }
      catch (e) { out = { error: String(e.message) }; }
      console.log("tool:", c.function.name, JSON.stringify(out).slice(0, 160));
      if (out?._notify && notify) { notify(out._notify.chat_id, out._notify.text); delete out._notify; }
      if (out?._polish && onPolish) { onPolish(id, out._polish); delete out._polish; }
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

// Website assistant: answers a visitor's question from the live listings. Read-only; ordering stays in chat.
export async function askMarket(question) {
  const searchTool = fn("search_listings", "Search the live Mane Bazaar listings. Leave a filter out to search more widely.", {
    text: { type: "string", description: "Words to match in item names or shop descriptions, e.g. 'pickle', 'holige', 'baby suit'" },
    category: { type: "string" }, region: { type: "string" },
    max_price: { type: "number", description: "Highest price per unit in rupees" },
  });
  const search = (a) => {
    let sql = `SELECT s.token, s.business_name, s.category, s.area, s.region, s.delivery, s.about,
      i.name AS item, i.price, i.unit FROM items i JOIN sellers s ON s.chat_id = i.chat_id
      WHERE s.business_name IS NOT NULL AND s.open = 1`;
    const p = [];
    if (a.text) {
      const words = String(a.text).toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 4);
      if (words.length) {
        sql += " AND (" + words.map(() => "(lower(i.name) LIKE ? OR lower(s.about) LIKE ? OR lower(s.business_name) LIKE ?)").join(" OR ") + ")";
        for (const w of words) p.push(`%${w}%`, `%${w}%`, `%${w}%`);
      }
    }
    if (a.category) { sql += " AND s.category = ?"; p.push(a.category); }
    if (a.region) { sql += " AND lower(s.region) LIKE ?"; p.push(`%${String(a.region).toLowerCase()}%`); }
    if (a.max_price) { sql += " AND i.price <= ?"; p.push(a.max_price); }
    return db.prepare(sql + " ORDER BY i.price LIMIT 25").all(...p);
  };
  const messages = [
    { role: "system", content: `You help visitors of the Mane Bazaar website find home-made food, clothes and farm produce from small sellers in Karnataka.
Always call search_listings before answering. Answer in the visitor's language, in at most 4 short sentences.
Name the shop, the item and the price per unit from the results only; never invent shops, items or prices. If nothing matches, say so and suggest a broader search.
End with one line saying they can tap "Order in chat" on the shop to order. Do not take orders or ask for personal details here.
Categories: homemade_food, pickles_masala, snacks_sweets, cloth_tailoring, crafts, farm_produce, other.` },
    { role: "user", content: String(question).slice(0, 300) },
  ];
  const found = new Map();
  for (let i = 0; i < 3; i++) {
    const m = (await meta.chat.completions.create({ model: MODEL, messages, tools: [searchTool] })).choices[0].message;
    if (!m.tool_calls?.length) {
      return { text: (m.content || "").trim(), shops: [...found.values()].slice(0, 4) };
    }
    messages.push(m);
    for (const c of m.tool_calls) {
      let rows = [];
      try { rows = search(JSON.parse(c.function.arguments || "{}")); } catch {}
      for (const r of rows) if (!found.has(r.token)) found.set(r.token, { token: r.token, name: r.business_name });
      messages.push({ role: "tool", tool_call_id: c.id,
        content: JSON.stringify(rows.map(({ token, ...r }) => r)) });
    }
  }
  return { text: "Sorry, I could not find an answer just now.", shops: [] };
}


// ---- Weekly business review: numbers computed in code, story written by Muse Wonder ----
export function businessFacts(chatId) {
  const orders = db.prepare(`SELECT id, buyer_chat_id, buyer_name, item_name, qty, total, status, paid, ts
    FROM orders WHERE seller_chat_id=? AND status <> 'declined' ORDER BY ts`).all(chatId);
  const since = (days) => new Date(Date.now() - days * 86400000).toISOString().replace("T", " ").slice(0, 19);
  const week = orders.filter((o) => o.ts >= since(7));
  const prevWeek = orders.filter((o) => o.ts >= since(14) && o.ts < since(7));
  const sum = (list) => Math.round(list.reduce((a, o) => a + (o.total || 0), 0));

  const byItem = {};
  for (const o of week) {
    const k = o.item_name;
    byItem[k] ??= { item: k, orders: 0, units: 0, revenue: 0 };
    byItem[k].orders++; byItem[k].units += o.qty || 0; byItem[k].revenue += o.total || 0;
  }
  const items = Object.values(byItem).sort((a, b) => b.revenue - a.revenue)
    .map((x) => ({ ...x, revenue: Math.round(x.revenue) }));

  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const byDay = {};
  for (const o of week) {
    const d = days[new Date(o.ts.replace(" ", "T") + "Z").getDay()];
    byDay[d] = (byDay[d] || 0) + (o.total || 0);
  }

  const buyerCounts = {};
  for (const o of orders) buyerCounts[o.buyer_chat_id || o.buyer_name] = (buyerCounts[o.buyer_chat_id || o.buyer_name] || 0) + 1;
  const buyers = Object.keys(buyerCounts).length;
  const repeat = Object.values(buyerCounts).filter((n) => n > 1).length;

  const listed = db.prepare("SELECT name FROM items WHERE chat_id=?").all(chatId).map((r) => r.name);
  const notSold = listed.filter((n) => !byItem[n]);
  const firstDay = orders[0]?.ts?.slice(0, 10) || null;
  const historyDays = firstDay ? Math.max(1, Math.round((Date.now() - Date.parse(firstDay)) / 86400000)) : 0;

  return {
    this_week: { orders: week.length, revenue: sum(week),
      received: sum(week.filter((o) => o.paid)), still_due: sum(week.filter((o) => !o.paid)) },
    last_week: { orders: prevWeek.length, revenue: sum(prevWeek) },
    items_this_week: items,
    listed_but_not_sold_this_week: notSold,
    sales_by_day_this_week: Object.fromEntries(Object.entries(byDay).map(([k, v]) => [k, Math.round(v)])),
    buyers_all_time: buyers, repeat_buyers_all_time: repeat,
    history_days: historyDays,
  };
}

const reviewCache = new Map();

export async function weeklyReview(chatId, lang = "en") {
  const key = `${chatId}:${lang}:${new Date().toISOString().slice(0, 10)}`;
  if (reviewCache.has(key)) return reviewCache.get(key);
  const facts = businessFacts(chatId);
  if (!facts.this_week.orders && !facts.last_week.orders) {
    return { text: lang === "kn" ? "ಈ ವಾರ ಇನ್ನೂ ಆರ್ಡರ್‌ಗಳಿಲ್ಲ. ಆರ್ಡರ್ ಬಂದ ನಂತರ ಇಲ್ಲಿ ನಿಮ್ಮ ವಾರದ ವಿಮರ್ಶೆ ಕಾಣುತ್ತದೆ."
      : "No orders yet this week. Your weekly review will appear here once orders come in.", facts, model: null };
  }
  const langName = lang === "kn" ? "Kannada script" : lang === "hi" ? "Hindi" : "English";
  const prompt = `You are writing a weekly business review for a woman who runs a small home business on Mane Bazaar. She reads it on her phone.
Use ONLY these figures, computed from her real orders. Do not invent any number, item, customer or trend:
${JSON.stringify(facts)}
Write, in ${langName}, in plain short sentences:
1. How the week went: orders, money that came in, money still due, and the change from last week if last week had orders.
2. What sold best, and what is listed but did not sell.
3. Repeat buyers: how many came back, and one practical idea to keep them.
4. One or two concrete suggestions for next week (what to make more of, what to cut back, which day to have stock ready), each tied to a figure above.
5. Seasonal trends: only if history_days is 60 or more. Otherwise say in one line that seasonal patterns will show after a few months of orders.
Keep it under 160 words. No greeting, no emoji, no headings. Never mention loans, credit scores or health.`;
  // Muse Wonder gets one try (it reasons longer); Muse Spark is the fallback so she always gets a review.
  const once = async (model) => {
    const r = await fetch("https://api.meta.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(90000),
    });
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 150)}`);
    return r.json();
  };
  for (const model of ["muse-wonder-1.0", MODEL]) {
    try {
      const r = model === MODEL
        ? await meta.chat.completions.create({ model, messages: [{ role: "user", content: prompt }] })
        : await once(model);
      const text = r.choices?.[0]?.message?.content?.trim();
      if (text) {
        console.log("review written by", model);
        const out = { text, facts, model };
        reviewCache.set(key, out);
        return out;
      }
    } catch (e) { console.log(`review (${model}) failed:`, String(e.message).slice(0, 120)); }
  }
  throw new Error("review unavailable");
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const KEY = process.env.MODEL_API_KEY;
export const MODEL = process.env.MODEL || "muse-spark-1.3";
// Plain fetch to Meta's OpenAI-compatible Chat Completions endpoint (no extra npm package).
export const meta = { chat: { completions: { create: async (body) => {
  const r = await fetch("https://api.meta.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`chat ${r.status}: ${await r.text()}`);
  return r.json();
} } } };

// Muse Voice Transcribe accepts mono 16-bit WAV, so convert Telegram's OGG first.
export async function transcribe(oggBuf) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-"));
  const inP = path.join(dir, "in.ogg"), outP = path.join(dir, "out.wav");
  try {
    await fs.writeFile(inP, oggBuf);
    await run(ffmpeg, ["-y", "-i", inP, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-map_metadata", "-1", outP]);
    const fd = new FormData();
    fd.append("request", new Blob([JSON.stringify({
      mode: "PUSH_TO_TALK", model: "muse-voice-transcribe-1.0", audioEncoding: "WAV",
      languageBias: ["Kannada", "English", "Hindi"], keywords: ["Mane Bazaar", "Hubballi"],
    })], { type: "application/json" }));
    fd.append("audio", new Blob([await fs.readFile(outP)], { type: "audio/wav" }), "voice.wav");
    const r = await fetch("https://api.meta.ai/v1/asr/transcribe", {
      method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: fd,
    });
    if (!r.ok) throw new Error(`transcribe ${r.status}: ${await r.text()}`);
    return (await r.json()).transcript || "";
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Muse Spark vision: classify a photo and read item lists from notebook pages.
export async function analyzePhoto(buf) {
  const prompt = 'Classify this photo sent by a home seller in India. Reply with JSON only: {"kind":"profile|product|notebook|other","description":"one short sentence","items":[{"name":"","price":null,"qty":null}]}. profile = a person\'s portrait; product = food or goods for sale; notebook = a handwritten or printed list of items or orders (fill items, any language). Otherwise items is [].';
  const r = await meta.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` } },
    ] }],
  });
  const t = r.choices[0].message.content || "";
  try { return JSON.parse(t.replace(/```json|```/g, "").trim()); }
  catch { return { kind: "other", description: t.slice(0, 200), items: [] }; }
}

// SAM 3.1: find the product in a messy photo. Returns boxes/masks, or null if the call fails.
export async function segmentItem(buf, noun) {
  try {
    const r = await fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sam-3.1",
        input: [{ role: "user", content: [
          { type: "input_text", text: noun },
          { type: "input_image", image_url: `data:image/jpeg;base64,${buf.toString("base64")}` },
        ] }],
      }),
    });
    if (!r.ok) { console.log("sam:", r.status, (await r.text()).slice(0, 200)); return null; }
    return await r.json();
  } catch (e) { console.log("sam failed:", e.message); return null; }
}

// Muse Image: redraw the product on a clean background. Returns a JPEG buffer, or null.
export async function polishPhoto(buf, noun) {
  const prompt = `A clean product photo of this ${noun} for a small home seller's online shop. Keep the food or item exactly as it is, same colours, same amount, nothing added or removed. Replace the background with a plain soft neutral surface and even light. No text, no logos, no watermarks, no people.`;
  try {
    const fd = new FormData();
    fd.append("model", "muse-image-1.0");
    fd.append("prompt", prompt);
    fd.append("image", new Blob([buf], { type: "image/jpeg" }), "item.jpg");
    const r = await fetch("https://api.meta.ai/v1/images/edits", {
      method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: fd,
    });
    if (!r.ok) { console.log("muse-image:", r.status, (await r.text()).slice(0, 300)); return null; }
    const j = await r.json();
    const first = j.data?.[0] || j;
    if (first.b64_json) return Buffer.from(first.b64_json, "base64");
    if (first.url) {
      const img = await fetch(first.url);
      if (img.ok) return Buffer.from(await img.arrayBuffer());
    }
    console.log("muse-image: no image in response", JSON.stringify(j).slice(0, 200));
    return null;
  } catch (e) { console.log("muse-image failed:", e.message); return null; }
}

// A UPI deep link the buyer can tap to pay. No money moves through Mane Bazaar.
export function upiLink({ vpa, name, amount, note }) {
  if (!vpa || !/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(vpa)) return null;
  const p = new URLSearchParams({ pa: vpa, pn: name || "Mane Bazaar seller", cu: "INR" });
  if (amount) p.set("am", String(amount));
  if (note) p.set("tn", note.slice(0, 40));
  return "upi://pay?" + p.toString();
}

const ITEMS_PROMPT = 'This is a short video from a home seller in India showing what she is selling today. List every distinct item you can see. Reply with JSON only: {"items":[{"name":"","qty_seen":null,"notes":""}],"description":"one short sentence"}. Use the common Indian name for each food or product. qty_seen is a rough count only if it is clearly visible, otherwise null. Never invent prices.';

function parseJson(t) {
  try { return JSON.parse(String(t || "").replace(/```json|```/g, "").trim()); } catch { return null; }
}

// Muse Spark video understanding. Tries native video input first; if the API rejects it,
// falls back to sampling frames with ffmpeg and sending them as images. Logs which path ran.
export async function analyzeVideo(buf) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mbv-"));
  try {
    const inP = path.join(dir, "in.mp4");
    await fs.writeFile(inP, buf);

    // 1. Native video through the Responses API.
    try {
      const r = await fetch("https://api.meta.ai/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          input: [{ role: "user", content: [
            { type: "input_text", text: ITEMS_PROMPT },
            { type: "input_video", video_url: `data:video/mp4;base64,${buf.toString("base64")}` },
          ] }],
        }),
      });
      if (r.ok) {
        const j = await r.json();
        const text = j.output_text ?? (j.output || []).flatMap((o) => o.content || [])
          .filter((c) => c.type === "output_text").map((c) => c.text).join("");
        const parsed = parseJson(text);
        if (parsed) { console.log("video: native"); return { ...parsed, via: "native" }; }
      } else {
        console.log("video native:", r.status, (await r.text()).slice(0, 200));
      }
    } catch (e) { console.log("video native failed:", e.message); }

    // 2. Fallback: six frames spread across the clip, sent as images.
    await run(ffmpeg, ["-y", "-i", inP, "-vf", "fps=1/2,scale=640:-2", "-frames:v", "6",
      path.join(dir, "f%02d.jpg")]);
    const frames = (await fs.readdir(dir)).filter((f) => f.startsWith("f")).sort();
    if (!frames.length) throw new Error("no frames extracted");
    const content = [{ type: "text", text: ITEMS_PROMPT + " These are frames sampled in order from the video." }];
    for (const f of frames) {
      const b = await fs.readFile(path.join(dir, f));
      content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b.toString("base64")}` } });
    }
    const r2 = await meta.chat.completions.create({ model: MODEL, messages: [{ role: "user", content }] });
    const parsed = parseJson(r2.choices[0].message.content) || { items: [], description: "" };
    console.log("video: frames", frames.length);
    return { ...parsed, via: "frames" };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Search grounding: answer a compliance question with live sources.
export async function groundedAnswer(question, lang = "en") {
  const langName = lang === "kn" ? "Kannada" : lang === "hi" ? "Hindi" : "English";
  const instructions = `You help a small home-food or home-craft seller in Karnataka, India understand registrations such as FSSAI, Udyam, GST or a shop licence.
Answer in ${langName}, in at most 5 short sentences, simply. Prefer official government sources (fssai.gov.in, udyamregistration.gov.in, gst.gov.in, karnataka.gov.in).
Say clearly when something depends on her turnover or situation. This is general guidance, not legal advice; say so in one short line. Never say she must stop selling.`;
  const r = await fetch("https://api.meta.ai/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, instructions, input: question, tools: [{ type: "web_search" }] }),
  });
  if (!r.ok) throw new Error(`grounding ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const parts = (j.output || []).flatMap((o) => o.content || []).filter((c) => c.type === "output_text");
  const text = j.output_text ?? parts.map((c) => c.text).join("");
  const seen = new Set(), sources = [];
  for (const c of parts) for (const a of c.annotations || []) {
    const url = a.url || a.url_citation?.url;
    if (url && !seen.has(url)) { seen.add(url); sources.push({ title: a.title || a.url_citation?.title || url, url }); }
  }
  return { text: (text || "").trim(), sources: sources.slice(0, 4) };
}

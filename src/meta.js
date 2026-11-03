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
export const meta = {
  chat: {
    completions: {
      create: async (body) => {
        const r = await fetch("https://api.meta.ai/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`chat ${r.status}: ${await r.text()}`);
        return r.json();
      }
    }
  }
};

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
    messages: [{
      role: "user", content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` } },
      ]
    }],
  });
  const t = r.choices[0].message.content || "";
  try { return JSON.parse(t.replace(/```json|```/g, "").trim()); }
  catch { return { kind: "other", description: t.slice(0, 200), items: [] }; }
}
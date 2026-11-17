// Jarvis za Telegram: prima poruke preko Telegram Bot API webhooka,
// pita Google Gemini (besplatni API) i šalje odgovor natrag u isti razgovor.
// Besplatno: Telegram bot (bez registracije preduzeća) + besplatni Gemini ključ.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Nedostaje varijabla okruženja ${name} (vidi .env.example)`);
  return v;
};

const PORT = Number(process.env.PORT || 3000);
const TG_TOKEN = env("TELEGRAM_BOT_TOKEN");
// Samo ovi chat ID-evi smiju razgovarati (zarezom odvojeni). Prazno = svatko tko nađe bota.
const ALLOWED = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || "Jarvis";
const USER_NAME = process.env.USER_NAME || "";
const ABOUT_ME = process.env.ABOUT_ME || "";
const HISTORY_FILE = process.env.HISTORY_FILE || "./history.json";
const MAX_TURNS = 30;
// Bazni URL servera (Render ga sam postavi kao RENDER_EXTERNAL_URL); služi za automatsko spajanje webhooka.
const BASE_URL = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || "";
// Tajni token da samo Telegram smije slati na /webhook (izveden iz bot tokena).
const WH_SECRET = crypto.createHash("sha256").update(TG_TOKEN).digest("hex").slice(0, 40);

const TG = `https://api.telegram.org/bot${TG_TOKEN}`;

const GEMINI_KEY = env("GEMINI_API_KEY");
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM = `Ti si ${ASSISTANT_NAME}, osobni AI asistent koji s korisnikom razgovara preko Telegrama.
Ton: smiren, uglađen i koristan, s malo diskretnog humora.${USER_NAME ? ` Korisnika oslovljavaj s "${USER_NAME}".` : ""}
Odgovaraj na jeziku kojim ti se korisnik obrati (najčešće hrvatski/bosanski).
Ovo je chat na mobitelu: piši kratko i jasno, koristi kratke odlomke i liste s crticama kad pomažu. Piši običan tekst, bez markdown oznaka (#, **).
Ne možeš upravljati telefonom, slati poruke drugim ljudima ni pretraživati internet; ako se to traži, reci kako to korisnik može brzo sam napraviti.${ABOUT_ME ? `\n\nŠto znaš o korisniku:\n${ABOUT_ME}` : ""}`;

// ---------- povijest razgovora (po chat ID-u) ----------
let history = {};
try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch { history = {}; }
function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); } catch (e) { console.warn("Ne mogu spremiti povijest:", e.message); }
}
function turnsFor(chatId) {
  const t = history[chatId] || [];
  while (t.length && t[0].role !== "user") t.shift();
  return t;
}

// ---------- Telegram slanje ----------
async function sendTelegram(chatId, body) {
  for (let rest = body; rest.length; ) { // Telegram: do 4096 znakova po poruci
    let cut = rest.length <= 4000 ? rest.length : rest.lastIndexOf("\n", 4000);
    if (cut < 1000) cut = Math.min(4000, rest.length);
    const text = rest.slice(0, cut);
    rest = rest.slice(cut).trimStart();
    const res = await fetch(`${TG}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) console.error("Telegram greška pri slanju:", res.status, await res.text());
  }
}
async function sendTyping(chatId) {
  fetch(`${TG}/sendChatAction`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

// ---------- Gemini ----------
async function askGemini(chatId, text) {
  const turns = turnsFor(chatId);
  turns.push({ role: "user", content: text });
  const now = new Date().toLocaleString("hr-HR", { dateStyle: "full", timeStyle: "short", timeZone: process.env.TZ || "Europe/Sarajevo" });

  const contents = turns.slice(-MAX_TURNS).map((t) => ({
    role: t.role === "assistant" ? "model" : "user",
    parts: [{ text: t.content }],
  }));

  let reply;
  try {
    const res = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(GEMINI_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `${SYSTEM}\n\nTrenutni datum i vrijeme: ${now}.` }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
      }),
    });
    if (!res.ok) {
      const t = await res.text(); turns.pop();
      if (res.status === 429) return "Previše poruka u kratkom vremenu (besplatna granica Geminija). Pričekaj minutu pa pokušaj ponovno.";
      if (res.status === 400 && /API key/i.test(t)) { console.error("Neispravan GEMINI_API_KEY"); return "Asistent nije ispravno podešen (Gemini ključ)."; }
      console.error("Gemini greška:", res.status, t.slice(0, 300));
      return "Gemini trenutno nije dostupan. Pokušaj malo kasnije.";
    }
    const data = await res.json();
    const cand = data.candidates?.[0];
    reply = cand?.content?.parts?.map((p) => p.text).filter(Boolean).join("").trim();
    if (!reply) {
      turns.pop();
      if (cand?.finishReason === "SAFETY") return "Na to ne mogu odgovoriti. Probaj pitati drugačije.";
      return "Hmm, nisam ništa smislio. Pokušaj ponovno.";
    }
  } catch (err) {
    turns.pop(); console.error("Neočekivana greška:", err);
    return "Nešto je pošlo po zlu. Pokušaj ponovno.";
  }

  turns.push({ role: "assistant", content: reply });
  history[chatId] = turns.slice(-MAX_TURNS);
  saveHistory();
  return reply;
}

// ---------- obrada dolaznih poruka ----------
const seen = new Set(); // Telegram može ponoviti isti update
async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;
  const updId = update.update_id;
  if (seen.has(updId)) return;
  seen.add(updId);
  if (seen.size > 2000) seen.delete(seen.values().next().value);

  const chatId = String(msg.chat.id);
  if (ALLOWED.length && !ALLOWED.includes(chatId)) {
    console.log(`Ignoriram poruku s chat ID ${chatId} (nije na popisu)`);
    await sendTelegram(chatId, "Ovaj asistent je privatan.");
    return;
  }

  const text = (msg.text || "").trim();
  if (!text) { await sendTelegram(chatId, "Za sada razumijem samo tekstualne poruke."); return; }

  if (/^\/start\b/i.test(text)) {
    const hi = USER_NAME ? `, ${USER_NAME}` : "";
    await sendTelegram(chatId, `Dobar dan${hi}. Ja sam ${ASSISTANT_NAME}. Pitaj me što god trebaš. (Tvoj chat ID je ${chatId} — javi ga ako želiš da budem samo tvoj.)`);
    return;
  }
  if (/^\/(reset|novi)\b/i.test(text)) {
    delete history[chatId]; saveHistory();
    await sendTelegram(chatId, "Gotovo, počinjemo ispočetka. Što trebaš?");
    return;
  }

  sendTyping(chatId);
  const reply = await askGemini(chatId, text);
  await sendTelegram(chatId, reply);
}

// ---------- HTTP server ----------
http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(`${ASSISTANT_NAME} radi.`);
    return;
  }

  if (req.method === "POST" && url.pathname === "/webhook") {
    if (req.headers["x-telegram-bot-api-secret-token"] !== WH_SECRET) { res.writeHead(401).end(); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200).end(); // odmah potvrdi Telegramu
      let update;
      try { update = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return; }
      handleUpdate(update).catch((e) => console.error("Greška u obradi:", e));
    });
    return;
  }

  res.writeHead(404).end();
}).listen(PORT, async () => {
  console.log(`${ASSISTANT_NAME} (Telegram, Gemini ${GEMINI_MODEL}) sluša na portu ${PORT}`);
  // Automatski poveži Telegram webhook na ovaj server (Render daje RENDER_EXTERNAL_URL).
  if (!BASE_URL) { console.warn("Nema WEBHOOK_URL/RENDER_EXTERNAL_URL — webhook nije postavljen automatski."); return; }
  try {
    const r = await fetch(`${TG}/setWebhook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `${BASE_URL.replace(/\/$/, "")}/webhook`, secret_token: WH_SECRET, allowed_updates: ["message", "edited_message"] }),
    });
    console.log("setWebhook:", r.status, (await r.json()).description || "ok");
  } catch (e) { console.error("setWebhook greška:", e.message); }
});

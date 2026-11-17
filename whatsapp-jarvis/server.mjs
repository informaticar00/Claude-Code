// Jarvis za WhatsApp: prima poruke preko službenog WhatsApp Cloud API webhooka,
// pita Google Gemini (besplatni API) i šalje odgovor natrag u isti razgovor.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Nedostaje varijabla okruženja ${name} (vidi .env.example)`);
  return v;
};

const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = env("WHATSAPP_VERIFY_TOKEN");
const WA_TOKEN = env("WHATSAPP_TOKEN");
const PHONE_NUMBER_ID = env("WHATSAPP_PHONE_NUMBER_ID");
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";
// Samo ovi brojevi smiju razgovarati s asistentom (međunarodni format bez +, odvojeni zarezom).
const ALLOWED = env("ALLOWED_NUMBERS").split(",").map((s) => s.replace(/\D/g, "")).filter(Boolean);
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || "Jarvis";
const USER_NAME = process.env.USER_NAME || "";
const ABOUT_ME = process.env.ABOUT_ME || "";
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || "v21.0";
const HISTORY_FILE = process.env.HISTORY_FILE || "./history.json";
const MAX_TURNS = 30;

// Gemini (besplatni API ključ s aistudio.google.com)
const GEMINI_KEY = env("GEMINI_API_KEY");
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM = `Ti si ${ASSISTANT_NAME}, osobni AI asistent koji s korisnikom razgovara preko WhatsAppa.
Ton: smiren, uglađen i koristan, s malo diskretnog humora.${USER_NAME ? ` Korisnika oslovljavaj s "${USER_NAME}".` : ""}
Odgovaraj na jeziku kojim ti se korisnik obrati (najčešće hrvatski/bosanski).
Ovo je chat na mobitelu: piši kratko i jasno, koristi kratke odlomke i liste s crticama kad pomažu.
Za naglašavanje koristi WhatsApp oblikovanje (*podebljano*, _kurziv_), nikad markdown naslove (#) ni tablice.
Ne možeš upravljati telefonom, slati poruke drugim ljudima ni pretraživati internet; ako se to traži, reci kako to korisnik može brzo sam napraviti.${ABOUT_ME ? `\n\nŠto znaš o korisniku:\n${ABOUT_ME}` : ""}`;

// ---------- povijest razgovora (po broju telefona) ----------
let history = {};
try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch { history = {}; }
function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); } catch (e) { console.warn("Ne mogu spremiti povijest:", e.message); }
}
function turnsFor(number) {
  const t = history[number] || [];
  while (t.length && t[0].role !== "user") t.shift(); // razgovor mora početi korisnikovom porukom
  return t;
}

// ---------- WhatsApp slanje ----------
async function sendWhatsApp(to, body) {
  const parts = []; // WhatsApp dopušta do 4096 znakova po poruci
  for (let rest = body; rest.length; ) {
    let cut = rest.length <= 4000 ? rest.length : rest.lastIndexOf("\n", 4000);
    if (cut < 1000) cut = Math.min(4000, rest.length);
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  for (const text of parts) {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text, preview_url: false } }),
    });
    if (!res.ok) console.error("WhatsApp greška pri slanju:", res.status, await res.text());
  }
}

async function markRead(messageId) {
  await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
  }).catch(() => {});
}

// ---------- Gemini ----------
async function askGemini(number, text) {
  const turns = turnsFor(number);
  turns.push({ role: "user", content: text });
  const now = new Date().toLocaleString("hr-HR", { dateStyle: "full", timeStyle: "short", timeZone: process.env.TZ || "Europe/Sarajevo" });

  // Gemini koristi uloge "user" i "model"; naš "assistant" mapira se na "model".
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
      const body = await res.text();
      turns.pop();
      if (res.status === 429) return "Previše poruka u kratkom vremenu (besplatna granica Geminija). Pričekaj minutu pa pokušaj ponovno.";
      if (res.status === 400 && /API key/i.test(body)) { console.error("Neispravan GEMINI_API_KEY"); return "Asistent nije ispravno podešen (API ključ)."; }
      console.error("Gemini greška:", res.status, body.slice(0, 300));
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
    turns.pop();
    console.error("Neočekivana greška:", err);
    return "Nešto je pošlo po zlu. Pokušaj ponovno.";
  }

  turns.push({ role: "assistant", content: reply });
  history[number] = turns.slice(-MAX_TURNS);
  saveHistory();
  return reply;
}

// ---------- obrada dolaznih poruka ----------
const seen = new Set(); // Meta ponekad pošalje istu poruku više puta
async function handleMessage(msg) {
  if (seen.has(msg.id)) return;
  seen.add(msg.id);
  if (seen.size > 1000) seen.delete(seen.values().next().value);

  const from = msg.from;
  if (!ALLOWED.includes(from)) { console.log(`Ignoriram poruku s nepoznatog broja ${from}`); return; }
  markRead(msg.id);

  if (msg.type !== "text") {
    await sendWhatsApp(from, "Za sada razumijem samo tekstualne poruke. Glasovne poruke i slike dolaze uskoro.");
    return;
  }
  const text = msg.text.body.trim();
  if (/^\/?(reset|novi razgovor|zaboravi)$/i.test(text)) {
    delete history[from]; saveHistory();
    await sendWhatsApp(from, "Gotovo, počinjemo ispočetka. Što trebaš?");
    return;
  }
  const reply = await askGemini(from, text);
  await sendWhatsApp(from, reply);
}

function validSignature(raw, header) {
  if (!APP_SECRET) return true; // preporučeno je postaviti WHATSAPP_APP_SECRET
  if (!header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
  const a = Buffer.from(header.slice(7)), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- HTTP server ----------
http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(`${ASSISTANT_NAME} radi.`);
    return;
  }

  // Meta provjera webhooka
  if (req.method === "GET" && url.pathname === "/webhook") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === VERIFY_TOKEN;
    res.writeHead(ok ? 200 : 403).end(ok ? url.searchParams.get("hub.challenge") : "Forbidden");
    return;
  }

  if (req.method === "POST" && url.pathname === "/webhook") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (!validSignature(raw, req.headers["x-hub-signature-256"])) { res.writeHead(401).end(); return; }
      res.writeHead(200).end(); // odmah potvrdi Meti, inače ponavlja slanje
      let body;
      try { body = JSON.parse(raw.toString("utf8")); } catch { return; }
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          for (const msg of change.value?.messages || []) {
            handleMessage(msg).catch((e) => console.error("Greška u obradi poruke:", e));
          }
        }
      }
    });
    return;
  }

  res.writeHead(404).end();
}).listen(PORT, () => console.log(`${ASSISTANT_NAME} (Gemini ${GEMINI_MODEL}) sluša na portu ${PORT}`));

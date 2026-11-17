# Jarvis za Telegram

Osobni AI asistent (Gemini) s kojim se dopisuješ u Telegramu kao s običnim kontaktom.
Besplatno: Telegram bot (bez registracije preduzeća) + besplatni Google Gemini API.

> Mapa se i dalje zove `whatsapp-jarvis` zbog povijesti; sada radi preko Telegrama.

## Kako radi

```
Ti (Telegram)  ->  Telegram Bot API  ->  ovaj server (webhook)  ->  Gemini API
               <-                      <-   odgovor              <-
```

- Server se sam poveže na Telegram webhook pri pokretanju (na Renderu preko `RENDER_EXTERNAL_URL`).
- Pamti zadnjih 30 poruka razgovora. Pošalji `/reset` za novi razgovor.
- **Privatan po defaultu:** dok ne upišeš svoj chat ID u `TELEGRAM_ALLOWED_CHAT_IDS`, bot nikome ne odgovara AI-jem — svakoj poruci samo vrati taj chat ID. Tako saznaš svoj ID i zaključaš bota na sebe.

## Što ti treba

1. **Telegram bot token** — u Telegramu otvori **@BotFather** → `/newbot` → dobiješ token (odmah, besplatno, bez verifikacije).
2. **Google Gemini API ključ** (besplatan) — [aistudio.google.com](https://aistudio.google.com) → Get API key.
3. **Hosting** — Render (besplatno), preko `render.yaml` blueprinta u korijenu ovog repozitorija.

## Postavljanje (Render)

1. Na [render.com](https://render.com) → **New → Blueprint** → poveži ovaj repozitorij.
2. Render pročita `render.yaml` i traži varijable. Upiši:
   - `GEMINI_API_KEY` → tvoj Gemini ključ
   - `TELEGRAM_BOT_TOKEN` → token od @BotFather
   - `TELEGRAM_ALLOWED_CHAT_IDS` → ostavi prazno za početak (kasnije upišeš svoj chat ID)
3. **Deploy Blueprint.** Kad je status **Live**, server se sam poveže na Telegram.
4. Otvori svog bota u Telegramu, pošalji bilo što — vratit će ti tvoj **chat ID**.
5. Taj chat ID upiši u Renderu u `TELEGRAM_ALLOWED_CHAT_IDS` i spremi (servis se ponovno pokrene). Od tada Jarvis odgovara samo tebi.

## Lokalno pokretanje

```bash
cd whatsapp-jarvis
npm install
cp .env.example .env    # popuni GEMINI_API_KEY i TELEGRAM_BOT_TOKEN; za webhook lokalno treba javni URL
node --env-file=.env server.mjs
```

## Napomene

- Besplatni Render servis zaspi nakon 15 minuta neaktivnosti, pa prva poruka nakon pauze može kasniti do ~50 sekundi.
- Povijest razgovora je u `history.json`; na besplatnom hostingu briše se pri ponovnom pokretanju.
- Model: `gemini-2.0-flash` (besplatni Gemini API). Promijeni ga varijablom `GEMINI_MODEL`.
- Na besplatnom Geminiju Google smije koristiti poruke za poboljšanje modela. Ime asistenta ostaje "Jarvis" (`ASSISTANT_NAME`).

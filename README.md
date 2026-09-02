# Web Intel — Autonomous Web Intelligence

Paste a URL and a goal. An autonomous agent crawls the site as a tree, reasons
over the content with a local LLM, and answers — with citations, job cards,
and searchable history. **No API keys required — runs fully offline.**

**Stack:** Next.js 16 · Ollama (`gemma4:e2b`) · MongoDB · Playwright · Tailwind v4

---

## Quick start (Windows — one double-click)

### Prerequisites (install once)

1. **Node.js 18+** — https://nodejs.org
2. **Ollama** — https://ollama.com (the desktop app; no key needed)
3. **MongoDB Community** — https://www.mongodb.com/try/download/community
   (or run Mongo as a Windows service)

### Install (first time)

Double-click **`install.bat`** in the `web-app` folder. It will:

- `npm install` the dependencies
- `npx playwright install chromium` (for JS-rendered pages)
- `ollama pull gemma4:e2b` (downloads the model for offline use)
- check that MongoDB and Ollama are available

### Run

Double-click **`run.bat`**. It will:

- start MongoDB on `127.0.0.1:27017` (if not already running)
- start `ollama serve` on `127.0.0.1:11434` (if not already running)
- start the Next.js dev server and open `http://localhost:3000`

Press `Ctrl+C` in the run window to stop the app.

---

## Manual setup (any OS)

```bash
cd web-app
npm install
npx playwright install chromium
ollama pull gemma4:e2b

# start MongoDB (e.g.)
mongod --dbpath ./data/db --bind_ip 127.0.0.1 --port 27017

# start Ollama
ollama serve

# start the app
npm run dev
```

Open http://localhost:3000.

## Configuration (optional)

All settings have sensible defaults for local use. To override, copy
`.env.local.example` to `.env.local` and edit:

| Variable       | Default                  | Purpose              |
| -------------- | ------------------------ | -------------------- |
| `OLLAMA_HOST`  | `http://localhost:11434` | Ollama server URL    |
| `OLLAMA_MODEL` | `gemma4:e2b`             | Ollama model tag     |
| `MONGODB_URI`  | `mongodb://localhost:27017` | Mongo connection  |
| `MONGODB_DB`   | `webintel`               | Mongo database name  |

No `OPENAI_API_KEY` or any third-party key is used anywhere.

---

## How it works

1. **Crawl** — BFS tree crawl from the seed URL. An LLM-driven link selector
   picks the most relevant same-site links based on *your* requirement.
   Playwright Chromium is used as a fallback for JavaScript-rendered pages.
2. **Extract** — structured data (JSON-LD, microdata, DOM, text) is extracted
   from every page. Job postings are detected **only when your requirement is
   about jobs**.
3. **Reason** — all crawled page text is sent to the local Ollama model with
   strong anti-hallucination grounding rules. The model answers **only** from
   the provided content and cites source pages.
4. **Stream** — the answer streams token-by-token into the chat UI, with crawl
   chips, job cards, and a copy button.
5. **Persist** — both the user message and the agent answer are stored in
   MongoDB. Reload any session from the sidebar.

## Anti-hallucination

The answer prompt enforces grounding:

- Facts must come **only** from the crawled page text.
- No outside knowledge, assumptions, or invented numbers.
- If the content is insufficient, the model says so explicitly.
- Inferences are marked as such ("this suggests…").

## Keyboard shortcuts

- `⌘/Ctrl + K` — search across all answers in the chat
- `⌘/Ctrl + Enter` — send a message
- `Esc` — close search

## Scripts

| Command         | Description            |
| --------------- | ---------------------- |
| `npm run dev`   | Start dev server       |
| `npm run build` | Production build       |
| `npm run start` | Start production server|
| `npm run lint`  | Run ESLint             |
# Claudework

AI session orchestrator — capture, store, and cross-review Claude Code and Codex sessions.

## Setup

**Step 1 — Navigate to the project**

```bash
cd ~/Documents/Claudework
# (or wherever you cloned it — if unsure: find ~ -name "package.json" -path "*/Claudework/*" 2>/dev/null)
```

**Step 2 — Pull the latest code**

```bash
git pull
```

**Step 3 — Install Node.js if you haven't yet**

Download from [nodejs.org](https://nodejs.org) (LTS, the green button). After installing, close and reopen Terminal.

**Step 4 — Install the Claude CLI**

```bash
npm install -g @anthropic-ai/claude-code
```

**Step 5 — Install dependencies**

```bash
npm install
```

If you see errors about `better-sqlite3`, run `xcode-select --install` first, then `npm install` again. (SQLite is optional — the app will work without it but sessions won't persist after restart.)

**Step 6 — Create your `.env` file**

```bash
echo 'OPENAI_API_KEY=YOUR_KEY_HERE' > .env
```

**Step 7 — Start the app**

```bash
npm start
```

**Step 8 — Diagnose if still broken**

Open `http://localhost:3000/api/health` in your browser — it will show you exactly what's working and what's not, with specific fix commands for each issue.

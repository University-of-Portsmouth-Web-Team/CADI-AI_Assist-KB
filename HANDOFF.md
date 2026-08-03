# CADI Assist — setup and handover

**Read this first, all the way through, before typing anything.** It takes about ten minutes to read and roughly 90 minutes to work through.

This guide assumes a **Windows 11** machine. It assumes you are comfortable with a command prompt and with editing text files, but it does not assume you have used Cloudflare, Wrangler, the Anthropic API or GitHub Actions before. Every command is written out in full, along with what you should see when it works and what to do when it doesn't.

If you get stuck, the [troubleshooting table](#13-when-something-goes-wrong) at the end covers the failures we've actually seen.

---

## Contents

| | Step | Time |
|---|---|---|
| **0** | [What this is and how it fits together](#0-what-this-is-and-how-it-fits-together) | read |
| **1** | [Install the tools](#1-install-the-tools) | 15 min |
| **2** | [Get the code onto your machine](#2-get-the-code-onto-your-machine) | 5 min |
| **3** | [Prove it works before touching any keys](#3-prove-it-works-before-touching-any-keys) | 5 min |
| **4** | [Look at the page on your own machine](#4-look-at-the-page-on-your-own-machine) | 5 min |
| **5** | [Get an Anthropic API key](#5-get-an-anthropic-api-key) | 10 min |
| **6** | [Deploy the Cloudflare Worker](#6-deploy-the-cloudflare-worker) | 25 min |
| **7** | [Point the page at your Worker](#7-point-the-page-at-your-worker) | 5 min |
| **8** | [Put the page online](#8-put-the-page-online) | 10 min |
| **9** | [Test the live assistant properly](#9-test-the-live-assistant-properly) | 10 min |
| **10** | [Set a spend limit](#10-set-a-spend-limit-do-not-skip-this) | 5 min |
| **11** | [Run the first crawl](#11-run-the-first-crawl) | 10 min |
| **12** | [Keeping it running](#12-keeping-it-running) | ongoing |
| **13** | [When something goes wrong](#13-when-something-goes-wrong) | reference |
| **14** | [What still needs a decision](#14-what-still-needs-a-decision) | read |

---

## 0. What this is and how it fits together

CADI Assist is a chat box for the CADI website. A member of staff types a question in their own words — "how do I get AdvanceHE fellowship?" — and gets a written answer built from CADI's own pages, with links to the pages it used.

There are **four separate pieces**, and it helps a lot to hold them apart in your head, because when something breaks the first useful question is always *which piece*.

```
   PIECE 1                PIECE 2              PIECE 3           PIECE 4
   The web page           The Worker           Claude            The crawler
   ───────────────        ──────────────       ──────────        ─────────────
   index.html             worker/worker.js     Anthropic's       scripts/crawl.py
   app.js                                      API
   shared/scoring.mjs     Runs on                                Runs on GitHub
                          Cloudflare           Runs at           every Sunday
   Runs in the                                 Anthropic
   visitor's browser      Holds the API key                      Reads cadi.port.ac.uk
                          Decides the model    Writes the        Writes
   Ranks CADI pages       Blocks abuse         answer            search-index.json
   Sends the best 20
```

The flow for one question:

1. The **page** already has a list of every CADI page in memory (that's `search-index.json`). It scores them all against the question, locally, and picks the best 20.
2. It sends those 20 extracts plus the conversation to the **Worker**. It does *not* send an API key, because it doesn't have one.
3. The **Worker** adds the API key, decides which model to use, writes the instructions, and calls **Claude**.
4. Claude answers using only those extracts. The answer comes back through the Worker to the page.
5. Separately, once a week, the **crawler** re-reads the CADI website and updates the page list.

### Why the API key lives in the Worker

If the key were in the web page, anyone could press F12, read it, and spend University money. The Worker exists solely so that the key sits on a server the public can't read. This is the single most important design point in the whole project, and it is why step 6 is the longest one.

### Two things that killed the previous version

Worth knowing before you start, because both are now guarded against and you need to keep them guarded:

- **The model ID was hardcoded in the web page and then retired by Anthropic.** Model IDs get retired on a schedule; a retired one returns an error with no fallback. The assistant was dead for about seven weeks while the weekly crawler kept running, so from the outside everything looked fine. Step 12 tells you how to avoid repeating that.
- **The Worker had no origin check, no rate limit and no spend cap**, and it passed the browser's whole request through to Anthropic — so a caller could choose any model and any prompt. That is fixed, but only if you complete step 6 including the KV namespace, and step 10.

### What you need before you start

| | Detail |
|---|---|
| A Windows 11 machine | With permission to install software |
| The `cadi-assist` folder | The one this file came in |
| A GitHub account | With access to the `University-of-Portsmouth-Web-Team` organisation |
| A Cloudflare account | The Web Team already has one, with the existing `cadi-search-proxy` Worker on it |
| An Anthropic Console account | See step 5. **Confirm with the Web Team who owns the billing before you create anything.** |
| About 90 minutes | Steps 1–11. Do them in order. |

> **A note on order.** Steps 3 and 4 cost nothing and touch no credentials. Do them first even if you're tempted to skip ahead. If they pass, you know the code on your machine is sound, and every problem after that point is a configuration problem rather than a code problem. That single piece of knowledge saves a lot of time.

---

## 1. Install the tools

You need three things: **Node.js**, **Python** and **Git**. A proper text editor is strongly recommended as a fourth.

### 1.1 Open PowerShell

Press <kbd>Win</kbd>, type `powershell`, and click **Windows PowerShell**. You do not need to run it as Administrator.

You'll use PowerShell for everything in this guide. If you see a command that starts with `>` in this document, don't type the `>` — that's just showing you it's a prompt.

### 1.2 Node.js

Node.js runs the tests and the Cloudflare deployment tool.

1. Go to <https://nodejs.org>
2. Download the **LTS** version (the left-hand green button — not "Current")
3. Run the installer and accept every default
4. **Close PowerShell and open a new one.** Installers change your PATH, and an already-open window won't see the change. This trips up nearly everyone.

Check it worked:

```powershell
node --version
```

You want **v20 or higher**:

```
v22.11.0
```

If you get `'node' is not recognized`, see [troubleshooting](#13-when-something-goes-wrong).

### 1.3 Python

Python runs the website crawler. You only need it if you want to run a crawl on your own machine — GitHub does it automatically each week — but install it anyway, because being able to crawl locally is how you diagnose a broken index.

1. Go to <https://www.python.org/downloads/>
2. Download the latest **Python 3.12** or newer for Windows
3. **On the first screen of the installer, tick "Add python.exe to PATH".** It's a small checkbox at the bottom and it is easy to miss. If you miss it, the commands below won't work and you'll need to re-run the installer and choose Modify.
4. Click **Install Now**
5. Close and reopen PowerShell again

Check:

```powershell
python --version
```

```
Python 3.12.7
```

> **If `python` opens the Microsoft Store** instead of printing a version, Windows' app-execution alias is intercepting it. Either use `py` instead of `python` everywhere in this guide, or go to **Settings → Apps → Advanced app settings → App execution aliases** and switch off both `python.exe` and `python3.exe`.

### 1.4 Git

Git downloads the code and sends changes back to GitHub.

1. Go to <https://git-scm.com/download/win>
2. The download starts automatically. Run it.
3. Accept the defaults, with **one exception**: on the screen headed *Configuring the line ending conversions*, choose **"Checkout as-is, commit Unix-style line endings"** (the middle option).

   Why: Windows and Linux mark the end of a line differently. GitHub Actions runs on Linux. Getting this wrong makes every file look completely rewritten in every commit, which makes it impossible to see what actually changed. The previous version of this repo has this problem.
4. Close and reopen PowerShell

Check:

```powershell
git --version
```

```
git version 2.47.0.windows.1
```

Then tell Git who you are — this labels your commits:

```powershell
git config --global user.name "Your Name"
git config --global user.email "your.name@port.ac.uk"
```

### 1.5 A text editor (recommended)

You'll be editing JavaScript and JSON. **Visual Studio Code** is free and will warn you when you break a file's syntax, which matters because a single missing comma in `config/glossary.json` stops the assistant loading its glossary.

Download from <https://code.visualstudio.com>. Accept the defaults, including "Add to PATH".

Then you can open the project with:

```powershell
code .
```

> **Do not edit these files in Word, WordPad or Google Docs.** They will add smart quotes and formatting that break the code silently. Notepad is acceptable at a pinch; VS Code is much better.

---

## 2. Get the code onto your machine

### 2.1 Decide where it lives

```powershell
cd $HOME\Documents
mkdir projects -Force
cd projects
```

### 2.2 Put the code there

**If the repository already exists on GitHub**, clone it:

```powershell
git clone https://github.com/University-of-Portsmouth-Web-Team/cadi-assist.git
cd cadi-assist
```

**If you were handed the folder as a zip** (most likely, first time round), extract it into `Documents\projects` so you end up with `Documents\projects\cadi-assist`, then:

```powershell
cd $HOME\Documents\projects\cadi-assist
git init
git add .
git commit -m "Initial commit: CADI Assist 2.0"
```

You'll connect it to GitHub in step 8.

### 2.3 Check you have everything

```powershell
dir
```

You should see:

```
.github        config         eval           scripts        shared         worker
app.js         CHANGELOG.md   HANDOFF.md     index.html     LICENCE
README.md      search-index.json
```

If `.github` is missing, your unzip tool skipped it because it starts with a dot. That folder contains the weekly crawl automation, so you do need it — extract again with Windows' built-in unzip (right-click → Extract All) or 7-Zip.

---

## 3. Prove it works before touching any keys

**This is the most useful five minutes in the whole guide.** Two test suites run entirely on your machine. No API key, no internet, no cost. If they pass, the code is sound.

### 3.1 The retrieval test

This asks: *given a real question a staff member typed, does the ranking find the right CADI page?* All 38 questions are taken verbatim from Google Analytics, misspellings included.

```powershell
node eval/run.mjs
```

Expected:

```
CADI Assist — retrieval evaluation
Index: 241 pages   Cases: 38

  ok   acronym              4/4
  ok   acronym-unknown      1/1
  ok   content-gap          1/1
  ok   exact                12/12
  ok   natural-language     4/4
  ok   off-site             2/2
  ok   synonym              4/4
  ok   typo                 6/6
  ok   typo-no-page         1/1
  ok   typo-unknown         1/1
  ok   unknown-term         2/2

Score: 38/38

Baseline 38/38 held.
```

To see what it actually chose for each question — genuinely worth a look, it tells you a lot about how the thing behaves:

```powershell
node eval/run.mjs --verbose
```

### 3.2 The end-to-end test

This one builds a request exactly as the browser would, hands it to the real Worker code, and fakes the reply from Claude. It checks the two halves agree about the shape of a request, that abuse controls work, and that errors are handled.

```powershell
node eval/smoke.mjs
```

Expected, ending with:

```
33/33 checks passed
```

Read the output rather than just the score. Some of these lines are the whole point of the rebuild:

```
ok   Worker set the model, not the browser  — claude-sonnet-5
ok   caller-supplied model ignored  — claude-sonnet-5
ok   caller-supplied system prompt ignored
ok   request from an unlisted origin refused  — got 403
ok   context changes what is retrieved  — bare 0 pages, in context 5 pages
```

That last one is worth understanding. Ask "what about the timetable?" out of the blue and the ranking finds nothing. Ask it straight after "tell me about CPD" and it finds five relevant pages. The question is scored in the context of the conversation, not in isolation.

### 3.3 If either test fails

Stop and fix it before going further. Almost certainly one of:

- **Node too old.** `node --version` must be v20+.
- **Wrong folder.** Run `dir` — you should see `app.js` and `eval`.
- **A config file got mangled** by an editor. Check with:
  ```powershell
  node -e "JSON.parse(require('fs').readFileSync('config/glossary.json','utf8')); console.log('glossary OK')"
  node -e "JSON.parse(require('fs').readFileSync('config/boosts.json','utf8')); console.log('boosts OK')"
  ```

---

## 4. Look at the page on your own machine

You can see the interface before deploying anything. It won't answer questions yet — there's no Worker — but you can check it loads, looks right and reports its own state honestly.

### 4.1 Start a local web server

**You cannot just double-click `index.html`.** The page uses JavaScript modules, and browsers refuse to load those from a `file://` address for security reasons. You'll get a blank page and a console error. This is normal and is not a bug.

Run a tiny local server instead:

```powershell
python -m http.server 8000
```

You'll see:

```
Serving HTTP at 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...
```

Leave that window running. Open a browser and go to:

```
http://localhost:8000
```

### 4.2 What you should see

- The **CADI Assist** heading, in University purple with a blue accent
- "What would you like to know?" and five example questions as clickable chips
- A question box and a **Send** button at the bottom
- Bottom right: **"241 CADI pages, updated 2 Aug 2026"** or similar

That page count in the corner is your health indicator. If it instead says **"Limited mode — 10 pages only"** and an orange banner appears, the page couldn't fetch `search-index.json`. Locally, before step 8, that's expected — the URL in `app.js` points at a GitHub file that doesn't exist yet. It's telling you the truth, which is the point: the previous version failed silently here and answered from ten hardcoded pages without saying so.

### 4.3 Check it's accessible

Quick keyboard check, worth doing because staff will use it:

- Press <kbd>Tab</kbd> repeatedly. Every control should get a **visible blue outline**.
- The first <kbd>Tab</kbd> from the top should reveal a "Skip to the question box" link.
- Type in the box and press <kbd>Enter</kbd> — it should try to send. <kbd>Shift</kbd>+<kbd>Enter</kbd> should make a new line.

Stop the server with <kbd>Ctrl</kbd>+<kbd>C</kbd> when you're done.

---

## 5. Get an Anthropic API key

An API key is a password that lets your Worker use Claude, and it costs money per use. Treat it exactly as you'd treat a bank credential.

> ### Before you create anything
>
> **Confirm with the Web Team who owns the Anthropic account and who pays.** This is an open question on TECH-519 and it is not yours to decide. Using a personal key for a University service is a governance problem even when it works.
>
> **There is also existing work to do here.** A working API key was posted in plain text in a Jira comment on TECH-519 on 7 April 2026 (comment id 71147). If that hasn't been dealt with, it needs revoking in the Anthropic console and the comment redacting — before you create a new key, not after.

### 5.1 Create the key

1. Go to <https://platform.claude.com> and sign in to the **organisation account** the Web Team confirmed
2. **Settings → API keys**
3. **Create key**
4. Name it something that identifies where it's used: `cadi-assist-worker`
5. Copy it. It starts `sk-ant-`

### 5.2 Handle it correctly

**You will only be shown the key once.** Paste it somewhere safe *for the next twenty minutes* — you need it in step 6.6.

| Do | Don't |
|---|---|
| Paste it into a password manager, or the Web Team's shared credential store | Email it, Slack it, or put it in a Jira comment |
| Type it into Wrangler when prompted (step 6.6) | Put it in any file in this repository |
| Delete your temporary copy afterwards | Leave it in a Notepad window or a text file on your Desktop |

The repository has an automatic check that fails the build if anything shaped like an API key is ever committed. Don't rely on it — it's a safety net, not a plan.

---

## 6. Deploy the Cloudflare Worker

The longest step. Take it slowly.

The Worker is a small program that runs on Cloudflare's servers. It holds the API key, decides which model to use, and blocks abuse.

> ### Which route: update the existing Worker, or make a new one?
>
> There is already a Worker at `cadi-search-proxy.kristian-band.workers.dev`. You have two options.
>
> **Route A — deploy a new Worker (recommended).** You get a clean, correctly configured Worker, and the old one keeps running until you're ready. Nothing breaks while you work. You then turn the old one off, which you must do regardless: it currently has no origin check, no rate limit and no spend cap.
>
> **Route B — replace the code in the existing Worker.** Sensible if the URL is already embedded somewhere you can't easily change. Same steps, but change `name` in `wrangler.toml` to match the existing Worker's name exactly, and be aware you'll briefly break the old assistant as you deploy.
>
> This guide follows **Route A**. Route B differences are noted where they matter. Either way, **step 6.10 (turning off the old Worker) is not optional.**

### 6.1 Install Wrangler

Wrangler is Cloudflare's command-line tool.

```powershell
npm install -g wrangler
```

Takes a minute or two. Then check:

```powershell
wrangler --version
```

```
⛅️ wrangler 4.x.x
```

> **If you get a red error about "running scripts is disabled on this system"**, Windows is blocking npm's launcher script. Fix it for your own account only:
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
> ```
> Answer `Y`. Then try `wrangler --version` again.

### 6.2 Move into the worker folder

**Everything in step 6 happens inside `worker`.** Wrangler reads `wrangler.toml` from the folder you're in, so if you're in the wrong place nothing works as described.

```powershell
cd worker
dir
```

You should see exactly two files: `worker.js` and `wrangler.toml`.

### 6.3 Log in to Cloudflare

```powershell
wrangler login
```

A browser window opens. Sign in to the **Web Team's** Cloudflare account and click **Allow**. Back in PowerShell you'll see:

```
Successfully logged in.
```

Confirm you're on the right account:

```powershell
wrangler whoami
```

Check the account name shown is the Web Team's, not a personal one. If it's wrong: `wrangler logout`, then `wrangler login` again.

### 6.4 Create the KV namespace

KV is a small Cloudflare database. Here it does one job: **counting requests, so the rate limits and the daily spend cap work.**

```powershell
wrangler kv namespace create RATE_LIMIT
```

Output looks like:

```
🌀 Creating namespace with title "cadi-assist-proxy-RATE_LIMIT"
✨ Success!
Add the following to your configuration file:
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "a1b2c3d4e5f67890abcdef1234567890"
```

**Copy that long `id` value.** You need it next.

> **This step is not optional.** Without it, the Worker still answers questions but there is genuinely no rate limit and no daily cap — a public endpoint on a paid API with no bound on the worst case. That was one of the two serious problems with the previous version. The Worker's `/health` endpoint will tell you in capital letters if you skip it.

### 6.5 Edit `wrangler.toml`

Open it:

```powershell
code wrangler.toml
```

(or `notepad wrangler.toml` if you skipped VS Code)

**Change 1 — turn on KV.** Find these commented lines near the top:

```toml
# [[kv_namespaces]]
# binding = "RATE_LIMIT"
# id = "PASTE_YOUR_KV_NAMESPACE_ID_HERE"
```

Remove the `#` from each and paste in your real id:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "a1b2c3d4e5f67890abcdef1234567890"
```

**Change 2 — set who may use the assistant.** Find `ALLOWED_ORIGINS` and list the sites that will host the page. Comma separated, **no spaces, no trailing slashes**:

```toml
ALLOWED_ORIGINS = "https://cadi.port.ac.uk,https://university-of-portsmouth-web-team.github.io"
```

Include the GitHub Pages address from step 8, or the live page won't be allowed to call the Worker. You can come back and add it later — just remember to redeploy afterwards.

Never set this to `"*"`. That's what made the old Worker abusable.

**Change 3 (Route B only)** — if you're replacing the existing Worker, change `name` to match it exactly:

```toml
name = "cadi-search-proxy"
```

Save the file. Leave everything else alone for now; the defaults are sensible and every line is commented.

### 6.6 Add the API key as a secret

```powershell
wrangler secret put ANTHROPIC_API_KEY
```

It prompts:

```
✔ Enter a secret value: ›
```

Paste the key from step 5 and press <kbd>Enter</kbd>.

**You won't see anything as you type or paste.** That's deliberate — the characters are hidden. Paste once and press Enter.

```
✨ Success! Uploaded secret ANTHROPIC_API_KEY
```

The key is now encrypted on Cloudflare. It is not in any file, and you can't read it back — which is exactly what you want. Now delete your temporary copy from step 5.1.

### 6.7 Deploy

```powershell
wrangler deploy
```

```
Total Upload: 12.34 KiB / gzip: 4.05 KiB
Uploaded cadi-assist-proxy (2.1 sec)
Published cadi-assist-proxy (0.4 sec)
  https://cadi-assist-proxy.YOUR-SUBDOMAIN.workers.dev
Current Version ID: 1a2b3c4d-...
```

**Copy that `https://...workers.dev` URL.** You need it in step 7. Write it down somewhere you won't lose it.

### 6.8 Check the Worker is configured correctly

The Worker can tell you about its own configuration. Replace the URL with yours:

```powershell
curl https://cadi-assist-proxy.YOUR-SUBDOMAIN.workers.dev/health
```

What you want to see:

```json
{
  "ok": true,
  "model": "claude-sonnet-5",
  "effort": "low",
  "apiKeyConfigured": true,
  "allowedOrigins": ["https://cadi.port.ac.uk", "..."],
  "rateLimitEnforced": true,
  "warnings": []
}
```

**Check all four of these:**

| Field | Must be | If it isn't |
|---|---|---|
| `apiKeyConfigured` | `true` | Redo step 6.6 |
| `rateLimitEnforced` | `true` | Redo steps 6.4 and 6.5, then `wrangler deploy` again |
| `allowedOrigins` | Your real site addresses | Fix `ALLOWED_ORIGINS`, then `wrangler deploy` |
| `warnings` | Empty `[]` | Read them — each one names its own fix |

Do not move on until `warnings` is empty. Every warning describes a real hole.

### 6.9 Test that Claude actually answers

This is the first step that spends money. It will cost a fraction of a penny.

```powershell
curl -Method POST "https://cadi-assist-proxy.YOUR-SUBDOMAIN.workers.dev/api/ask" `
  -Headers @{"Content-Type"="application/json"; "Origin"="https://cadi.port.ac.uk"} `
  -Body '{"messages":[{"role":"user","content":"What is CADI?"}],"knowledge":"TITLE: Centre for Academic and Digital Innovation\nURL: https://cadi.port.ac.uk\nSUMMARY: CADI supports staff and students at the University of Portsmouth.\nDETAIL: CADI brings together academic development, learning design and digital technologies."}'
```

> Those backtick characters (`` ` ``) at the end of lines are PowerShell's line-continuation marker. If you'd rather not deal with them, put the whole command on one line.
>
> The `Origin` header has to be one of your `ALLOWED_ORIGINS`. Without it you'll correctly get a 403 — that's the origin check doing its job.

A working reply:

```json
{"text":"CADI is the Centre for Academic and Digital Innovation at the University of Portsmouth...","usage":{"input":312,"output":98}}
```

**If you see `"code":"not_found_error"`** — the model ID has been retired. This is the failure that took the previous version down. Go to <https://platform.claude.com/docs/en/about-claude/model-deprecations>, find the current replacement, put it in `MODEL` in `wrangler.toml`, and `wrangler deploy` again. No other file needs changing — that's the point of having it in config.

Other errors are in the [troubleshooting table](#13-when-something-goes-wrong).

### 6.10 Turn off the old Worker

**Do not skip this.** The old `cadi-search-proxy` has no origin check, no rate limit and no spend cap, and it forwards whatever it's given to Anthropic. While it's up, anyone who has ever viewed the old page's source can use it.

Once your new Worker is confirmed working (step 9, ideally):

1. Go to <https://dash.cloudflare.com>
2. **Compute (Workers) → Workers & Pages**
3. Click the old Worker → **Settings** → scroll to the bottom → **Delete**

If you'd rather keep it for now, at minimum **delete its `ANTHROPIC_API_KEY` secret** (Settings → Variables and Secrets). That makes it harmless immediately, and you can delete the Worker itself later.

Then, separately: **check the Anthropic console for unexpected spend** on the old key over the period it was exposed. Settings → Usage.

---

## 7. Point the page at your Worker

Two lines to change. Go back up to the project root:

```powershell
cd ..
code app.js
```

At the top of the file:

```javascript
/** Your Cloudflare Worker, including the /api/ask path. */
const PROXY_URL = 'https://cadi-assist-proxy.YOUR-SUBDOMAIN.workers.dev/api/ask';

/** Raw GitHub URL of this repository's own search-index.json. */
const INDEX_URL =
  'https://raw.githubusercontent.com/University-of-Portsmouth-Web-Team/cadi-assist/main/search-index.json';
```

**`PROXY_URL`** — replace with the URL from step 6.7. **Keep `/api/ask` on the end.** Leaving it off is the single most common mistake here; you'll get a 404 and the page will say the assistant returned an error.

**`INDEX_URL`** — this must point at *this* repository's `search-index.json`. The pattern is:

```
https://raw.githubusercontent.com/OWNER/REPO/BRANCH/search-index.json
```

So if the repo ends up at `University-of-Portsmouth-Web-Team/cadi-assist` on branch `main`, the line above is already correct.

> **Why this line matters more than it looks.** In the previous version this pointed at a *different* project's repository, so the weekly crawl in that repo produced a file nothing ever read. Worse, if the fetch failed the error was thrown away silently and the assistant answered from ten hardcoded pages. Get this right, and check the page count in the corner of the live page afterwards.

Save the file.

---

## 8. Put the page online

We'll use **GitHub Pages** — free static hosting, no server to manage.

### 8.1 Create the repository on GitHub

1. Go to <https://github.com/University-of-Portsmouth-Web-Team>
2. **New repository**
3. Name: `cadi-assist`
4. **Private** is fine — GitHub Pages works on private repos on the organisation's plan. If Pages turns out to be unavailable, make it Public; there are no secrets in this repository by design.
5. **Do not** tick "Add a README" — you already have one
6. **Create repository**

### 8.2 Push your code

Substitute the URL GitHub shows you:

```powershell
git add .
git commit -m "Configure Worker URL and index URL"
git branch -M main
git remote add origin https://github.com/University-of-Portsmouth-Web-Team/cadi-assist.git
git push -u origin main
```

A browser window may open asking you to authorise Git. Allow it.

> **If you get `remote origin already exists`**, it's already connected. Use `git remote set-url origin <url>` instead of `git remote add`.

### 8.3 Turn on GitHub Pages

1. In the repository → **Settings** → **Pages** (left sidebar)
2. Under **Source**, choose **Deploy from a branch**
3. Branch: **main**, folder: **/ (root)**
4. **Save**

Wait two or three minutes, then reload the Settings → Pages screen. You'll see:

```
Your site is live at https://university-of-portsmouth-web-team.github.io/cadi-assist/
```

### 8.4 Add that address to the Worker

The Worker doesn't know about this address yet, so it will refuse the page's requests with a 403. Add it:

```powershell
cd worker
code wrangler.toml
```

Add the GitHub Pages origin — **just the domain, no path**:

```toml
ALLOWED_ORIGINS = "https://cadi.port.ac.uk,https://university-of-portsmouth-web-team.github.io"
```

Then redeploy and go back up:

```powershell
wrangler deploy
cd ..
```

---

## 9. Test the live assistant properly

Open your GitHub Pages URL in a browser.

### 9.1 Check the page loaded its data

Bottom right corner should read something like **"241 CADI pages, updated 2 Aug 2026"**.

If it says **"Limited mode — 10 pages only"** with an orange banner, `INDEX_URL` is wrong or the repository is private in a way that blocks raw file access. Press <kbd>F12</kbd> → **Console** and you'll see the exact URL that failed and its status code. Fix `app.js`, commit, push, wait two minutes, reload.

### 9.2 Ask four questions, not one

One question tells you the pipe is connected. These four tell you it actually works. Try them in order.

**1. A question with a clear answer** — "What support is there for CPD?"

You want two to four short paragraphs, with at least one link to a real CADI page. Click the link; it must open a page that exists.

**2. A misspelled question** — type `fellwoship` exactly like that

It should still find fellowship content. This is the fuzzy matching. The old version failed on exactly this.

**3. Something that isn't on the site** — "what is the sickness policy?"

**This is the most important test.** It should tell you plainly that it couldn't find anything about that on the CADI site, and point you at a contact. It must **not** invent an answer, and it must not confidently offer an unrelated page.

If it makes something up, stop and tell the Web Team. That's a serious behaviour problem, not a tuning issue.

**4. A follow-up** — ask "Tell me about CPD", then just "what about the timetable?"

The second question should be understood in the context of the first. As it happens, there's no CPD timetable page on the site, so the honest answer is that it can't find one — that's correct behaviour, not a failure.

### 9.3 Check the browser console

Press <kbd>F12</kbd> → **Console**. It should be clean. Any red errors, note them down.

### 9.4 Check it on a phone

Open the same URL on your phone. The layout should adapt, the question box should be usable, and the keyboard shouldn't cover the Send button.

---

## 10. Set a spend limit — do not skip this

The Worker's daily cap limits requests. A spend limit at Anthropic limits **money**. You want both — they fail in different ways.

1. <https://platform.claude.com> → **Settings** → **Billing**
2. Set a **monthly spend limit**
3. Set a **notification threshold** below it, so you hear about a problem before the service stops

At CADI's volume — roughly 120 searches a month — real usage is pounds per year. Pick a limit that's comfortably above normal use but low enough that abuse gets capped fast. Something in the region of £20/month gives you a very large margin over expected use while bounding the worst case. Agree the actual figure with whoever owns the budget.

**The two limits do different jobs:**

| Limit | Where | What it protects |
|---|---|---|
| `PER_DAY_TOTAL` | `wrangler.toml` | Stops runaway requests. Visitors see a polite "reached its daily limit" message. |
| Monthly spend limit | Anthropic console | Backstop if the Worker itself is misconfigured. Hard stop. |

---

## 11. Run the first crawl

`search-index.json` in the repo was built from a crawl on 2 August 2026. It works, but you should run a fresh one so you've seen the process work.

### 11.1 Trigger it on GitHub

1. Repository → **Actions** tab
2. If you see "Workflows aren't being run on this forked repository", click **I understand my workflows, enable them**
3. Left sidebar → **Crawl CADI and update the index**
4. **Run workflow** → leave the defaults → **Run workflow**
5. Refresh after a few seconds and click into the run to watch it

It takes five to fifteen minutes — there's a deliberate half-second pause between pages so we don't hammer the CADI site.

### 11.2 What success looks like

At the end of the log:

```
Indexed          241 pages
Average content  1103 characters
By type          event 4, news 41, page 196
Errors           4
Thin content     1 pages under 200 characters
No tags          241 of 241 pages
```

Then either `Committed 241 pages.` or `No change to the index — nothing to commit.`

**Two things in that report are expected, not faults:**

- **`No tags 241 of 241`** — the Drupal tag-display issue on TECH-519. Ranking doesn't depend on tags, so this costs you nothing today. If it's ever fixed, tags start contributing automatically.
- **`Errors 4`** — two Teach Well pages return 403 to the crawler. That content is genuinely missing from the index. Worth raising with CADI.

**If the job fails with "Index dropped from 241 to 12 pages"**, that guard is doing its job. It almost always means the Drupal theme changed and the crawler can no longer find the content. Update `CONTENT_SELECTORS` in `scripts/crawl.py`. Crucially, the *old* index stays live in the meantime — a stale index is much better than an empty one.

### 11.3 Running a crawl locally

Useful for diagnosing extraction problems, because you see every page as it's fetched:

```powershell
pip install requests beautifulsoup4 lxml
python scripts/crawl.py --url https://cadi.port.ac.uk --output test-index.json
```

Write to `test-index.json`, not the real file, until you're happy with the result.

---

## 12. Keeping it running

### Every week — two minutes

Check the crawl ran: repository → **Actions**. A green tick against "Crawl CADI and update the index".

### Every month — ten minutes

1. **Check the Worker's health:**
   ```powershell
   curl https://YOUR-WORKER-URL/health
   ```
   `warnings` must still be `[]`.
2. **Ask it three questions**, including one you know isn't on the site. Confirm it still admits the gap.
3. **Check spend** in the Anthropic console. Investigate anything unexpected — it means either the assistant got popular or the endpoint is being abused.

### Every term — thirty minutes. This is the one that matters.

**Check whether your model is being retired.**

Go to <https://platform.claude.com/docs/en/about-claude/model-deprecations> and search for the value of `MODEL` in `wrangler.toml`.

This is not busywork. The previous version of this assistant died precisely here: it pinned a model that was retired on 15 June 2026, every message failed for about seven weeks, and nobody noticed because the crawler kept running and the repository looked healthy.

If a retirement date is listed:

```powershell
cd worker
code wrangler.toml
# change MODEL to the recommended replacement
wrangler deploy
curl https://YOUR-WORKER-URL/health     # confirm the new model is reported
cd ..
```

Then ask it a real question through the live page. A model change can alter tone and answer length, so read one answer properly rather than just checking it returns something.

Also each term:

- Run `node eval/run.mjs` after any change to ranking, the glossary or the boosts
- Look at CADI's site-search analytics for new terms staff are searching that find nothing — those are candidates for `config/glossary.json` or, more often, missing pages

### Making changes safely

Always, in this order:

```powershell
node eval/run.mjs        # 1. record where you're starting from
# ... make your change ...
node eval/run.mjs        # 2. did it get better or worse?
node eval/smoke.mjs      # 3. is anything else broken?
```

If your change is a genuine improvement, record the new baseline so future changes are measured against it:

```powershell
node eval/run.mjs --save-baseline
git add . ; git commit -m "Improve X, baseline now Y/38" ; git push
```

If the score drops, the automated check on GitHub will block the merge. That's intentional.

### Where to change what

| To change | Edit | Then |
|---|---|---|
| The model, effort, limits, wording | `worker/wrangler.toml` | `wrangler deploy` |
| The API key | — | `wrangler secret put ANTHROPIC_API_KEY` |
| Which sites may use it | `ALLOWED_ORIGINS` in `wrangler.toml` | `wrangler deploy` |
| Acronyms and synonyms | `config/glossary.json` | `node eval/run.mjs`, commit, push |
| Which pages get priority | `config/boosts.json` | `node eval/run.mjs`, commit, push |
| How answers are worded | `buildSystemPrompt` in `worker/worker.js` | `wrangler deploy` |
| Ranking behaviour | `shared/scoring.mjs` | `node eval/run.mjs` **and** `node eval/smoke.mjs`, commit, push |
| Look and feel | `index.html` | commit, push |
| What the crawler collects | `scripts/crawl.py` | run locally first, then commit, push |

Note the split: **the Worker needs `wrangler deploy`; the page needs `git push`.** Changing a page file and only deploying the Worker — or vice versa — is a common source of "I fixed it but nothing changed".

### A rule worth keeping

`config/boosts.json` lets you promote pages. It's tempting to reach for a bigger number when a page isn't ranking. Don't:

> **Boosts break ties between relevant results. They never manufacture relevance.**

A promotion only applies to a page that's already nearly winning. If a page isn't relevant to a query, no weight should rescue it — an earlier design did allow that, and the boosted CPD page started winning "authentic assessment" because it mentioned "assessment design" in passing. If a page *should* be relevant but isn't, the fix is a glossary entry or better page content.

---

## 13. When something goes wrong

### First, work out which piece

| Symptom | Piece | Where to look |
|---|---|---|
| Page won't load or looks broken | The web page | Browser <kbd>F12</kbd> → Console |
| "Limited mode" banner | The index | `INDEX_URL` in `app.js` |
| Every question errors | The Worker or Claude | `curl .../health`, then `wrangler tail` |
| Answers are wrong or vague | Ranking, or the index | `node eval/run.mjs --verbose` |
| Index stale or empty | The crawler | GitHub → Actions |

**To watch the Worker live** — the most useful debugging tool you have. Run this, then ask a question in the browser and watch what appears:

```powershell
cd worker
wrangler tail
```

### Specific problems

| What you see | What it means | What to do |
|---|---|---|
| `'node' / 'python' / 'git' is not recognized` | PATH not updated | Close **all** PowerShell windows, open a new one. If it persists, re-run the installer and tick "Add to PATH". |
| `running scripts is disabled on this system` | Windows blocking npm scripts | `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` |
| `python` opens Microsoft Store | Windows app alias | Use `py` instead, or disable the alias in Settings → Apps → Advanced app settings → App execution aliases |
| Blank page when opening `index.html` directly | Modules can't load over `file://` | Use `python -m http.server 8000` and go to `http://localhost:8000` |
| `"code":"origin_not_allowed"`, or 403 | The page's address isn't in `ALLOWED_ORIGINS` | Add it to `wrangler.toml` (domain only, no path, no trailing slash), `wrangler deploy` |
| `"code":"no_api_key"`, or 503 | Secret not set | `wrangler secret put ANTHROPIC_API_KEY`, then `wrangler deploy` |
| `"code":"not_found_error"` | **Model ID retired.** The failure that killed the old version. | Check [deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations), update `MODEL`, `wrangler deploy` |
| `"code":"authentication_error"` | Key wrong, revoked, or has a stray space | Create a fresh key, `wrangler secret put` again |
| `"code":"invalid_request_error"` | Usually a parameter current models reject | Don't add `temperature` or `top_p` — they return 400. Check `wrangler tail` for the detail. |
| `"code":"credit_balance_too_low"` | Out of credit | Top up in the Anthropic console |
| 429, "a lot of questions in a short time" | Per-IP rate limit | Expected during testing. Wait a minute, or raise `PER_MINUTE_PER_IP`. |
| 429, "reached its daily limit" | Site-wide daily cap hit | Raise `PER_DAY_TOTAL` if legitimate. If not, someone is abusing it — check `wrangler tail`. |
| 404 from the Worker | `/api/ask` missing from `PROXY_URL` | Add it |
| `/health` says `rateLimitEnforced: false` | KV namespace not bound | Redo steps 6.4 and 6.5, `wrangler deploy` |
| Answers cut off mid-sentence | `MAX_TOKENS` too low for thinking + answer | Raise to 3000 in `wrangler.toml`, `wrangler deploy` |
| Answers slow (over ~15s) | Effort too high | Confirm `EFFORT = "low"` |
| Answers shallow or unhelpful | Effort too low | Try `EFFORT = "medium"`; expect slower, dearer replies |
| It invents pages or links | Grounding problem | **Report to the Web Team.** Check `wrangler tail` to see what was actually sent. |
| Crawl fails, "Index dropped from N to M" | Theme changed, extraction broken | Update `CONTENT_SELECTORS` in `scripts/crawl.py`. Old index stays live meanwhile. |
| Git says everything changed | Line endings | You picked the wrong option in step 1.4. `git config --global core.autocrlf input`, then re-clone. |
| `node eval/run.mjs` says REGRESSION | A change made search worse | Read the failures. Either fix, or `--save-baseline` if intentional. |

### Rolling back

**The Worker:**
```powershell
cd worker
wrangler deployments list
wrangler rollback
```

**The page:** Cloudflare and GitHub are independent, so you can roll back either alone.
```powershell
git log --oneline
git revert <commit-id>
git push
```

---

## 14. What still needs a decision

Things this code cannot settle. Raise them with the Web Team and CADI rather than deciding alone.

### Do these first

| | Action |
|---|---|
| 1 | **Revoke the API key posted in plain text on TECH-519** (comment id 71147, 7 April 2026) if that hasn't been done. Redact the comment. |
| 2 | **Turn off the old `cadi-search-proxy` Worker**, or at minimum delete its API key secret. It has no origin check, no rate limit and no spend cap. |
| 3 | **Check Anthropic usage** over the period that endpoint was exposed. |
| 4 | **Confirm who owns the Anthropic account and the billing.** Open on TECH-519. |

### Needs CADI

| | Question |
|---|---|
| 5 | What do **SELL** and **gprof** stand for? Both appear in site-search analytics and nobody has been able to say. They're deliberately absent from the glossary. |
| 6 | Confirm the four glossary entries marked `"confirm": true` — CATE, TESTA, PAL and the enABLe absence. |
| 7 | Confirm destinations for **APEX, PrepUP, Docebo, Turnitin, SharePoint**. Staff search for them; there's no CADI page. A wrong link is worse than no link. |
| 8 | **Is it "Centre for Academic and Digital Innovation" or "Academic Development & Innovation"?** The site says the former throughout; internal documents say the latter. Pick one. |

### Content gaps found by building this

Not bugs. Ranking can't invent a page that doesn't exist.

| Staff search for | Volume | Reality |
|---|---|---|
| `cpd timetable`, `timetable` | 16 events | No timetable page exists |
| `fellowship` and variants | 7+ events | No fellowship route page — only news items |
| `peer review`, `observe well` | 3+ events | No peer observation page. Collaborative Growth is closest. |

Also: `/teach-well` indexes with 43 characters of content, and two Teach Well pages return 403 to the crawler.

### Governance

| | Question |
|---|---|
| 9 | Does a public AI answer service on a University site need **DPIA or information-governance sign-off**? Open on TECH-519. Nothing is logged or stored, which helps, but that's a decision for governance, not for code. |
| 10 | Does this **replace or sit alongside** the existing site search? |
| 11 | Who owns **answer quality** long-term — Web Team or CADI? |

### Not implemented, worth knowing

**Citations are not validated server-side.** The system prompt forbids constructing URLs and only supplies real ones, and the tests confirm the prompt is correct — but a determined hallucination would still render as a link. The proper fix is for the Worker to check every URL in the answer against the extracts it sent and drop any that weren't there. That's a contained change to `worker/worker.js` and the right next piece of work if this goes to a wide audience.

---

## Quick reference

```powershell
# Tests — free, offline, no key needed
node eval/run.mjs                  # ranking quality (expect 38/38)
node eval/run.mjs --verbose         # ...showing top 3 per question
node eval/smoke.mjs                # end-to-end (expect 33/33)

# Look at the page locally
python -m http.server 8000         # then http://localhost:8000

# The Worker (run from inside the worker folder)
cd worker
wrangler deploy                    # push code or config changes
wrangler tail                      # watch live requests — best debugging tool
wrangler secret put ANTHROPIC_API_KEY
wrangler deployments list
wrangler rollback
cd ..

# Health check
curl https://YOUR-WORKER-URL/health

# Crawl locally
python scripts/crawl.py --url https://cadi.port.ac.uk --output test-index.json

# Ship page changes
git add . ; git commit -m "message" ; git push
```

**Remember:** the Worker needs `wrangler deploy`. The page needs `git push`. They're separate.

---

## Reference

- `README.md` — how it all works, in detail
- `CHANGELOG.md` — every change from the previous version, and the defect each one fixes
- [Original idea — CADI Assist](https://digitaluop.atlassian.net/wiki/spaces/UE/pages/1839267842) — the review of the previous version
- [TECH-519](https://digitaluop.atlassian.net/browse/TECH-519) — the Jira ticket
- [Anthropic model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations) — **check this once a term**
- [Cloudflare Workers docs](https://developers.cloudflare.com/workers/)

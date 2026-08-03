# Changelog

## 2.0 — 3 August 2026

A working version of the original CADI Assist idea. Same shape as before: a static page that ranks a crawled index in the browser and asks Claude through a Cloudflare Worker. Everything that was broken is fixed, and the parts that were only claimed are now written.

Background is on Confluence: [Original idea — CADI Assist, the conversational prototype](https://digitaluop.atlassian.net/wiki/spaces/UE/pages/1839267842).

### Fixed — the assistant was not working at all

| # | Problem | Fix |
|---|---|---|
| 1 | Pinned `claude-sonnet-4-20250514`, which Anthropic retired on 15 June 2026. Every message returned an error with no fallback, for about seven weeks, while the weekly crawler kept committing fresh indexes so the repository looked healthy. | Now `claude-sonnet-5`, set in `wrangler.toml` rather than in the browser, so a future model change is a config edit and a redeploy. `/health` reports the model in use. |
| 2 | `max_tokens: 1000`. Current models think adaptively before replying and `max_tokens` caps thinking plus answer, so the budget could be spent before the answer began. | 2,000, with `effort: 'low'` — Anthropic's documented setting for latency-sensitive chat. |

### Fixed — security

| # | Problem | Fix |
|---|---|---|
| 3 | The Worker set `Access-Control-Allow-Origin: *` and checked nothing. Anyone could call it. | Origin allowlist from `ALLOWED_ORIGINS`. Unlisted origins get a 403. The allowed origin is echoed rather than `*`. |
| 4 | No rate limit, no spend cap. A University-funded key sat behind a public endpoint with no bound on the worst case. | Per-IP per-minute, per-IP per-day and site-wide daily caps in KV. `/health` warns loudly when the KV namespace is not bound, because that state means no limits at all. |
| 5 | The Worker forwarded the browser's body to Anthropic unchanged, so the caller chose the model, `max_tokens` **and** the system prompt. It was a free general-purpose Claude endpoint. | The Worker now owns all three. The browser sends only the conversation and the page extracts. `eval/smoke.mjs` sends a hostile request with `claude-opus-5`, `max_tokens: 100000` and a replacement system prompt, and asserts all three are ignored. |
| 6 | No request validation or size limits. | Message roles, lengths, turn count and knowledge-block size all validated. Anything unexpected is rejected rather than forwarded. |
| 7 | The Worker source was not in the repository. The only copy was in the Cloudflare dashboard. | `worker/worker.js` and `worker/wrangler.toml` are here, and `eval.yml` syntax-checks them. |

### Fixed — retrieval

| # | Problem | Fix |
|---|---|---|
| 8 | The fuzzy matcher compared strings position by position, so one inserted or deleted character shifted everything after it and exhausted the budget. It failed on transpositions and deletions — the commonest typos, and most of what real staff type. `timetbale`, `fellwoship` and `markeing` all missed, as did the old README's own example, `felowship`. | Damerau-Levenshtein with bounded distance, so a swap costs 1 edit rather than 2 and the budget can stay tight. All nine real misspellings from the analytics export now resolve. |
| 9 | Substring containment made `prof` match `gprof`, so nonsense queries returned confident-looking results. | Prefix containment only, which still catches `assess`/`assessment` and `learnin`/`learning`. |
| 10 | No gap detection. Results were padded to 20 pages including zero-scoring ones, and whether the answer was honest depended on the model noticing unaided. The old README described gap detection in detail; it was never implemented. | `isGap` and `isWeak` are computed and become explicit instructions in the system prompt. Pages whose only evidence is a body-text coincidence are dropped entirely. |
| 11 | Scoring used the current message only, so "what about the timetable?" was ranked on four words with no idea which thread it belonged to. Also described in the old README as implemented; also absent. | Ranking uses the current message plus the last three user messages. `eval/smoke.mjs` asserts the follow-up finds nothing alone and five pages in context. |
| 12 | `getCorePages` — homepage, contact and about always reachable — was documented but did not exist. | Implemented, by URL pattern rather than hardcoded ID. |
| 13 | No stop words, so "how do I get fellowship" scored every page containing "get". | Stop-word list applied before ranking. |
| 14 | Ties broken by page ID, so "CPD and Support" and "Help Shape the Future of CPD at the University of Portsmouth" tied on "CPD" and the wrong one won. | URL-slug scoring plus title-precision normalisation. The concise on-topic page now wins its own query. |
| 15 | No acronym handling, although acronyms and product names are the commonest shape of real CADI query. | `config/glossary.json`, applied as query expansion before ranking. |
| 16 | No way to prioritise key pages, which was the single most requested behaviour on TECH-519. | `config/boosts.json`, gated on relevance so a boost can only break a tie and never manufacture relevance. Verified: `cpd` reaches `/cpd-and-support`, while `authentic assessment` still reaches the assessment pages. |

### Fixed — the index

| # | Problem | Fix |
|---|---|---|
| 17 | The crawler had no URL exclusions, so 54 Drupal tag-facet search pages were indexed as content — 18% of the index, all with identical text, all competing for result slots. | Query strings and `^/search`, `^/user`, `^/admin` and similar excluded. Rules are unit-testable. |
| 18 | `--max-pages 300` against an index that had already reached 295. Because the crawl was breadth-first, hitting the cap would silently drop real pages while keeping the facet junk found earlier. | Ceiling raised to 1,500, sitemap-seeded so important pages are fetched first, and it warns when the cap is hit with URLs still queued. |
| 19 | `/cadi-news` and `/CADI-News` indexed as two pages. | De-duplication is case-insensitive. |
| 20 | A mailto address was crawled as a URL path, twice. | `mailto:` and `@`-in-path rejected. |
| 21 | Titles carried "| University of Portsmouth" on all 241 pages, diluting every title match. | Site suffix stripped during the crawl. |
| 22 | A crawl that succeeded but extracted nothing looked like a success. | Quality report on every run — thin pages, errors, tag coverage — and the workflow fails rather than committing if the page count falls below 70% of the previous run. |
| 23 | Tags, dates and descriptions were empty on all 295 pages, so two of the seven scoring fields were dead. | Cause is the Drupal tag-display issue on TECH-519, not this code. The crawler now also checks JSON-LD and topic fields, ranking no longer depends on tags, and the report says so explicitly instead of leaving it to be discovered. |

### Fixed — the front end

| # | Problem | Fix |
|---|---|---|
| 24 | `GITHUB_RAW_INDEX_URL` pointed at a different project's repository, so this repo's weekly crawl produced an index nothing read. | Points at its own `search-index.json`. |
| 25 | The index fetch failure was swallowed by `.catch(() => {})`. If it ever failed, the assistant answered fluently from ten hardcoded pages with nothing visible to the visitor or the developer. | Failure is logged, and the page shows a "Limited mode" banner naming the problem. The footer always states how many pages are loaded and when they were crawled. |
| 26 | React plus the Babel standalone transpiler from a CDN, compiling JSX in the visitor's browser on every page load — roughly 3 MB to render a text box. | Plain ES modules, no framework, no transpiler, no CDN scripts. Same "just copy the files" deployment. |
| 27 | Every failure produced the same message: "I'm having trouble connecting right now." A retired model, a 403 and a rate limit were indistinguishable. | Distinct messages for origin refusal, rate limiting, missing configuration, network failure and upstream error, with the real cause logged to the console. |
| 28 | No AI disclaimer, no accessibility work. | Persistent "AI-generated answer, always check the linked page" notice. Skip link, labelled controls, `aria-live` on the conversation, visible focus, keyboard operable, `prefers-reduced-motion` respected. |
| 29 | The ten-page fallback list referenced URLs that no longer exist, such as `/cpd-support` and `/fellowship`. | Rewritten against the live site, verified 3 August 2026. |

### Added

- `shared/scoring.mjs` — ranking in exactly one place, imported by both the browser and the tests. Two copies drift, and once they drift the tests stop measuring what visitors get.
- `eval/run.mjs` — 38 queries taken verbatim from the CADI analytics export, scored offline in under a second with no API key. Committed baseline; CI blocks a regression.
- `eval/smoke.mjs` — 33 end-to-end checks with the Anthropic call stubbed. Catches the case where the page and the Worker, deployed separately, stop agreeing about the request shape.
- `eval.yml` — secret scan, JSON validation, both test suites on every push and pull request. The secret scan exists because a working API key was posted in plain text on TECH-519 in April 2026.
- `HANDOFF.md` — first-time setup for a Windows 11 machine, step by step.

### Documentation

The previous README described four features that were not in the code: `getCorePages`, gap detection, conversation-aware scoring, and typo tolerance that did not tolerate typos — with code samples and tuning advice for each. All four are now genuinely implemented, and every claim in the new README is covered by one of the two test commands.

### Known and unfixed

Listed in full in [README section 12](README.md#12-known-gaps-and-open-questions). The short version: server-side citation validation is not implemented; three of the most-searched terms on the site have no page to find; `SELL` and `gprof` remain undefined; external links for APEX, PrepUP, Docebo and Turnitin need CADI to confirm the destinations; and whether a public AI answer service needs DPIA sign-off is an open governance decision, not a code change.

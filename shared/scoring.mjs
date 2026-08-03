/**
 * CADI Assist — retrieval core.
 *
 * This module is the ONLY place ranking logic lives. It is imported by both
 * the browser app (app.js) and the offline evaluator (eval/run.mjs). Keeping
 * one copy is deliberate: two copies drift, and the moment they drift the
 * evaluation stops measuring what users actually get.
 *
 * No CADI-specific assumptions. Core pages are found by URL pattern, never by
 * hardcoded ID, so this works against any index the crawler produces.
 */

/** Field weights, in points per matching query word. */
export const WEIGHTS = {
  title: 10,
  tag: 8,
  slug: 6,
  tagPhrase: 5,
  excerpt: 4,
  content: 2,
  /**
   * Awarded once per page, scaled by the fraction of the page's own title that
   * the query matched. A short, on-topic title such as "CPD and Support" beats
   * a long title that merely happens to contain the word, such as "Help Shape
   * the Future of CPD at the University of Portsmouth". This is field-length
   * normalisation, and without it the most specific page loses to the wordiest.
   */
  titlePrecision: 8,
};

/** How many characters of `content` are scanned when scoring. */
export const CONTENT_SCAN_CHARS = 600;

/** How many pages are sent to the model. */
export const DEFAULT_TOP_N = 20;

/** How many characters of each page's content are sent to the model. */
export const CONTENT_SEND_CHARS = 500;

/** How many previous user messages feed into scoring, for follow-up questions. */
export const CONTEXT_TURNS = 3;

/**
 * Below this top score, treat the result set as weak: probably nothing on the
 * site really answers the question. 10 = a single title word match, so
 * anything under that means we matched only incidental body text.
 */
export const WEAK_SCORE_THRESHOLD = 10;

/**
 * A page must beat this to be returned at all. Excerpt (4) plus body (2) is 6,
 * so this floor excludes pages whose only evidence is a fuzzy match somewhere
 * in their body text. That is almost always coincidence rather than relevance —
 * it is how the query "gprof" reached a WISEflow page, because "Prof" is one
 * edit away. Returning nothing and saying so is better than a confident
 * coincidence.
 */
export const MIN_PAGE_SCORE = 7;

/**
 * Fraction of the query's terms the best page must match in its title or URL
 * before the result is treated as confident. Catches the case where a long
 * question lands on a page that happens to share one common word — "peer
 * review" reaching "CADI CPD Review" on the word "review" alone.
 */
export const MIN_COVERAGE = 0.5;

/**
 * Words ignored when scoring. Without this, "how do I get fellowship" scores
 * every page containing "get", which swamps the signal from "fellowship".
 */
const STOP_WORDS = new Set([
  'a', 'about', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be',
  'been', 'being', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'for',
  'from', 'get', 'getting', 'give', 'had', 'has', 'have', 'he', 'her', 'his',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'more',
  'my', 'need', 'of', 'on', 'one', 'or', 'our', 'out', 'over', 'please',
  'she', 'should', 'so', 'some', 'tell', 'than', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up', 'us', 'want',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why',
  'will', 'with', 'would', 'you', 'your',
]);

/**
 * Split text into comparable lowercase words. Punctuation is stripped, which
 * also repairs real typos from the analytics data such as "cpd timetab;e".
 */
export function tokenise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Query words worth scoring: stop words and single characters removed. */
export function queryTerms(text) {
  const seen = new Set();
  return tokenise(text).filter((w) => {
    if (w.length <= 1 || STOP_WORDS.has(w) || seen.has(w)) return false;
    seen.add(w);
    return true;
  });
}

/**
 * True edit distance, bounded for speed. Returns the distance, or maxDist + 1
 * if the real distance exceeds maxDist.
 *
 * The previous version of this project compared strings position by position,
 * which meant one inserted or deleted character shifted everything after it
 * and blew the budget immediately. That silently failed on transpositions and
 * deletions — the most common typing errors, and the bulk of what appears in
 * the CADI analytics export. This handles all four edit types.
 */
export function boundedLevenshtein(a, b, maxDist) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;

  // Two rows back, because a transposition needs to look two cells diagonally.
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
      // Transposition: "timetbale" -> "timetable" is one swap, and swaps are
      // the most common typing error. Plain Levenshtein charges 2 for it, which
      // forces the distance budget wide enough to also match unrelated words
      // ("optional" / "national"). Charging 1 keeps the budget tight.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, prev2[j - 2] + 1);
      }
      curr[j] = best;
      if (best < rowMin) rowMin = best;
    }
    // Whole row already worse than the budget: it cannot recover.
    if (rowMin > maxDist) return maxDist + 1;
    prev2 = prev;
    prev = curr;
    curr = new Array(b.length + 1);
  }
  return prev[b.length];
}

/** Edit-distance budget for a word of the given length. */
function distanceBudget(len) {
  if (len >= 10) return 2;
  if (len >= 5) return 1;
  return 0; // short words must match exactly — "cat"/"cot" is not a typo
}

/**
 * True when an index word and a query word should count as the same term.
 * Containment first (cheap, catches "learnin" inside "learning" and stemming
 * cases like "assess" / "assessment"), then bounded edit distance.
 */
export function fuzzyMatch(indexWord, queryWord) {
  if (indexWord === queryWord) return true;

  // Prefix containment, not substring containment. Prefixes catch real word
  // families ("assess" / "assessment", "learnin" / "learning", "fellow" /
  // "fellowship"). Plain substring matching is far too loose: it made "prof"
  // match "gprof", so a nonsense query returned confident-looking results.
  const [shorter, longer] =
    indexWord.length <= queryWord.length ? [indexWord, queryWord] : [queryWord, indexWord];
  if (shorter.length >= 4 && longer.startsWith(shorter)) return true;

  const budget = distanceBudget(Math.max(indexWord.length, queryWord.length));
  if (budget === 0) return false;
  return boundedLevenshtein(indexWord, queryWord, budget) <= budget;
}

/**
 * Expand a query using the glossary: acronyms and synonyms are added as extra
 * search terms. The analytics export is dominated by acronyms and product
 * names (APEX, AIR, enABLe, PrepUP), so without this the most common shape of
 * real query retrieves nothing useful.
 *
 * @param {string} query
 * @param {Array<{terms: string[], expandsTo: string}>} glossary
 * @returns {string} the original query plus any expansions
 */
export function expandQuery(query, glossary = []) {
  const words = tokenise(query);
  const joined = ' ' + words.join(' ') + ' ';
  const additions = [];

  for (const entry of glossary) {
    for (const term of entry.terms || []) {
      const needle = ' ' + tokenise(term).join(' ') + ' ';
      if (needle.trim() && joined.includes(needle)) {
        additions.push(entry.expandsTo);
        break;
      }
    }
  }
  return additions.length ? `${query} ${additions.join(' ')}` : query;
}

/** Path of a URL, lowercased, with no trailing slash. Empty string on failure. */
function pathOf(url) {
  try {
    return new URL(url).pathname.toLowerCase().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * Homepage, contact page and about page, detected by URL pattern rather than
 * hardcoded ID so this survives content changes and ports to other sites.
 * These are always kept reachable regardless of score, so the assistant can
 * always point someone at a human.
 */
export function getCorePages(index) {
  const core = [];
  const seen = new Set();
  const take = (page) => {
    if (page && !seen.has(page.url)) {
      seen.add(page.url);
      core.push(page);
    }
  };

  take(index.find((p) => pathOf(p.url) === ''));
  take(index.find((p) => /\/contact/.test(pathOf(p.url))));
  take(index.find((p) => /\/about/.test(pathOf(p.url))));
  return core;
}

/**
 * Apply configured boosts to raw relevance scores.
 *
 * Promotions are gated on relevance: a page must already reach `boostFloor` of
 * the top raw score before any promotion applies, and the effect then grows as
 * the square of how close it already was to winning. A page that was going to
 * win anyway gets the full weight; a page at the floor gets nothing. This is
 * what stops a boosted page from hijacking queries it is only tangentially
 * related to.
 *
 * Demotions (weight below 1) apply in full — suppressing low-value content
 * needs no hedging.
 */
export function applyBoosts(scored, boostConfig = {}) {
  const { boosts = [], boostFloor = 0.6 } = boostConfig;
  if (!boosts.length || !scored.length) return scored;

  const topRaw = scored[0].score;
  if (topRaw <= 0) return scored;

  for (const entry of scored) {
    const path = pathOf(entry.page.url) || '/';
    let weight = 1;
    for (const boost of boosts) {
      let re;
      try {
        re = new RegExp(boost.match);
      } catch {
        continue; // a malformed pattern must not take search down
      }
      if (re.test(path) || re.test(path + '/')) weight *= boost.weight;
    }
    if (weight === 1) continue;

    if (weight < 1) {
      entry.score = entry.score * weight;
      continue;
    }

    const relevance = entry.score / topRaw;
    if (relevance < boostFloor) continue; // not relevant enough to promote at all
    const ramp = (relevance - boostFloor) / (1 - boostFloor);
    entry.score = entry.score * (1 + (weight - 1) * ramp * ramp);
  }

  scored.sort((a, b) => b.score - a.score || a.page.id - b.page.id);
  return scored;
}

/**
 * Score every page against a query and return the best ones.
 *
 * @returns {{pages, maxScore, scores, titleHits}}
 */
export function scorePages(index, query, topN = DEFAULT_TOP_N, boostConfig = {}) {
  const terms = queryTerms(query);
  if (!terms.length) {
    return { pages: [], maxScore: 0, scores: new Map(), coverage: new Map() };
  }

  const scored = index.map((page) => {
    const titleWords = tokenise(page.title).filter((w) => !STOP_WORDS.has(w));
    const slugWords = tokenise(pathOf(page.url).replace(/[/-]/g, ' '));
    const tagPhrase = (page.tags || []).join(' ').toLowerCase();
    const tagWords = tokenise(tagPhrase);
    const excerptWords = tokenise(page.excerpt);
    const contentWords = tokenise(
      String(page.content || '').slice(0, CONTENT_SCAN_CHARS),
    );

    let score = 0;
    let titleMatches = 0;
    let strongTerms = 0; // query terms matched in the title or URL, not just body

    for (const term of terms) {
      let strongThisTerm = false;
      if (titleWords.some((w) => fuzzyMatch(w, term))) {
        score += WEIGHTS.title;
        titleMatches++;
        strongThisTerm = true;
      }
      if (slugWords.some((w) => fuzzyMatch(w, term))) {
        score += WEIGHTS.slug;
        strongThisTerm = true;
      }
      if (strongThisTerm) strongTerms++;
      if (tagWords.some((w) => fuzzyMatch(w, term))) score += WEIGHTS.tag;
      if (tagPhrase.includes(term)) score += WEIGHTS.tagPhrase;
      if (excerptWords.some((w) => fuzzyMatch(w, term))) score += WEIGHTS.excerpt;
      if (contentWords.some((w) => fuzzyMatch(w, term))) score += WEIGHTS.content;
    }

    if (titleMatches > 0 && titleWords.length > 0) {
      score += WEIGHTS.titlePrecision * (titleMatches / titleWords.length);
    }

    return { page, score, coverage: terms.length ? strongTerms / terms.length : 0 };
  });

  scored.sort((a, b) => b.score - a.score || a.page.id - b.page.id);
  applyBoosts(scored, boostConfig);

  const maxScore = scored.length ? scored[0].score : 0;
  const scores = new Map(scored.map((s) => [s.page.url, Math.round(s.score * 10) / 10]));
  const coverage = new Map(scored.map((s) => [s.page.url, s.coverage]));

  // Only pages that matched something are worth sending. Padding the list with
  // zero-scoring pages makes an unanswerable question look answered.
  const matched = scored.filter((s) => s.score >= MIN_PAGE_SCORE).slice(0, topN);

  return { pages: matched.map((s) => s.page), maxScore, scores, coverage };
}

/**
 * Build the retrieval result for one conversation turn.
 *
 * Scoring uses the current message plus the last few user messages, so a
 * follow-up like "what about the timetable?" is scored in the context of the
 * thread it belongs to rather than on four words in isolation.
 *
 * @param {object[]} index          pages from search-index.json
 * @param {string}   query          the message just typed
 * @param {object[]} priorMessages  earlier messages, {role, text}
 * @param {object}   opts           {topN, glossary, boostConfig, contentChars}
 */
export function buildRetrieval(index, query, priorMessages = [], opts = {}) {
  const {
    topN = DEFAULT_TOP_N,
    glossary = [],
    boostConfig = {},
    contentChars = CONTENT_SEND_CHARS,
  } = opts;

  const recent = priorMessages
    .filter((m) => m.role === 'user')
    .slice(-CONTEXT_TURNS)
    .map((m) => m.text);

  const contextQuery = [...recent, query].join(' ');
  const expanded = expandQuery(contextQuery, glossary);

  const { pages, maxScore, scores, coverage } = scorePages(
    index, expanded, topN, boostConfig,
  );

  // Core pages are appended, never scored in, so they cannot displace a real
  // result. They exist so the assistant can always point someone at a human.
  const withCore = [...pages];
  const urls = new Set(pages.map((p) => p.url));
  for (const core of getCorePages(index)) {
    if (!urls.has(core.url)) {
      withCore.push(core);
      urls.add(core.url);
    }
  }

  // A gap means nothing cleared MIN_PAGE_SCORE, not that the raw top score was
  // zero. A coincidental body-text match scores 6 and is still a gap.
  const isGap = pages.length === 0;

  /**
   * Low confidence means: nothing on this site really answers the question.
   * The test is how much of the query the best page matched in its title or
   * URL, rather than somewhere in its body. A body-only match is coincidence —
   * it is how "my optional choises" ends up on a National Teaching Fellow news
   * item. Weak results are still returned; the model is just told to be candid
   * about them rather than presenting a guess as an answer.
   */
  const topCoverage = pages.length ? coverage.get(pages[0].url) || 0 : 0;
  const isWeak =
    !isGap && (topCoverage < MIN_COVERAGE || maxScore < WEAK_SCORE_THRESHOLD);

  return {
    pages: withCore,
    matchedPages: pages,
    maxScore: Math.round(maxScore * 10) / 10,
    scores,
    isGap,
    isWeak,
    knowledge: buildKnowledgeBlock(withCore, contentChars),
    expandedQuery: expanded,
  };
}

/** Format pages as the KNOWLEDGE BASE block sent to the model. */
export function buildKnowledgeBlock(pages, contentChars = CONTENT_SEND_CHARS) {
  return pages
    .map((p) =>
      [
        `TITLE: ${p.title}`,
        `URL: ${p.url}`,
        `TYPE: ${p.type || 'page'}`,
        `SUMMARY: ${p.excerpt || ''}`,
        `DETAIL: ${String(p.content || '').slice(0, contentChars)}`,
        `TAGS: ${(p.tags || []).join(', ')}`,
      ].join('\n'),
    )
    .join('\n\n---\n\n');
}

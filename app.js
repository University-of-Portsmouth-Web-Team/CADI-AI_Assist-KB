/**
 * CADI Assist — chat application.
 *
 * Plain JavaScript, no framework. The previous version loaded React plus the
 * Babel standalone transpiler from a CDN and compiled JSX in the visitor's
 * browser on every page load, which is roughly three megabytes of download to
 * render a text box and a list of messages. This does the same job with no
 * dependencies and no build step, which keeps the original "just copy the
 * files" deployment story while being considerably faster.
 *
 * Ranking lives in shared/scoring.mjs so the offline evaluator tests exactly
 * the code that runs here.
 */

import { buildRetrieval } from './shared/scoring.mjs';

/* ── Configuration ──────────────────────────────────────────────────────────
 * These are the only two values a new deployment must change. Neither is a
 * secret: the API key lives only in the Cloudflare Worker.
 */

/** Your Cloudflare Worker, including the /api/ask path. */
const PROXY_URL = 'https://cadi-search-proxy.kristian-band.workers.dev/api/ask';

/** Raw GitHub URL of this repository's own search-index.json. */
const INDEX_URL =
  'https://raw.githubusercontent.com/University-of-Portsmouth-Web-Team/cadi-assist/main/search-index.json';

// Absolute, not relative: when this script is embedded as a widget on
// cadi.port.ac.uk, './config/...' would resolve against that site and 404.
// The failure is silent (both loads fall back to null), which would quietly
// disable acronym expansion and boosts — the things the eval score depends on.
const GLOSSARY_URL =
  'https://raw.githubusercontent.com/University-of-Portsmouth-Web-Team/cadi-assist/main/config/glossary.json';
const BOOSTS_URL =
  'https://raw.githubusercontent.com/University-of-Portsmouth-Web-Team/cadi-assist/main/config/boosts.json';

const EXAMPLE_PROMPTS = [
  'How do I get AdvanceHE Fellowship?',
  'What support is there for CPD?',
  'What is the connected curriculum?',
  'Tell me about categorical marking',
  'What is happening at the Learning and Teaching Conference?',
];

const AGENT_STEPS = [
  'Searching CADI pages',
  'Reading the most relevant ones',
  'Writing an answer',
];

/**
 * Fallback used only if the live index cannot be fetched. Ten pages is 4% of
 * the site, so the interface says so out loud rather than pretending.
 * Verified against the live site on 3 August 2026.
 */
const FALLBACK_INDEX = [
  { id: 1, url: 'https://cadi.port.ac.uk', title: 'Centre for Academic and Digital Innovation', type: 'page', tags: [], excerpt: 'CADI supports staff and students across the University of Portsmouth.', content: 'CADI brings together expertise in academic development, learning design, digital technologies and student experience.' },
  { id: 2, url: 'https://cadi.port.ac.uk/cpd-and-support', title: 'CPD and Support', type: 'page', tags: [], excerpt: 'Professional development opportunities and tailored support for staff.', content: 'Continuing professional development, workshops, and support to enhance teaching practice.' },
  { id: 3, url: 'https://cadi.port.ac.uk/cpd-and-support/postgraduate-certificate-higher-education', title: 'Postgraduate Certificate in Higher Education', type: 'page', tags: [], excerpt: 'The PGCertHE route for staff who teach.', content: 'Postgraduate Certificate in Higher Education, a route towards AdvanceHE fellowship.' },
  { id: 4, url: 'https://cadi.port.ac.uk/learning-design', title: 'Learning Design', type: 'page', tags: [], excerpt: 'Designing engaging, inclusive and effective learning experiences.', content: 'Learning design guidance rooted in active blended learning and Teach Well, Consistently Well.' },
  { id: 5, url: 'https://cadi.port.ac.uk/assessment-and-feedback', title: 'Assessment and Feedback', type: 'page', tags: [], excerpt: 'Guidance and resources on assessment and feedback.', content: 'Assessment design, alternative assessment, categorical marking, feedback practice.' },
  { id: 6, url: 'https://cadi.port.ac.uk/connected-curriculum', title: 'Connected Curriculum', type: 'page', tags: [], excerpt: 'The Connected Curriculum framework.', content: 'Connected Curriculum framework for curriculum design across the University.' },
  { id: 7, url: 'https://cadi.port.ac.uk/digital-technologies', title: 'Digital Technologies', type: 'page', tags: [], excerpt: 'Moodle, Panopto, Mentimeter and other supported tools.', content: 'Digital technologies for teaching, including Moodle, Panopto, Mentimeter and media production.' },
  { id: 8, url: 'https://cadi.port.ac.uk/collaborative-growth', title: 'Collaborative Growth', type: 'page', tags: [], excerpt: 'A peer-led approach to enhancing teaching practice.', content: 'Collaborative Growth pairs colleagues for peer-led development to Teach Well, Consistently Well.' },
  { id: 9, url: 'https://cadi.port.ac.uk/learning-and-teaching-conference-2026', title: 'Learning and Teaching Conference 2026', type: 'event', tags: [], excerpt: 'The annual CADI Learning and Teaching Conference.', content: 'Learning and Teaching Conference 2026, sessions, strands, keynote and schedule.' },
  { id: 10, url: 'https://cadi.port.ac.uk/contact-us', title: 'Contact Us', type: 'page', tags: [], excerpt: 'How to get in touch with CADI.', content: 'Contact the Centre for Academic and Digital Innovation by email at cadi@port.ac.uk.' },
];

/* ── State ──────────────────────────────────────────────────────────────── */

const state = {
  messages: [], // {role: 'user'|'assistant', text, error?}
  index: FALLBACK_INDEX,
  glossary: [],
  boostConfig: {},
  usingFallback: true,
  busy: false,
};

const el = {
  messages: document.getElementById('messages'),
  thinking: document.getElementById('thinking'),
  welcome: document.getElementById('welcome'),
  prompts: document.getElementById('prompts'),
  form: document.getElementById('composer'),
  input: document.getElementById('question'),
  send: document.getElementById('send'),
  clear: document.getElementById('clear'),
  limited: document.getElementById('limited-notice'),
  indexStatus: document.getElementById('index-status'),
};

/* ── Start-up ───────────────────────────────────────────────────────────── */

renderPrompts();
loadConfig();
loadIndex();

async function loadConfig() {
  // Config is optional. Missing files degrade ranking, they do not break it.
  const [glossary, boosts] = await Promise.all([
    fetchJson(GLOSSARY_URL).catch(() => null),
    fetchJson(BOOSTS_URL).catch(() => null),
  ]);
  if (glossary?.entries) state.glossary = glossary.entries;
  if (boosts) state.boostConfig = boosts;
}

async function loadIndex() {
  try {
    const data = await fetchJson(INDEX_URL);
    if (!Array.isArray(data?.pages) || data.pages.length === 0) {
      throw new Error('Index contained no pages');
    }
    state.index = data.pages;
    state.usingFallback = false;
    const built = data.generated_at ? new Date(data.generated_at) : null;
    el.indexStatus.textContent =
      `${data.pages.length} CADI pages` +
      (built && !Number.isNaN(built.valueOf())
        ? `, updated ${built.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
        : '');
  } catch (error) {
    // Say so. The previous version swallowed this and quietly answered from a
    // ten-page list with no indication to the user or the developer.
    console.error('CADI Assist: could not load the live page index.', error);
    el.limited.hidden = false;
    el.indexStatus.textContent = `Limited mode — ${FALLBACK_INDEX.length} pages only`;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

/* ── Rendering ──────────────────────────────────────────────────────────── */

function renderPrompts() {
  for (const prompt of EXAMPLE_PROMPTS) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'prompt-chip';
    button.textContent = prompt;
    button.addEventListener('click', () => {
      el.input.value = prompt;
      submit();
    });
    li.append(button);
    el.prompts.append(li);
  }
}

function addMessage(message) {
  state.messages.push(message);
  el.welcome.hidden = true;

  const li = document.createElement('li');
  li.className = `msg msg--${message.role}${message.error ? ' msg--error' : ''}`;

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = message.role === 'user' ? 'You' : 'C';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const sender = document.createElement('p');
  sender.className = 'sender';
  sender.textContent = message.role === 'user' ? 'You' : 'CADI Assist';

  bubble.append(sender, ...renderRichText(message.text));
  li.append(avatar, bubble);
  el.messages.append(li);

  li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Turn the model's markdown into DOM nodes.
 *
 * Built with createElement and textContent rather than innerHTML, so model
 * output can never inject markup. Handles the small subset actually used:
 * paragraphs, bullet lists, links and bold.
 */
function renderRichText(text) {
  const nodes = [];
  const blocks = String(text).split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;

    const isList = lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l));
    if (isList) {
      const ordered = /^\s*\d+\.\s+/.test(lines[0]);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      for (const line of lines) {
        const li = document.createElement('li');
        li.append(...renderInline(line.replace(/^\s*([-*]|\d+\.)\s+/, '')));
        list.append(li);
      }
      nodes.push(list);
    } else {
      const p = document.createElement('p');
      p.append(...renderInline(lines.join(' ')));
      nodes.push(p);
    }
  }

  if (!nodes.length) {
    const p = document.createElement('p');
    p.textContent = text;
    nodes.push(p);
  }
  return nodes;
}

function renderInline(text) {
  const out = [];
  // [label](url) or **bold**
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      out.push(document.createTextNode(text.slice(cursor, match.index)));
    }
    if (match[2]) {
      const a = document.createElement('a');
      a.href = match[2];
      a.textContent = match[1];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      out.push(a);
    } else {
      const strong = document.createElement('strong');
      strong.textContent = match[3];
      out.push(strong);
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < text.length) out.push(document.createTextNode(text.slice(cursor)));
  return out;
}

let stepTimers = [];

function startThinking() {
  stopThinking();
  const list = document.createElement('ul');
  list.className = 'steps';
  el.thinking.append(list);

  AGENT_STEPS.forEach((label, i) => {
    stepTimers.push(
      setTimeout(() => {
        // Mark the previous step done, then show this one as in progress.
        const previous = list.querySelector('li:last-child .spinner');
        if (previous) {
          const tick = document.createElement('span');
          tick.className = 'tick';
          tick.setAttribute('aria-hidden', 'true');
          tick.textContent = '\u2713';
          previous.replaceWith(tick);
        }
        const li = document.createElement('li');
        const spinner = document.createElement('span');
        spinner.className = 'spinner';
        spinner.setAttribute('aria-hidden', 'true');
        const span = document.createElement('span');
        span.textContent = label;
        li.append(spinner, span);
        list.append(li);
      }, i * 700),
    );
  });
}

function stopThinking() {
  stepTimers.forEach(clearTimeout);
  stepTimers = [];
  el.thinking.replaceChildren();
}

/* ── Sending ────────────────────────────────────────────────────────────── */

el.form.addEventListener('submit', (event) => {
  event.preventDefault();
  submit();
});

// Enter sends, Shift+Enter makes a new line.
el.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});

// Grow the box with the text, up to the CSS max-height.
el.input.addEventListener('input', () => {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 144)}px`;
});

el.clear.addEventListener('click', () => {
  state.messages = [];
  el.messages.replaceChildren();
  stopThinking();
  el.welcome.hidden = false;
  el.input.value = '';
  el.input.style.height = 'auto';
  setBusy(false);
  el.input.focus();
});

function setBusy(busy) {
  state.busy = busy;
  el.send.disabled = busy;
  el.send.textContent = busy ? 'Sending…' : 'Send';
}

async function submit() {
  const question = el.input.value.trim();
  if (!question || state.busy) return;

  const priorMessages = state.messages.slice();

  el.input.value = '';
  el.input.style.height = 'auto';
  addMessage({ role: 'user', text: question });
  setBusy(true);
  startThinking();

  // Rank locally, then send only the pages that matched.
  const retrieval = buildRetrieval(state.index, question, priorMessages, {
    glossary: state.glossary,
    boostConfig: state.boostConfig,
  });

  const payload = {
    messages: [...priorMessages, { role: 'user', text: question }].map((m) => ({
      role: m.role,
      content: m.text,
    })),
    knowledge: retrieval.knowledge,
    isGap: retrieval.isGap,
    isWeak: retrieval.isWeak,
  };

  try {
    const response = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      // The Worker sends a message written for the reader; prefer it.
      throw new Error(data.error || describeStatus(response.status));
    }

    stopThinking();
    addMessage({ role: 'assistant', text: data.text || 'No answer came back. Please try again.' });
  } catch (error) {
    console.error('CADI Assist:', error);
    stopThinking();
    addMessage({
      role: 'assistant',
      text:
        error instanceof TypeError
          ? 'I could not reach the assistant service. Check your connection and try again.'
          : String(error.message || error),
      error: true,
    });
  } finally {
    setBusy(false);
    el.input.focus();
  }
}

function describeStatus(status) {
  if (status === 403) return 'This assistant can only be used from the CADI website.';
  if (status === 429) return 'Too many questions just now. Please wait a moment and try again.';
  if (status === 503) return 'The assistant is not configured yet. Please let the Web Team know.';
  return `The assistant returned an error (${status}). Please try again shortly.`;
}
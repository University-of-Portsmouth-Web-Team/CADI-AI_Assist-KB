#!/usr/bin/env python3
"""
CADI Assist — site crawler.

Crawls a website and writes search-index.json, the knowledge base the assistant
ranks against.

    python scripts/crawl.py --url https://cadi.port.ac.uk

What changed from the previous version, and why:

  * URL exclusions. The old crawler had none, so Drupal's tag-facet search pages
    (/search?keys=&field_tags_target_id[]=501 and 53 others) were indexed as if
    they were content. They made up 18% of the index, all with the same 68
    characters of text, all competing for space in the results.

  * Case-insensitive de-duplication. /cadi-news and /CADI-News were both being
    indexed as separate pages.

  * Sitemap seeding. Starting from sitemap.xml means the important pages are
    fetched first. With a plain breadth-first crawl, hitting the page cap drops
    whichever pages happen to be last in the queue, silently.

  * A page cap that is not about to be hit. The old default was 300 against an
    index that had already reached 295.

  * A quality report at the end, so a crawl that technically succeeded but
    produced thin content is visible rather than discovered weeks later.
"""

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse, urldefrag
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup

# ── Configuration ─────────────────────────────────────────────────────────────

USER_AGENT = (
    "CADIAssistCrawler/2.0 (University of Portsmouth Web Team; cadi@port.ac.uk)"
)
REQUEST_TIMEOUT = 20
CRAWL_DELAY = 0.5          # seconds between requests — be polite
MAX_RETRIES = 2
THIN_CONTENT_CHARS = 200   # below this, a page is reported as thin

# Paths never worth indexing. Matched against the lowercased path.
EXCLUDE_PATH_PATTERNS = [
    r"^/search",
    r"^/user",
    r"^/admin",
    r"^/node/\d+/(edit|delete|revisions)",
    r"^/views/",
    r"^/taxonomy/",
    r"^/comment/",
    r"^/print/",
]

# Primary content container. The crawler takes the first selector that matches
# and extracts all text inside it. Order matters: most specific first.
CONTENT_SELECTORS = [
    ".node__content",           # Drupal: wraps all paragraph components
    ".main-content",            # Drupal: fallback content wrapper
    ".field--name-body",        # Drupal: classic body field
    ".field--name-field-text",  # Drupal: paragraph text field
    "main",
    "[role='main']",
    "#content",
    ".content",
    "article",
]

# Stripped before text extraction: navigation chrome and interface furniture.
NOISE_SELECTORS = [
    "script", "style", "noscript", "nav", "header", "footer",
    "aside", ".sidebar", "#sidebar", ".navigation",
    ".breadcrumb", ".cookie-notice", ".cookie-banner",
    ".search-block", ".search-container",
    ".header__nav-toggle--mobile", ".skip-link",
    ".hero",   # hero images carry no useful text
    "svg",     # icon SVGs inside accordion buttons
]

# CADI components whose text sits outside the main container and would
# otherwise be missed.
SUPPLEMENTAL_SELECTORS = [
    ".signpost__text",
    ".quote__text",
    ".accordion-item__content",
    ".accordion-item__title span",
]

PAGE_TITLE_SELECTOR = ".header__page-title"

SKIP_EXTENSIONS = {
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".zip", ".rar",
    ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".ico", ".bmp",
    ".mp4", ".mp3", ".wav", ".avi", ".mov", ".css", ".js", ".xml", ".rss",
}


# ── URL handling ──────────────────────────────────────────────────────────────

def normalise(url: str) -> str:
    """Strip the fragment and any trailing slash."""
    url, _ = urldefrag(url)
    return url.rstrip("/")


def dedup_key(url: str) -> str:
    """
    Key used to decide whether we have already seen a URL.

    Lowercased, because Drupal serves /cadi-news and /CADI-News as the same
    page and the previous crawler indexed both.
    """
    parsed = urlparse(normalise(url))
    return f"{parsed.netloc.lower()}{parsed.path.lower()}"


def is_crawlable(url: str, base_domain: str, stay_on_domain: bool) -> bool:
    parsed = urlparse(url)

    if parsed.scheme not in ("http", "https"):
        return False                      # also drops mailto: and tel:
    if "@" in parsed.path:
        return False                      # an email address scraped as a path
    if parsed.query:
        return False                      # facets and pagers, never content
    if any(parsed.path.lower().endswith(ext) for ext in SKIP_EXTENSIONS):
        return False
    if stay_on_domain and parsed.netloc != base_domain:
        return False

    path = parsed.path.lower().rstrip("/")
    return not any(re.search(pattern, path) for pattern in EXCLUDE_PATH_PATTERNS)


# ── Extraction ────────────────────────────────────────────────────────────────

def extract_text(soup: BeautifulSoup) -> str:
    """Pull the meaningful text from a page, stripping navigation chrome."""
    soup = BeautifulSoup(str(soup), "lxml")   # work on a copy

    for selector in NOISE_SELECTORS:
        for element in soup.select(selector):
            element.decompose()

    parts = []

    # The page <h1> sits outside .node__content on CADI, so take it first.
    for element in soup.select(PAGE_TITLE_SELECTOR):
        text = element.get_text(separator=" ", strip=True)
        if text:
            parts.append(text)

    main_text = ""
    for selector in CONTENT_SELECTORS:
        container = soup.select_one(selector)
        if container:
            main_text = " ".join(container.get_text(separator=" ", strip=True).split())
            if main_text:
                break

    if not main_text:
        body = soup.find("body")
        if body:
            main_text = " ".join(body.get_text(separator=" ", strip=True).split())

    if main_text:
        parts.append(main_text)

    seen = set()
    for selector in SUPPLEMENTAL_SELECTORS:
        for element in soup.select(selector):
            text = " ".join(element.get_text(separator=" ", strip=True).split())
            if text and text not in seen:
                seen.add(text)
                parts.append(text)

    return " ".join(parts)


def extract_meta(soup: BeautifulSoup) -> dict:
    """Description, publication date and tags."""
    meta = {}

    description = (
        soup.find("meta", attrs={"name": "description"})
        or soup.find("meta", attrs={"property": "og:description"})
    )
    if description:
        meta["description"] = (description.get("content") or "").strip()

    date_tag = (
        soup.find("meta", attrs={"property": "article:published_time"})
        or soup.find("meta", attrs={"property": "article:modified_time"})
        or soup.find("time", attrs={"datetime": True})
    )
    if date_tag:
        meta["date"] = (date_tag.get("content") or date_tag.get("datetime") or "").strip()

    # Tags. Every one of these sources came back empty on every CADI page in the
    # August 2026 crawl, which is the Drupal tag-display issue on TECH-519.
    # The ranker copes without tags; if the issue is ever fixed, tags start
    # contributing automatically with no code change.
    tags = []
    for keyword_tag in soup.find_all("meta", attrs={"name": re.compile(r"keywords|tags", re.I)}):
        raw = keyword_tag.get("content") or ""
        tags.extend(t.strip().lower() for t in raw.split(",") if t.strip())

    for tag_element in soup.select(
        ".field--name-field-tags a, .field--name-field-topics a, .tags a, [rel='tag']"
    ):
        text = tag_element.get_text(strip=True).lower()
        if text:
            tags.append(text)

    # Drupal often exposes taxonomy in JSON-LD even when the theme hides it.
    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            payload = json.loads(script.string or "{}")
        except (ValueError, TypeError):
            continue
        for block in payload if isinstance(payload, list) else [payload]:
            if not isinstance(block, dict):
                continue
            keywords = block.get("keywords")
            if isinstance(keywords, str):
                tags.extend(k.strip().lower() for k in keywords.split(",") if k.strip())
            elif isinstance(keywords, list):
                tags.extend(str(k).strip().lower() for k in keywords if str(k).strip())

    meta["tags"] = list(dict.fromkeys(tags))   # dedupe, keep order
    return meta


def infer_content_type(url: str, soup: BeautifulSoup) -> str:
    """Content type, from URL patterns and Drupal body classes."""
    path = urlparse(url).path.lower()
    body_classes = " ".join(soup.body.get("class", [])) if soup.body else ""

    if "node-type-event" in body_classes or "/event" in path or "conference" in path:
        return "event"
    if "node-type-news" in body_classes or "/news" in path or "cadi-news" in path:
        return "news"
    if "node-type-resource" in body_classes or "resource" in path:
        return "resource"
    if "node-type-guide" in body_classes or "/guide" in path:
        return "guide"
    return "page"


# ── Seeding ───────────────────────────────────────────────────────────────────

def sitemap_urls(session, base_url: str) -> list:
    """
    Read sitemap.xml, following sitemap index files one level.

    Seeding from the sitemap means the pages the site considers important are
    fetched before the page cap can bite. Returns [] if there is no sitemap, in
    which case the crawler falls back to breadth-first from the homepage.
    """
    found = []
    to_read = [urljoin(base_url + "/", "sitemap.xml")]
    seen_sitemaps = set()

    while to_read:
        sitemap_url = to_read.pop(0)
        if sitemap_url in seen_sitemaps:
            continue
        seen_sitemaps.add(sitemap_url)

        try:
            response = session.get(sitemap_url, timeout=REQUEST_TIMEOUT)
            if response.status_code != 200:
                continue
            soup = BeautifulSoup(response.text, "xml")
        except Exception:
            continue

        # A sitemap index points at more sitemaps.
        for element in soup.find_all("sitemap"):
            loc = element.find("loc")
            if loc and loc.text and len(seen_sitemaps) < 25:
                to_read.append(loc.text.strip())

        for element in soup.find_all("url"):
            loc = element.find("loc")
            if loc and loc.text:
                found.append(loc.text.strip())

    return found


def get_robots(base_url: str) -> RobotFileParser:
    parser = RobotFileParser()
    parser.set_url(urljoin(base_url + "/", "robots.txt"))
    try:
        parser.read()
    except Exception:
        pass   # no robots.txt is not an error
    return parser


def fetch(session, url: str):
    """GET with a small retry, for transient failures."""
    last_error = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            return session.get(url, timeout=REQUEST_TIMEOUT, allow_redirects=True), None
        except requests.RequestException as error:
            last_error = error
            if attempt < MAX_RETRIES:
                time.sleep(1.5 * (attempt + 1))
    return None, last_error


# ── Crawl ─────────────────────────────────────────────────────────────────────

def crawl(target_url: str, max_pages: int, stay_on_domain: bool) -> dict:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    target_url = target_url.rstrip("/")
    base_domain = urlparse(target_url).netloc
    robots = get_robots(target_url)

    print(f"Crawling {target_url} (limit {max_pages} pages)")

    seeds = sitemap_urls(session, target_url)
    if seeds:
        print(f"  sitemap.xml: {len(seeds)} URLs")
    else:
        print("  no usable sitemap.xml, falling back to link discovery only")

    queue = [normalise(target_url)]
    queue += [normalise(u) for u in seeds
              if is_crawlable(normalise(u), base_domain, stay_on_domain)]

    visited = set()
    pages = []
    errors = []
    skipped_robots = 0

    while queue and len(pages) < max_pages:
        url = queue.pop(0)
        key = dedup_key(url)
        if key in visited:
            continue
        visited.add(key)

        if not robots.can_fetch(USER_AGENT, url):
            skipped_robots += 1
            continue

        response, error = fetch(session, url)
        if error is not None:
            errors.append({"url": url, "error": str(error)})
            print(f"  [error]  {url}: {error}")
            continue

        if response.status_code != 200:
            errors.append({"url": url, "status": response.status_code})
            print(f"  [{response.status_code}]    {url}")
            continue

        if "text/html" not in response.headers.get("Content-Type", ""):
            continue

        soup = BeautifulSoup(response.text, "lxml")

        raw_title = soup.title.get_text(strip=True) if soup.title else url
        # Drupal appends the site name to every title. Strip it so ranking sees
        # the page's own words rather than "University of Portsmouth" 241 times.
        title = re.sub(r"\s*[|\u2013-]\s*(University of Portsmouth|CADI)\s*$", "",
                       raw_title).strip() or raw_title

        text = extract_text(soup)
        meta = extract_meta(soup)

        pages.append({
            "id": len(pages) + 1,
            "url": url,
            "title": title,
            "excerpt": text[:300].rstrip() + ("\u2026" if len(text) > 300 else ""),
            "content": text[:1500],
            "type": infer_content_type(url, soup),
            "tags": meta.get("tags", []),
            "date": meta.get("date", ""),
            "description": meta.get("description", ""),
        })
        print(f"  [{len(pages):>4}]  {title[:66]}")

        for anchor in soup.find_all("a", href=True):
            href = normalise(urljoin(url, anchor["href"]))
            if dedup_key(href) not in visited and is_crawlable(href, base_domain, stay_on_domain):
                queue.append(href)

        time.sleep(CRAWL_DELAY)

    if queue and len(pages) >= max_pages:
        print(f"\n  WARNING: hit the {max_pages}-page limit with {len(queue)} URLs still queued.")
        print("  Raise --max-pages, or pages are being silently left out of the index.")

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_url": target_url,
        "total_pages": len(pages),
        "pages": pages,
        "errors": errors,
        "stats": {
            "urls_considered": len(visited),
            "skipped_by_robots": skipped_robots,
            "queue_remaining": len(queue),
        },
    }


def report(index: dict) -> None:
    """Print a quality summary. A crawl can succeed and still be bad."""
    pages = index["pages"]
    if not pages:
        print("\nNo pages indexed.")
        return

    thin = [p for p in pages if len(p["content"]) < THIN_CONTENT_CHARS]
    no_tags = [p for p in pages if not p["tags"]]
    types = {}
    for page in pages:
        types[page["type"]] = types.get(page["type"], 0) + 1

    print("\n" + "-" * 62)
    print(f"Indexed          {len(pages)} pages")
    print(f"Average content  {sum(len(p['content']) for p in pages) // len(pages)} characters")
    print(f"By type          " + ", ".join(f"{k} {v}" for k, v in sorted(types.items())))
    print(f"Errors           {len(index['errors'])}")
    print(f"Thin content     {len(thin)} pages under {THIN_CONTENT_CHARS} characters")
    print(f"No tags          {len(no_tags)} of {len(pages)} pages")

    if len(no_tags) == len(pages):
        print("\n  Note: no page exposed any tags. Expected on CADI at present — the")
        print("  Drupal tag-display issue on TECH-519. Ranking does not depend on")
        print("  tags, so this is not a failure.")

    if thin:
        print(f"\n  Thin pages (first 10) — check whether content extraction is working:")
        for page in thin[:10]:
            print(f"    {len(page['content']):>4} chars  {page['url']}")

    if index["errors"]:
        print(f"\n  Errors (first 10):")
        for error in index["errors"][:10]:
            detail = error.get("status") or error.get("error")
            print(f"    {detail}  {error['url']}")
    print("-" * 62)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Crawl a website and write a search index for CADI Assist.",
    )
    parser.add_argument("--url", required=True, help="Root URL to crawl")
    parser.add_argument("--max-pages", type=int, default=1500,
                        help="Maximum pages to index (default 1500)")
    parser.add_argument("--stay-on-domain", type=lambda v: str(v).lower() == "true",
                        default=True, help="Only follow links on the same domain")
    parser.add_argument("--output", default="search-index.json", help="Output file")
    parser.add_argument("--min-pages", type=int, default=1,
                        help="Fail if fewer than this many pages are indexed")
    args = parser.parse_args()

    index = crawl(args.url, args.max_pages, args.stay_on_domain)
    report(index)

    if len(index["pages"]) < args.min_pages:
        print(f"\nFAILED: indexed {len(index['pages'])} pages, expected at least {args.min_pages}.")
        print("Not writing the output file — the existing index is better than an empty one.")
        return 1

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(index, handle, ensure_ascii=False, indent=2)

    print(f"\nWritten to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

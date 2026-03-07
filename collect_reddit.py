import os
import json
import time
import requests
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────
# Replace these with your actual keys
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_KEY", "")
AIRTABLE_KEY  = "pate0cjtAStonZujz.c5b94747862327703f86074e104139c0a8bf3be0e3e51d24ebf708c637653259"
AIRTABLE_BASE = "appsxLPHnrJga3fGc"
AIRTABLE_RAW  = "tbl6fFhubzyXgpv2K"

NEIGHBORHOODS = [
    "University District", "Capitol Hill", "Ballard", "Fremont", "Queen Anne",
    "Beacon Hill", "West Seattle", "South Lake Union", "Northgate", "Pioneer Square",
    "Belltown", "First Hill", "Rainier Valley", "Roosevelt", "Phinney Ridge",
    "Madison Valley", "Lake City", "White Center", "Shoreline", "Greenwood", "Eastside"
]

CANONICAL = {
    "university district": "University District", "u-district": "University District",
    "u district": "University District", "udub": "University District", "uw": "University District",
    "capitol hill": "Capitol Hill", "cap hill": "Capitol Hill",
    "ballard": "Ballard", "fremont": "Fremont", "queen anne": "Queen Anne",
    "beacon hill": "Beacon Hill", "north beacon hill": "Beacon Hill", "south beacon hill": "Beacon Hill",
    "west seattle": "West Seattle", "alki": "West Seattle", "admiral": "West Seattle",
    "south lake union": "South Lake Union", "slu": "South Lake Union",
    "northgate": "Northgate", "pioneer square": "Pioneer Square", "belltown": "Belltown",
    "first hill": "First Hill", "pill hill": "First Hill",
    "rainier valley": "Rainier Valley", "columbia city": "Rainier Valley", "rainier beach": "Rainier Valley",
    "roosevelt": "Roosevelt", "phinney ridge": "Phinney Ridge",
    "madison valley": "Madison Valley", "madison park": "Madison Valley",
    "lake city": "Lake City", "white center": "White Center",
    "shoreline": "Shoreline", "greenwood": "Greenwood",
    "bellevue": "Eastside", "redmond": "Eastside", "kirkland": "Eastside",
    "issaquah": "Eastside", "bothell": "Eastside", "medina": "Eastside",
}

VALID_CATEGORIES = {
    "Business Opening", "Business Closure", "Food & Drink", "Retail",
    "Housing & Development", "Safety & Crime", "Zoning & Permits",
    "Transit & Infrastructure", "Nightlife & Events", "Fitness & Wellness",
    "Employment & Economy",
}

def get_week_key():
    now = datetime.now(timezone.utc)
    return f"{now.year}-W{now.isocalendar()[1]:02d}"

def normalize_neighborhood(raw):
    if not raw:
        return None
    return CANONICAL.get(raw.lower().strip(), raw if raw in NEIGHBORHOODS else None)

def fetch_reddit_posts():
    # Pull new posts directly — no search query, just the freshest posts
    # Claude does the neighborhood + commercial filtering downstream
    subreddits = ["seattle", "seattlewa", "ballard", "CapitolHillSeattle", "WestSeattle"]
    all_posts = []
    seen = set()

    headers = {
        "User-Agent": "AgoraIQ/0.1 commercial-signals-research",
        "Accept": "application/json",
    }

    for sub in subreddits:
        try:
            url = f"https://www.reddit.com/r/{sub}/new.json?limit=50"
            r = requests.get(url, headers=headers, timeout=15)
            if not r.ok:
                print(f"  Reddit r/{sub} returned {r.status_code}")
                continue
            posts = r.json().get("data", {}).get("children", [])
            for p in posts:
                d = p["data"]
                if d["id"] in seen:
                    continue
                seen.add(d["id"])
                all_posts.append({
                    "id": d["id"],
                    "title": d.get("title", ""),
                    "description": (d.get("selftext") or d.get("title", ""))[:800],
                    "url": f"https://www.reddit.com{d['permalink']}",
                    "date": datetime.fromtimestamp(d["created_utc"], tz=timezone.utc).isoformat(),
                    "comments": d.get("num_comments", 0),
                    "subreddit": d.get("subreddit", ""),
                })
            time.sleep(1)
        except Exception as e:
            print(f"  Reddit error ({sub}): {e}")

    print(f"Fetched {len(all_posts)} posts from Reddit")
    return all_posts

def fetch_saved_urls():
    """Load all recently saved URLs in one batch call instead of 100 individual checks."""
    saved_urls = set()
    offset = None
    try:
        while True:
            params = {
                "fields[]": "Source URL",
                "pageSize": 100,
                "filterByFormula": 'IS_AFTER({Date}, DATEADD(TODAY(), -14, "days"))'
            }
            if offset:
                params["offset"] = offset
            r = requests.get(
                f"https://api.airtable.com/v0/{AIRTABLE_BASE}/{AIRTABLE_RAW}",
                headers={"Authorization": f"Bearer {AIRTABLE_KEY}"},
                params=params,
                timeout=15
            )
            data = r.json()
            for record in data.get("records", []):
                url = record.get("fields", {}).get("Source URL")
                if url:
                    saved_urls.add(url)
            offset = data.get("offset")
            if not offset:
                break
    except Exception as e:
        print(f"  Warning: could not load saved URLs: {e}")
    return saved_urls

def analyze_with_claude(post):
    neighborhoods_str = ", ".join(NEIGHBORHOODS)
    categories_str = "\n".join(f"- {c}" for c in sorted(VALID_CATEGORIES))

    prompt = f"""You are a commercial real estate signal analyst for AgoraIQ.

Extract COMMERCIALLY RELEVANT signals from Seattle neighborhood social media posts.
Be strict — most posts are NOT commercially relevant.

NEIGHBORHOODS (only these): {neighborhoods_str}

VALID CATEGORIES:
{categories_str}

RULES:
1. NEIGHBORHOOD: Must be specific from the list. State/national politics or no specific neighborhood = null.
2. CATEGORY: Must be from the list. State politics, personal life, UW academics, weather = null.
3. CONFIDENCE: 0.0-1.0 — how confident this is a genuine commercial signal.

Post Title: {post['title']}
Post Body: {post['description']}

Return ONLY valid JSON:
{{
  "neighborhood": "exact name or null",
  "category": "exact category or null",
  "flags": [],
  "sentiment": 0.0,
  "confidence": 0.0,
  "summary": "one sentence or null",
  "forward_signal": "one sentence 30-60 day prediction or null"
}}"""

    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01"},
        json={"model": "claude-haiku-4-5-20251001", "max_tokens": 400, "temperature": 0,
              "messages": [{"role": "user", "content": prompt}]},
        timeout=30
    )
    if not r.ok:
        raise Exception(f"Claude API error: {r.status_code}")

    text = r.json()["content"][0]["text"]
    # Extract JSON object robustly
    start = text.find("{")
    end = text.rfind("}") + 1
    if start == -1 or end == 0:
        raise Exception("No JSON found in Claude response")
    result = json.loads(text[start:end])
    if result.get("neighborhood"):
        result["neighborhood"] = normalize_neighborhood(result["neighborhood"])
    return result

def should_save(analysis):
    if not analysis.get("neighborhood"):
        return False, "no_neighborhood"
    if not analysis.get("category") or analysis.get("category") not in VALID_CATEGORIES:
        return False, "invalid_category"
    if (analysis.get("confidence") or 0) < 0.5:
        return False, "low_confidence"
    return True, None

def save_to_airtable(post, analysis):
    r = requests.post(
        f"https://api.airtable.com/v0/{AIRTABLE_BASE}/{AIRTABLE_RAW}",
        headers={"Authorization": f"Bearer {AIRTABLE_KEY}", "Content-Type": "application/json"},
        json={"fields": {
            "Date": post["date"], "Raw Signal": post["description"],
            "Category": analysis["category"], "Sentiment": analysis["sentiment"],
            "Intent Summary": analysis["summary"], "Forward Signal": analysis.get("forward_signal", ""),
            "Source URL": post["url"], "Neighborhood": analysis["neighborhood"],
            "Week": get_week_key(), "ingestion_timestamp": datetime.now(timezone.utc).isoformat(),
            "comment_count_initial": post["comments"], "source_type": "reddit",
        }, "typecast": True},
        timeout=15
    )
    if not r.ok:
        raise Exception(f"Airtable error: {r.status_code}")

def run():
    print(f"\n=== AgoraIQ Reddit Collection — {datetime.now(timezone.utc).isoformat()} ===")
    posts = fetch_reddit_posts()
    if not posts:
        print("No posts fetched. Exiting.")
        return

    print("  Loading saved URLs from Airtable...")
    saved_urls = fetch_saved_urls()
    print(f"  {len(saved_urls)} URLs already in database")

    saved = skipped = 0
    discarded = {}

    for post in posts:
        try:
            if post["url"] in saved_urls:
                skipped += 1
                continue
            analysis = analyze_with_claude(post)
            keep, reason = should_save(analysis)
            if not keep:
                discarded[reason] = discarded.get(reason, 0) + 1
                continue
            save_to_airtable(post, analysis)
            saved_urls.add(post["url"])
            saved += 1
            print(f"  + [{analysis['category']}] {analysis['neighborhood']}: {analysis['summary'][:60]}")
            time.sleep(1.5)
        except Exception as e:
            print(f"  ! ERROR: {e}")

    print(f"\nSAVED: {saved} | SKIPPED: {skipped} | DISCARDED: {sum(discarded.values())}")
    print(f"SIGNAL RATE: {saved}/{len(posts)} ({int(saved/len(posts)*100) if posts else 0}%)")

if __name__ == "__main__":
    run()
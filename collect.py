import os
import json
import time
import requests
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────
ANTHROPIC_KEY = os.environ["ANTHROPIC_KEY"]
AIRTABLE_KEY  = os.environ["AIRTABLE_KEY"]
AIRTABLE_BASE = "appsxLPHnrJga3fGc"
AIRTABLE_RAW  = "tbl6fFhubzyXgpv2K"

# ── Neighborhoods ─────────────────────────────────────────────────────────────
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

# ── Valid Categories ───────────────────────────────────────────────────────────
VALID_CATEGORIES = {
    "Business Opening",
    "Business Closure",
    "Food & Drink",
    "Retail",
    "Housing & Development",
    "Safety & Crime",
    "Zoning & Permits",
    "Transit & Infrastructure",
    "Nightlife & Events",
    "Fitness & Wellness",
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
    query = " OR ".join(f'"{n}"' for n in NEIGHBORHOODS)
    subreddits = ["seattle", "seattlewa", "udub"]
    all_posts = []
    seen = set()

    # Use a realistic browser User-Agent to avoid 403s from GitHub Actions IPs
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
    }

    for sub in subreddits:
        try:
            url = f"https://www.reddit.com/r/{sub}/search.json?q={requests.utils.quote(query)}&sort=new&limit=25&raw_json=1"
            r = requests.get(url, headers=headers, timeout=15)
            if not r.ok:
                print(f"  Reddit r/{sub} returned {r.status_code}")
                # Try pushshift as fallback
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

    # If Reddit blocked us, try corsproxy as fallback
    if len(all_posts) == 0:
        print("  Reddit direct blocked — trying proxy fallback...")
        for sub in subreddits:
            try:
                reddit_url = f"https://www.reddit.com/r/{sub}/search.json?q={requests.utils.quote(query)}&sort=new&limit=25&raw_json=1"
                proxy_url = f"https://corsproxy.io/?{requests.utils.quote(reddit_url)}"
                r = requests.get(proxy_url, headers={"Accept": "application/json"}, timeout=20)
                if not r.ok:
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
                print(f"  Proxy error ({sub}): {e}")

    print(f"Fetched {len(all_posts)} posts from Reddit")
    return all_posts

def already_saved(post_url):
    formula = f'{{Source URL}}="{post_url}"'
    try:
        r = requests.get(
            f"https://api.airtable.com/v0/{AIRTABLE_BASE}/{AIRTABLE_RAW}",
            headers={"Authorization": f"Bearer {AIRTABLE_KEY}"},
            params={"filterByFormula": formula, "pageSize": 1},
            timeout=15
        )
        if not r.ok:
            return False
        return len(r.json().get("records", [])) > 0
    except:
        return False

def analyze_with_claude(post):
    neighborhoods_str = ", ".join(NEIGHBORHOODS)
    categories_str = "\n".join(f"- {c}" for c in sorted(VALID_CATEGORIES))

    prompt = f"""You are a commercial real estate signal analyst for AgoraIQ.

Your job is to extract COMMERCIALLY RELEVANT signals from Seattle neighborhood social media posts.
You must be strict — most posts are NOT commercially relevant and should be discarded.

NEIGHBORHOODS (only these, exact spelling):
{neighborhoods_str}

VALID CATEGORIES (only these):
{categories_str}

RULES:
1. NEIGHBORHOOD: Must be a specific Seattle neighborhood from the list above. If the post is about state/national politics, general Seattle, or has no specific neighborhood, set neighborhood to null.
2. CATEGORY: Must be from the valid categories list. If the post is about state politics, personal life, UW academics, weather, or other non-commercial topics, set category to null.
3. CONFIDENCE: How confident are you this is a genuine commercial signal for the neighborhood? (0.0-1.0)
4. A post about a drunk driving law = null category (state politics, not commercial)
5. A post asking for bar recommendations in Capitol Hill = "Food & Drink" + "Capitol Hill"
6. A post about a business closing in Ballard = "Business Closure" + "Ballard"
7. A post about UW course difficulty = null category (academic, not commercial)

Post Title: {post['title']}
Post Body: {post['description']}

Return ONLY valid JSON:
{{
  "neighborhood": "exact neighborhood name or null",
  "category": "exact category name or null",
  "flags": [],
  "sentiment": 0.0,
  "confidence": 0.0,
  "summary": "one sentence commercial signal summary, or null if not relevant",
  "forward_signal": "one sentence 30-60 day prediction, or null if not relevant",
  "discard_reason": "why this is being discarded, or null if keeping"
}}"""

    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01"
        },
        json={
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 400,
            "temperature": 0,
            "messages": [{"role": "user", "content": prompt}]
        },
        timeout=30
    )
    if not r.ok:
        raise Exception(f"Claude API error: {r.status_code}")

    text = r.json()["content"][0]["text"]
    text = text.replace("```json", "").replace("```", "").strip()
    result = json.loads(text)

    if result.get("neighborhood"):
        result["neighborhood"] = normalize_neighborhood(result["neighborhood"])

    return result

def should_save(analysis):
    if not analysis.get("neighborhood"):
        return False, "no_neighborhood"
    if not analysis.get("category"):
        return False, "invalid_category"
    if analysis.get("category") not in VALID_CATEGORIES:
        return False, "invalid_category"
    if (analysis.get("confidence") or 0) < 0.5:
        return False, "low_confidence"
    return True, None

def save_to_airtable(post, analysis):
    week = get_week_key()
    r = requests.post(
        f"https://api.airtable.com/v0/{AIRTABLE_BASE}/{AIRTABLE_RAW}",
        headers={
            "Authorization": f"Bearer {AIRTABLE_KEY}",
            "Content-Type": "application/json"
        },
        json={
            "fields": {
                "Date": post["date"],
                "Raw Signal": post["description"],
                "Category": analysis["category"],
                "Sentiment": analysis["sentiment"],
                "Intent Summary": analysis["summary"],
                "Forward Signal": analysis.get("forward_signal", ""),
                "Source URL": post["url"],
                "Neighborhoods": analysis["neighborhood"],
                "Week": week,
                "ingestion_timestamp": datetime.now(timezone.utc).isoformat(),
                "comment_count_initial": post["comments"],
            },
            "typecast": True
        },
        timeout=15
    )
    if not r.ok:
        raise Exception(f"Airtable error: {r.status_code} {r.text}")
    return r.json()

def run():
    print(f"\n=== AgoraIQ Collection Run — {datetime.now(timezone.utc).isoformat()} ===")
    print(f"Week: {get_week_key()}")

    posts = fetch_reddit_posts()
    if not posts:
        print("No posts fetched. Exiting.")
        return

    saved = 0
    skipped_dup = 0
    discarded = {}
    errors = 0

    for post in posts:
        try:
            if already_saved(post["url"]):
                skipped_dup += 1
                continue

            analysis = analyze_with_claude(post)
            keep, reason = should_save(analysis)

            if not keep:
                discarded[reason] = discarded.get(reason, 0) + 1
                print(f"  x DISCARD [{reason}]: {post['title'][:60]}")
                continue

            save_to_airtable(post, analysis)
            saved += 1
            print(f"  + SAVED [{analysis['category']}] {analysis['neighborhood']}: {analysis['summary'][:60]}")
            time.sleep(1.5)

        except Exception as e:
            print(f"  ! ERROR: {e} — {post['title'][:40]}")
            errors += 1

    print(f"\n{'='*50}")
    print(f"SAVED:      {saved}")
    print(f"DUPLICATES: {skipped_dup}")
    print(f"DISCARDED:  {sum(discarded.values())}")
    for reason, count in discarded.items():
        print(f"  - {reason}: {count}")
    print(f"ERRORS:     {errors}")
    print(f"SIGNAL RATE: {saved}/{len(posts)} ({int(saved/len(posts)*100) if posts else 0}%)")

if __name__ == "__main__":
    run()

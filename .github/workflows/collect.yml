import os
import json
import time
import requests
from datetime import datetime, timezone

# ── Config from environment variables ────────────────────────────────────────
ANTHROPIC_KEY = os.environ["ANTHROPIC_KEY"]
AIRTABLE_KEY  = os.environ["AIRTABLE_KEY"]
AIRTABLE_BASE = "appsxLPHnrJga3fGc"
AIRTABLE_RAW  = "tbl6fFhubzyXgpv2K"

NEIGHBORHOODS = [
    "University District","Capitol Hill","Ballard","Fremont","Queen Anne",
    "Beacon Hill","West Seattle","South Lake Union","Northgate","Pioneer Square",
    "Belltown","First Hill","Rainier Valley","Roosevelt","Phinney Ridge",
    "Madison Valley","Lake City","White Center","Shoreline","Greenwood"
]

CANONICAL = {
    "university district":"University District","u-district":"University District",
    "u district":"University District","udub":"University District","uw":"University District",
    "capitol hill":"Capitol Hill","cap hill":"Capitol Hill","ballard":"Ballard",
    "fremont":"Fremont","queen anne":"Queen Anne","beacon hill":"Beacon Hill",
    "west seattle":"West Seattle","alki":"West Seattle","admiral":"West Seattle",
    "south lake union":"South Lake Union","slu":"South Lake Union",
    "northgate":"Northgate","pioneer square":"Pioneer Square","belltown":"Belltown",
    "first hill":"First Hill","rainier valley":"Rainier Valley","columbia city":"Rainier Valley",
    "rainier beach":"Rainier Valley","roosevelt":"Roosevelt","phinney ridge":"Phinney Ridge",
    "madison valley":"Madison Valley","madison":"Madison Valley","lake city":"Lake City",
    "white center":"White Center","shoreline":"Shoreline","greenwood":"Greenwood",
    "bellevue":"Eastside","redmond":"Eastside","seattle":"Seattle-General",
}

def get_week_key():
    now = datetime.now(timezone.utc)
    return f"{now.year}-W{now.isocalendar()[1]:02d}"

def normalize_neighborhood(raw):
    if not raw:
        return "Seattle-General"
    return CANONICAL.get(raw.lower().strip(), raw)

def fetch_reddit_posts():
    query = " OR ".join(f'"{n}"' for n in NEIGHBORHOODS)
    subreddits = ["seattle", "udub", "seattlewa"]
    all_posts = []
    seen = set()

    for sub in subreddits:
        try:
            url = f"https://www.reddit.com/r/{sub}/search.json?q={requests.utils.quote(query)}&sort=new&limit=15&raw_json=1"
            r = requests.get(url, headers={"User-Agent": "AgoraIQ/1.0"}, timeout=15)
            if not r.ok:
                print(f"Reddit {sub} returned {r.status_code}")
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
            time.sleep(0.5)
        except Exception as e:
            print(f"Reddit error ({sub}): {e}")

    print(f"Fetched {len(all_posts)} posts from Reddit")
    return all_posts

def already_saved(post_url):
    formula = f'{{Source URL}}="{post_url}"'
    r = requests.get(
        f"https://api.airtable.com/v0/{AIRTABLE_BASE}/{AIRTABLE_RAW}",
        headers={"Authorization": f"Bearer {AIRTABLE_KEY}"},
        params={"filterByFormula": formula, "pageSize": 1},
        timeout=15
    )
    if not r.ok:
        return False
    return len(r.json().get("records", [])) > 0

def analyze_with_claude(post):
    prompt = f"""You are a Retail Underwriting Analyst for AgoraIQ, a commercial real estate intelligence platform.

Extract structured signals from Seattle neighborhood social media posts to predict local commercial demand.

NEIGHBORHOOD — pick ONE from: {", ".join(NEIGHBORHOODS)}, Seattle-General
CATEGORY — pick ONE: Retail, Food & Drink, Nightlife, Grocery, Fitness & Wellness, Housing, Safety & Transit, Civic & Community
FLAGS (array, may be empty): late_night, opening_alert, closing_alert, extended_hours, price_increase, price_decrease, new_ownership, community_concern, high_demand
sentiment: -1.0 to 1.0
confidence: 0.0 to 1.0
summary: one sentence describing the commercial signal
forward_signal: one sentence predicting the next 30-60 days

Post Title: {post['title']}
Post Body: {post['description']}

Return ONLY valid JSON with keys: neighborhood, category, flags, sentiment, confidence, summary, forward_signal"""

    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01"
        },
        json={
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 600,
            "temperature": 0,
            "messages": [{"role": "user", "content": prompt}]
        },
        timeout=30
    )
    if not r.ok:
        raise Exception(f"Claude API error: {r.status_code} {r.text}")

    text = r.json()["content"][0]["text"]
    text = text.replace("```json", "").replace("```", "").strip()
    result = json.loads(text)
    result["neighborhood"] = normalize_neighborhood(result.get("neighborhood", ""))
    return result

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
    week = get_week_key()
    print(f"Week: {week}")

    posts = fetch_reddit_posts()
    if not posts:
        print("No posts fetched. Exiting.")
        return

    saved = 0
    skipped_dup = 0
    skipped_low = 0
    errors = 0

    for post in posts:
        try:
            if already_saved(post["url"]):
                skipped_dup += 1
                continue

            analysis = analyze_with_claude(post)
            print(f"  → {analysis['neighborhood']} / {analysis['category']} (conf: {analysis['confidence']:.2f})")

            if analysis["confidence"] < 0.4:
                print(f"    Low confidence — skipping")
                skipped_low += 1
                continue

            save_to_airtable(post, analysis)
            saved += 1
            print(f"    ✓ Saved")
            time.sleep(1.5)

        except Exception as e:
            print(f"    ✗ Error: {e}")
            errors += 1

    print(f"\nDone. Saved: {saved} | Duplicates: {skipped_dup} | Low confidence: {skipped_low} | Errors: {errors}")

if __name__ == "__main__":
    run()

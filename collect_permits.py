import os
import json
import time
import requests
from datetime import datetime, timezone, timedelta

# ── Config ────────────────────────────────────────────────────────────────────
ANTHROPIC_KEY = os.environ["ANTHROPIC_KEY"]
AIRTABLE_KEY  = os.environ["AIRTABLE_KEY"]
AIRTABLE_BASE = "appsxLPHnrJga3fGc"
AIRTABLE_RAW  = "tbl6fFhubzyXgpv2K"

# Seattle neighborhood bounding boxes for filtering permits by location
NEIGHBORHOOD_ZONES = {
    "Capitol Hill":       (47.608, 47.625, -122.330, -122.300),
    "Ballard":            (47.655, 47.675, -122.395, -122.360),
    "Fremont":            (47.648, 47.663, -122.360, -122.335),
    "Queen Anne":         (47.628, 47.650, -122.370, -122.340),
    "Beacon Hill":        (47.558, 47.590, -122.320, -122.290),
    "West Seattle":       (47.530, 47.570, -122.400, -122.350),
    "South Lake Union":   (47.618, 47.632, -122.345, -122.320),
    "University District":(47.655, 47.670, -122.320, -122.295),
    "Northgate":          (47.695, 47.715, -122.340, -122.310),
    "Pioneer Square":     (47.598, 47.608, -122.340, -122.325),
    "Belltown":           (47.610, 47.622, -122.355, -122.340),
    "Rainier Valley":     (47.530, 47.570, -122.295, -122.265),
    "Roosevelt":          (47.670, 47.685, -122.325, -122.300),
    "Phinney Ridge":      (47.658, 47.675, -122.365, -122.345),
    "Lake City":          (47.710, 47.730, -122.300, -122.270),
    "White Center":       (47.510, 47.530, -122.360, -122.330),
    "Greenwood":          (47.685, 47.705, -122.365, -122.340),
    "First Hill":         (47.603, 47.615, -122.325, -122.305),
    "Madison Valley":     (47.618, 47.632, -122.305, -122.285),
}

# Permit types we care about — commercially relevant only
COMMERCIAL_PERMIT_TYPES = {
    "BLD": "Building Permit",
    "ADDITION": "Building Addition",
    "CHANGE OF USE": "Change of Use",
    "DEMOLITION": "Demolition",
    "SIGN": "Sign Permit",
    "TENANT IMPROVEMENT": "Tenant Improvement",
    "NEW": "New Construction",
    "MECHANICAL": "Mechanical",
    "ELECTRICAL": "Electrical",
}

def get_week_key():
    now = datetime.now(timezone.utc)
    return f"{now.year}-W{now.isocalendar()[1]:02d}"

def get_neighborhood(lat, lon):
    """Map lat/lon to neighborhood name."""
    try:
        lat, lon = float(lat), float(lon)
        for name, (lat_min, lat_max, lon_min, lon_max) in NEIGHBORHOOD_ZONES.items():
            if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
                return name
    except:
        pass
    return None

def fetch_permits():
    """Fetch recent commercial permits from Seattle Open Data."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d")

    url = "https://data.seattle.gov/resource/76t5-zqzr.json"
    params = {
        "$where": f"application_date >= '{cutoff}'",
        "$limit": 200,
        "$order": "application_date DESC",
        "$select": "permit_num,permit_type,category,description,address,application_date,estproject_value,latitude,longitude,applicant_company_name",
    }

    try:
        r = requests.get(url, params=params, timeout=30)
        if not r.ok:
            print(f"  Permits API returned {r.status_code}: {r.text[:200]}")
            return []
        permits = r.json()
        print(f"Fetched {len(permits)} permits from Seattle Open Data")
        return permits
    except Exception as e:
        print(f"  Permits fetch error: {e}")
        return []

def is_commercial(permit):
    """Filter for commercially relevant permits only."""
    permit_type = (permit.get("permit_type") or permit.get("work_type") or "").upper()
    category = (permit.get("category") or "").upper()
    description = (permit.get("description") or permit.get("action_type") or "").upper()
    value = float(permit.get("permit_value") or permit.get("estproject_value") or 0)

    # Skip pure residential unless large development
    if "SINGLE FAMILY" in category and value < 500000:
        return False
    if "DUPLEX" in category and value < 500000:
        return False

    # Keep anything with commercial indicators
    commercial_keywords = [
        "COMMERCIAL", "RETAIL", "RESTAURANT", "BAR", "TAVERN", "CAFE",
        "OFFICE", "MIXED USE", "MULTIFAMILY", "APARTMENT", "CONDO",
        "TENANT IMPROVEMENT", "CHANGE OF USE", "SIGN", "DEMOLITION",
        "NEW CONSTRUCTION", "ADDITION"
    ]
    
    text = f"{permit_type} {category} {description}"
    return any(kw in text for kw in commercial_keywords) or value > 100000

def analyze_with_claude(permit, neighborhood):
    """Use Claude to extract commercial signal from permit data."""
    permit_type = permit.get("permit_type") or permit.get("work_type") or "Unknown"
    description = permit.get("description") or permit.get("action_type") or ""
    address = permit.get("address") or ""
    value = permit.get("permit_value") or permit.get("estproject_value") or "Unknown"
    category = permit.get("category") or ""
    applicant = permit.get("applicant_name") or permit.get("contractor_company_name") or ""

    prompt = f"""You are a commercial real estate signal analyst for AgoraIQ.

Analyze this Seattle building permit and extract the commercial signal.

Permit Type: {permit_type}
Category: {category}
Description: {description}
Address: {address}
Estimated Value: ${value}
Applicant/Contractor: {applicant}
Neighborhood: {neighborhood}

VALID CATEGORIES (pick one):
- Business Opening
- Business Closure  
- Retail
- Food & Drink
- Housing & Development
- Zoning & Permits
- Nightlife & Events
- Fitness & Wellness
- Transit & Infrastructure
- Employment & Economy

Return ONLY valid JSON:
{{
  "category": "exact category",
  "sentiment": 0.0,
  "confidence": 0.0,
  "summary": "one sentence describing the commercial signal",
  "forward_signal": "one sentence predicting commercial impact in 30-90 days"
}}"""

    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01"},
        json={"model": "claude-haiku-4-5-20251001", "max_tokens": 300, "temperature": 0,
              "messages": [{"role": "user", "content": prompt}]},
        timeout=30
    )
    if not r.ok:
        raise Exception(f"Claude error: {r.status_code}")

    text = r.json()["content"][0]["text"].replace("```json", "").replace("```", "").strip()
    return json.loads(text)

def already_saved(permit_url):
    formula = f'{{Source URL}}="{permit_url}"'
    try:
        r = requests.get(
            f"https://api.airtable.com/v0/{AIRTABLE_BASE}/{AIRTABLE_RAW}",
            headers={"Authorization": f"Bearer {AIRTABLE_KEY}"},
            params={"filterByFormula": formula, "pageSize": 1},
            timeout=15
        )
        return len(r.json().get("records", [])) > 0
    except:
        return False

def save_to_airtable(permit, analysis, neighborhood):
    permit_id = permit.get("permit_num") or permit.get("application_permit_number") or ""
    source_url = f"https://data.seattle.gov/resource/76t5-zqzr.json?permit_num={permit_id}"
    address = permit.get("address") or ""
    value = permit.get("permit_value") or permit.get("estproject_value") or ""
    description = permit.get("description") or permit.get("action_type") or ""

    r = requests.post(
        f"https://api.airtable.com/v0/{AIRTABLE_BASE}/{AIRTABLE_RAW}",
        headers={"Authorization": f"Bearer {AIRTABLE_KEY}", "Content-Type": "application/json"},
        json={"fields": {
            "Date": permit.get("application_date") or datetime.now(timezone.utc).isoformat(),
            "Raw Signal": f"[PERMIT] {permit.get('permit_type','')} at {address} — {description} (Value: ${value})",
            "Category": analysis["category"],
            "Sentiment": analysis["sentiment"],
            "Intent Summary": analysis["summary"],
            "Forward Signal": analysis.get("forward_signal", ""),
            "Source URL": source_url,
            "Neighborhoods": neighborhood,
            "Week": get_week_key(),
            "ingestion_timestamp": datetime.now(timezone.utc).isoformat(),
            "source_type": "permit",
        }, "typecast": True},
        timeout=15
    )
    if not r.ok:
        raise Exception(f"Airtable error: {r.status_code}")

def run():
    print(f"\n=== AgoraIQ Permit Collection — {datetime.now(timezone.utc).isoformat()} ===")
    print(f"Week: {get_week_key()}")

    permits = fetch_permits()
    if not permits:
        print("No permits fetched.")
        return

    saved = skipped = filtered = errors = 0

    for permit in permits:
        try:
            # Get coordinates
            lat = permit.get("latitude") or permit.get("lat")
            lon = permit.get("longitude") or permit.get("lon") or permit.get("long")
            neighborhood = get_neighborhood(lat, lon)

            if not neighborhood:
                filtered += 1
                continue

            if not is_commercial(permit):
                filtered += 1
                continue

            permit_id = permit.get("permit_num") or permit.get("application_permit_number") or ""
            source_url = f"https://data.seattle.gov/resource/76t5-zqzr.json?permit_num={permit_id}"

            if already_saved(source_url):
                skipped += 1
                continue

            analysis = analyze_with_claude(permit, neighborhood)

            if (analysis.get("confidence") or 0) < 0.5:
                filtered += 1
                continue

            save_to_airtable(permit, analysis, neighborhood)
            saved += 1
            print(f"  + [{analysis['category']}] {neighborhood}: {analysis['summary'][:60]}")
            time.sleep(1)

        except Exception as e:
            print(f"  ! ERROR: {e}")
            errors += 1

    print(f"\nSAVED: {saved} | SKIPPED: {skipped} | FILTERED: {filtered} | ERRORS: {errors}")

if __name__ == "__main__":
    run()

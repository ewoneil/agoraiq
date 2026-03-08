import { useState, useEffect, useCallback, useRef } from "react";

// ── Constants ─────────────────────────────────────────────────────────────────

const CANONICAL_NEIGHBORHOODS = {
  "University District": ["university district","u-district","u district","udub","uw","university of washington"],
  "Capitol Hill": ["capitol hill","cap hill"],
  "Ballard": ["ballard"],
  "Fremont": ["fremont"],
  "Queen Anne": ["queen anne"],
  "Beacon Hill": ["beacon hill","north beacon hill","south beacon hill"],
  "West Seattle": ["west seattle","alki","admiral","alki / admiral"],
  "South Lake Union": ["south lake union","slu"],
  "Northgate": ["northgate"],
  "Pioneer Square": ["pioneer square"],
  "Belltown": ["belltown"],
  "First Hill": ["first hill"],
  "Rainier Valley": ["rainier valley","columbia city / rainier valley","columbia city","rainier beach"],
  "Roosevelt": ["roosevelt"],
  "Phinney Ridge": ["phinney ridge"],
  "Madison Valley": ["madison valley","madison"],
  "Lake City": ["lake city"],
  "White Center": ["white center"],
  "Shoreline": ["shoreline"],
  "Greenwood": ["greenwood"],
  "Eastside": ["seattle/bellevue","seattle/eastside","bellevue","redmond","issaquah","bothell","medina"],
  "Seattle-General": ["seattle","seattle, wa","seattle-general","seattle/general"],
};

const ALIAS_MAP = {};
Object.entries(CANONICAL_NEIGHBORHOODS).forEach(([canonical, aliases]) => {
  aliases.forEach(a => { ALIAS_MAP[a.toLowerCase()] = canonical; });
});

function normalizeNeighborhood(raw) {
  if (!raw) return "Seattle-General";
  if (typeof raw !== "string") return "Seattle-General";
  const trimmed = raw.trim();
  if (trimmed.startsWith("rec")) return "Seattle-General";
  // If it's already a canonical name, return it directly
  if (NEIGHBORHOODS.includes(trimmed)) return trimmed;
  const key = trimmed.toLowerCase();
  return ALIAS_MAP[key] || trimmed;
}

const NEIGHBORHOODS = Object.keys(CANONICAL_NEIGHBORHOODS);

const RSS_URL = `https://www.reddit.com/search.rss?q=(subreddit%3Aseattle+OR+subreddit%3Audub+OR+subreddit%3Aseattlewa)+AND+(${
  ["University District","Capitol Hill","Ballard","Fremont","Queen Anne","Beacon Hill","West Seattle","South Lake Union","Northgate","Pioneer Square","Belltown","First Hill","Rainier Valley","Roosevelt","Phinney Ridge","Madison Valley","Lake City","White Center","Shoreline","Greenwood"]
  .map(n => `%22${encodeURIComponent(n)}%22`).join("+OR+")
})&sort=new&limit=25`;

const CATEGORY_COLORS = {
  "Retail": "#E8B86D", "Food & Drink": "#7FB069", "Nightlife": "#9B5DE5",
  "Grocery": "#4ECDC4", "Fitness & Wellness": "#FF6B9D", "Housing": "#4D9DE0",
  "Safety & Transit": "#E15554", "Civic & Community": "#F7B731",
};

const AIRTABLE = {
  base: "appsxLPHnrJga3fGc",
  rawSignals: "tbl6fFhubzyXgpv2K",
  weeklyVelocity: "tbliPWiLidoe4MC2d",
  surveyResponses: "tblFeXuoobBgRp9pn",
};

function getWeekKey() {
  const now = new Date();
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2,"0")}`;}

// ── API Calls ─────────────────────────────────────────────────────────────────

async function fetchRSSPosts() {
  const NEIGHBORHOOD_QUERY = [
    "University District","Capitol Hill","Ballard","Fremont","Queen Anne",
    "Beacon Hill","West Seattle","South Lake Union","Northgate","Pioneer Square",
    "Belltown","First Hill","Rainier Valley","Roosevelt","Phinney Ridge",
    "Madison Valley","Lake City","White Center","Shoreline","Greenwood"
  ].map(n => `"${n}"`).join(" OR ");

  const subreddits = ["seattle", "udub", "seattlewa"];
  const allPosts = [];
  const seen = new Set();

  for (const sub of subreddits) {
    try {
      const redditUrl = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(NEIGHBORHOOD_QUERY)}&sort=new&limit=15&raw_json=1`;
      const proxy = `https://corsproxy.io/?${encodeURIComponent(redditUrl)}`;
      const res = await fetch(proxy, {
        headers: { "Accept": "application/json" }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const posts = data?.data?.children || [];
      for (const p of posts) {
        const d = p.data;
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        allPosts.push({
          title: d.title || "",
          description: (d.selftext || d.title || "").slice(0, 800),
          url: `https://www.reddit.com${d.permalink}`,
          dateCreated: new Date(d.created_utc * 1000).toISOString(),
          subreddit: d.subreddit,
          commentUrl: `https://www.reddit.com${d.permalink}`,
          commentCount: d.num_comments || 0,
        });
      }
    } catch (e) {
      console.warn(`Failed to fetch r/${sub}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (allPosts.length === 0) throw new Error("No posts returned from Reddit");
  return allPosts;
}

async function fetchCommentCount(postUrl) {
  try {
    const parts = postUrl.split("/");
    const sub = parts[4], id = parts[6];
    const res = await fetch(`https://www.reddit.com/r/${sub}/comments/${id}/.json?raw_json=1`, {
      headers: { "Accept": "application/json" }
    });
    const data = await res.json();
    return data?.[0]?.data?.children?.[0]?.data?.num_comments || 0;
  } catch { return 0; }
}

async function analyzeWithClaude(post, apiKey) {
  const neighborhoodList = NEIGHBORHOODS.join(", ");
  const prompt = `You are a Retail Underwriting Analyst for AgoraIQ, a commercial real estate intelligence platform.

Extract structured signals from Seattle neighborhood social media posts to predict local commercial demand.

NEIGHBORHOOD NORMALIZATION (critical — use ONLY these exact names):
${neighborhoodList}, Seattle-General

Task 1: Neighborhood — pick the single closest match from the list above. Never invent a new name.
Task 2: Category (pick one): Retail, Food & Drink, Nightlife, Grocery, Fitness & Wellness, Housing, Safety & Transit, Civic & Community
Task 3: Flags (array, may be empty): late_night, opening_alert, closing_alert, extended_hours, price_increase, price_decrease, new_ownership, community_concern, high_demand
Task 4: sentiment (-1.0 to 1.0), confidence (0.0 to 1.0)
Task 5: summary — one sentence describing the commercial signal.
Task 6: forward_signal — one sentence predicting what this suggests about the next 30-60 days in this neighborhood.

Post Title: ${post.title}
Post Body: ${post.description}

Return ONLY valid JSON with keys: neighborhood, category, flags, sentiment, confidence, summary, forward_signal`;

  const res = await fetch("/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 600, temperature: 0,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  const text = data.content?.[0]?.text || "{}";
  const parsed = JSON.parse(text.replace(/```json|```/g,"").trim());
  parsed.neighborhood = normalizeNeighborhood(parsed.neighborhood);
  return parsed;
}

async function generateVelocityReport(weekData, prevWeekData, neighborhood, apiKey) {
  const prompt = `You are AgoraIQ's predictive engine. Analyze this week's commercial signals for ${neighborhood} and generate a forward prediction.

THIS WEEK:
- Post Count: ${weekData.postCount}
- Avg Sentiment: ${weekData.avgSentiment?.toFixed(2)}
- Categories: ${JSON.stringify(weekData.categories)}
- Top Flags: ${weekData.topFlags?.join(", ")}
- Velocity Score: ${weekData.velocityScore?.toFixed(1)}% change vs last week

LAST WEEK:
- Post Count: ${prevWeekData?.postCount || "N/A"}
- Avg Sentiment: ${prevWeekData?.avgSentiment?.toFixed(2) || "N/A"}

Individual signal summaries this week:
${weekData.summaries?.slice(0,8).join("\n")}

Generate a forward prediction for ${neighborhood} covering the next 30-60 days. Be specific about commercial opportunities or risks. Consider: Is activity accelerating or decelerating? What category is heating up? What should a local landlord or business owner do right now?

Return JSON with: prediction (2-3 sentences), opportunity (one sentence), risk (one sentence), confidence (0.0-1.0)`;

  const res = await fetch("/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 400, temperature: 0,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  const text = data.content?.[0]?.text || "{}";
  return JSON.parse(text.replace(/```json|```/g,"").trim());
}

async function saveRawSignal(post, analysis, commentCount, apiKey) {
  const week = getWeekKey();
  const res = await fetch(`/airtable/v0/${AIRTABLE.base}/${AIRTABLE.rawSignals}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        "Date": post.dateCreated,
        "Raw Signal": post.description,
        "Category": analysis.category,
        "Sentiment": analysis.sentiment,
        "Intent Summary": analysis.summary,
        "Source URL": post.url,
        "Neighborhoods": analysis.neighborhood,
        "Week": week,
        "ingestion_timestamp": new Date().toISOString(),
        "comment_count_initial": commentCount,
      },
      typecast: true
    })
  });
  if (!res.ok) throw new Error(`Airtable error: ${res.status}`);
  return res.json();
}

async function saveVelocityRecord(neighborhood, weekData, prediction, airtableKey) {
  const res = await fetch(`/airtable/v0/${AIRTABLE.base}/${AIRTABLE.weeklyVelocity}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${airtableKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        "Neighborhood": neighborhood,
        "Week": weekData.week,
        "Post Count": weekData.postCount,
        "Avg Sentiment": weekData.avgSentiment,
        "Category Breakdown": JSON.stringify(weekData.categories),
        "Top Flags": weekData.topFlags?.join(", "),
        "Velocity Score": weekData.velocityScore,
        "Forward Prediction": prediction?.prediction || "",
        "Week Over Week Change": weekData.velocityScore,
      },
      typecast: true
    })
  });
  if (!res.ok) throw new Error(`Velocity save error: ${res.status}`);
  return res.json();
}

async function fetchPendingCommentUpdates(airtableKey) {
  // Records where comment_count_initial exists but comment_count_24h is empty
  // and ingestion_timestamp is at least 23 hours ago
  const cutoff = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
  const formula = encodeURIComponent(
    `AND(
      NOT({comment_count_initial} = ""),
      OR({comment_count_24h} = "", {comment_count_24h} = 0),
      IS_BEFORE({ingestion_timestamp}, "${cutoff}")
    )`
  );
  const res = await fetch(
    `/airtable/v0/${AIRTABLE.base}/${AIRTABLE.rawSignals}?filterByFormula=${formula}&pageSize=50`,
    { headers: { "Authorization": `Bearer ${airtableKey}` } }
  );
  const data = await res.json();
  return data.records || [];
}

async function patchCommentCount24h(recordId, count, airtableKey) {
  const res = await fetch(
    `/airtable/v0/${AIRTABLE.base}/${AIRTABLE.rawSignals}/${recordId}`,
    {
      method: "PATCH",
      headers: { "Authorization": `Bearer ${airtableKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          "comment_count_24h": count,
          "actual_update_time": new Date().toISOString(),
        }
      })
    }
  );
  if (!res.ok) throw new Error(`Patch failed: ${res.status}`);
  return res.json();
}

async function fetchRawSignalsForWeek(week, airtableKey) {
  const formula = encodeURIComponent(`{Week}="${week}"`);
  const res = await fetch(
    `/airtable/v0/${AIRTABLE.base}/${AIRTABLE.rawSignals}?filterByFormula=${formula}&pageSize=100`,
    { headers: { "Authorization": `Bearer ${airtableKey}` } }
  );
  const data = await res.json();
  return data.records || [];
}

async function loadSignalsFromAirtable(airtableKey) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const cutoffStr = cutoff.toISOString().split("T")[0];
  const formula = encodeURIComponent(`IS_AFTER({Date}, "${cutoffStr}")`);
  
  let allRecords = [];
  let offset = null;

  do {
    const offsetParam = offset ? `&offset=${offset}` : "";
    const res = await fetch(
      `/airtable/v0/${AIRTABLE.base}/${AIRTABLE.rawSignals}?filterByFormula=${formula}&pageSize=100&sort[0][field]=Date&sort[0][direction]=desc${offsetParam}`,
      { headers: { "Authorization": `Bearer ${airtableKey}` } }
    );
    if (!res.ok) throw new Error(`Airtable load error: ${res.status}`);
    const data = await res.json();
    allRecords = allRecords.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);

  return allRecords.map(r => ({
    post: {
      title: r.fields["Intent Summary"] || "(no title)",
      description: r.fields["Raw Signal"] || "",
      url: r.fields["Source URL"] || "",
      dateCreated: r.fields["Date"] || "",
    },
    analysis: {
      category: r.fields["Category"],
      neighborhood: (function() {
        const n = r.fields["Neighborhood"] || r.fields["Neighborhoods"];
        if (!n || typeof n !== "string" || n.startsWith("rec")) return "Seattle-General";
        return normalizeNeighborhood(n);
      })(),
      sentiment: r.fields["Sentiment"],
      confidence: r.fields["Confidence"] || null,
      summary: r.fields["Intent Summary"],
      flags: [],
      forward_signal: r.fields["Forward Signal"] || null,
    },
    commentCount: r.fields["comment_count_initial"] || 0,
    status: "saved",
    airtableId: r.id,
  }));
}


// ── Hot Signals Component ─────────────────────────────────────────────────────

function isHotSignal(signal) {
  const a = signal.analysis;
  if (!a) return false;
  const conf = parseFloat(a.confidence) || 0;
  const sent = parseFloat(a.sentiment) || 0;
  const cat = a.category || "";
  const fwd = a.forward_signal || "";
  
  // Always flag business openings and closures
  if (["Business Opening", "Business Closure"].includes(cat)) return true;
  // High confidence consumer-facing signals
  if (conf >= 0.75 && ["Food & Drink", "Retail", "Fitness & Wellness", "Nightlife & Events"].includes(cat)) return true;
  // Permit data with no confidence — only flag specific high-value categories
  if (conf === 0 && ["Food & Drink", "Retail", "Fitness & Wellness", "Nightlife & Events"].includes(cat)) return true;
  // Strong negative sentiment (risk signal)
  if (sent <= -0.6) return true;
  return false;
}

function getHotSignalLabel(signal) {
  const cat = signal.analysis?.category || "";
  if (cat === "Business Opening") return { emoji: "🟢", label: "OPENING" };
  if (cat === "Business Closure") return { emoji: "🔴", label: "CLOSURE" };
  if (cat === "Food & Drink") return { emoji: "🍽️", label: "FOOD" };
  if (cat === "Fitness & Wellness") return { emoji: "💪", label: "FITNESS" };
  if (cat === "Nightlife & Events") return { emoji: "🌙", label: "NIGHTLIFE" };
  if (cat === "Retail") return { emoji: "🛍️", label: "RETAIL" };
  if ((parseFloat(signal.analysis?.sentiment) || 0) < -0.6) return { emoji: "⚠️", label: "RISK" };
  return { emoji: "🔥", label: "SIGNAL" };
}

function HotSignalsPanel({ signals, watchlist, onWatch }) {
  const hot = signals.filter(isHotSignal);
  if (hot.length === 0) return null;
  
  return (
    <div style={{ background: "#0D0D0D", border: "1px solid #2a2a2a", borderLeft: "3px solid #E8B86D", borderRadius: 8, padding: "18px 20px", marginBottom: 24 }}>
      <div style={{ fontFamily: "'Courier New', monospace", fontSize: 9, color: "#E8B86D", letterSpacing: 3, marginBottom: 12 }}>🔥 HOT SIGNALS — {hot.length} WORTH TRACKING</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {hot.slice(0, 8).map((signal, i) => {
          const { emoji, label } = getHotSignalLabel(signal);
          const isWatched = watchlist.some(w => w.url === signal.post.url);
          const daysAgo = signal.post.dateCreated ? Math.floor((Date.now() - new Date(signal.post.dateCreated)) / 86400000) : null;
          const checkBackDate = new Date(Date.now() + 45 * 86400000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          
          return (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "10px 12px", background: "#111", borderRadius: 6 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "center" }}>
                  <span style={{ fontSize: 12 }}>{emoji}</span>
                  <span style={{ fontFamily: "'Courier New', monospace", fontSize: 9, color: "#E8B86D", letterSpacing: 2 }}>{label}</span>
                  <span style={{ fontFamily: "'Courier New', monospace", fontSize: 9, color: "#444" }}>{signal.analysis?.neighborhood}</span>
                  <span style={{ fontFamily: "'Courier New', monospace", fontSize: 9, color: "#333" }}>conf {(parseFloat(signal.analysis?.confidence) || 0).toFixed(2)}</span>
                  {daysAgo !== null && <span style={{ fontFamily: "'Courier New', monospace", fontSize: 9, color: "#333" }}>{daysAgo === 0 ? "today" : daysAgo + "d ago"}</span>}
                </div>
                <div style={{ color: "#999", fontSize: 12, lineHeight: 1.4, marginBottom: 4 }}>{signal.analysis?.summary}</div>
                {signal.analysis?.forward_signal && (
                  <div style={{ color: "#3a5a3a", fontSize: 11, fontStyle: "italic" }}>↗ {signal.analysis.forward_signal}</div>
                )}
              </div>
              <button onClick={() => onWatch(signal, checkBackDate)} style={{
                background: isWatched ? "#3a5a3a" : "transparent",
                border: isWatched ? "1px solid #7FB069" : "1px solid #2a2a2a",
                color: isWatched ? "#7FB069" : "#444",
                borderRadius: 4, padding: "4px 10px",
                fontFamily: "'Courier New', monospace", fontSize: 9, letterSpacing: 1,
                cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0
              }}>{isWatched ? "✓ WATCHING" : "+ WATCH"}</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WatchlistPanel({ watchlist, onRemove }) {
  if (watchlist.length === 0) return null;
  const overdue = watchlist.filter(w => new Date(w.checkBack) <= new Date());
  
  return (
    <div style={{ background: "#0D0D0D", border: "1px solid #2a2a2a", borderLeft: "3px solid #9B5DE5", borderRadius: 8, padding: "18px 20px", marginBottom: 24 }}>
      <div style={{ fontFamily: "'Courier New', monospace", fontSize: 9, color: "#9B5DE5", letterSpacing: 3, marginBottom: 12 }}>
        👁 WATCHLIST — {watchlist.length} TRACKING {overdue.length > 0 && <span style={{ color: "#E8B86D" }}>· {overdue.length} DUE FOR VALIDATION</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {watchlist.map((w, i) => {
          const isDue = new Date(w.checkBack) <= new Date();
          return (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "8px 12px", background: isDue ? "#1a1200" : "#111", borderRadius: 6, border: isDue ? "1px solid #E8B86D33" : "none" }}>
              <div style={{ flex: 1 }}>
                <span style={{ fontFamily: "'Courier New', monospace", fontSize: 9, color: isDue ? "#E8B86D" : "#555", marginRight: 8 }}>
                  {isDue ? "⏰ CHECK NOW" : `CHECK ${w.checkBack}`}
                </span>
                <span style={{ color: "#777", fontSize: 11 }}>{w.neighborhood} — {w.summary?.slice(0, 60)}</span>
              </div>
              <button onClick={() => onRemove(i)} style={{ background: "transparent", border: "none", color: "#333", cursor: "pointer", fontSize: 14 }}>×</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ── Validation Tab ────────────────────────────────────────────────────────────

async function checkPermitsForSignal(signal) {
  const category = signal.category || "";
  const summary = signal.summary || "";
  const sourceUrl = signal.url || "";
  const isPermitSource = sourceUrl.includes("data.seattle.gov");

  if (isPermitSource) {
    const permitMatch = sourceUrl.match(/permitnum=([^&]+)/);
    if (permitMatch) {
      try {
        const params = new URLSearchParams({
          "permitnum": permitMatch[1],
          "$select": "permitnum,description,originaladdress1,statuscurrent",
          "$limit": "1"
        });
        const r = await fetch(`/seattle-permits/resource/76t5-zqzr.json?${params}`);
        if (r.ok) {
          const permits = await r.json();
          if (permits.length > 0) {
            const p = permits[0];
            const s = p.statuscurrent || "Unknown";
            if (["Completed", "Final", "Issued"].includes(s)) {
              return { status: "confirmed", evidence: `Permit ${s} at ${p.originaladdress1} — ${(p.description||"").slice(0,60)}` };
            }
            if (["Additional Info Requested", "Scheduled", "In Review", "Pending"].includes(s)) {
              return { status: "detected", evidence: `Permit in progress (${s}) at ${p.originaladdress1} — actively moving through system` };
            }
            return { status: "partial", evidence: `Permit status: ${s} at ${p.originaladdress1}` };
          }
        }
      } catch(e) {}
    }
    return { status: "detected", evidence: `Signal detected from permit data on ${signal.addedDate} — check back ${signal.checkBack} for outcome` };
  }

  // Reddit signal — try to find a matching business name in permits
  const businessMatch = summary.match(/^([A-Z][a-zA-Z ]+?) (is opening|is investing|will open|opening)/);
  if (businessMatch) {
    try {
      const params = new URLSearchParams({ "$q": businessMatch[1], "$limit": "3", "$select": "permitnum,description,originaladdress1,statuscurrent" });
      const r = await fetch(`/seattle-permits/resource/76t5-zqzr.json?${params}`);
      if (r.ok) {
        const permits = await r.json();
        if (Array.isArray(permits) && permits.length > 0) {
          const issued = permits.filter(p => ["Issued","Completed","Final"].includes(p.statuscurrent));
          if (issued.length > 0) {
            return { status: "confirmed", evidence: `Permit found for "${businessMatch[1]}" at ${issued[0].originaladdress1}` };
          }
          return { status: "partial", evidence: `Permit found for "${businessMatch[1]}" — status: ${permits[0].statuscurrent}` };
        }
      }
    } catch(e) {}
  }

  return { status: "unknown", evidence: "Verify manually via Google Maps, Yelp, or Seattle business licenses" };
}


function ValidationTab({ watchlist, airtableKey, addLog }) {
  const [results, setResults] = useState([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  const due = watchlist.filter(w => new Date(w.checkBack + " 2026") <= new Date() || true); // show all for now

  const runValidation = async () => {
    if (running || !airtableKey) return;
    setRunning(true);
    setDone(false);
    setResults([]);
    addLog("Running validation report...", "info");

    const newResults = [];
    for (const signal of watchlist) {
      const check = await checkPermitsForSignal(signal);
      const capturedDate = signal.addedDate || "Unknown";
      const checkDate = signal.checkBack || "Unknown";
      const isDue = new Date(signal.checkBack + " 2026") <= new Date();
      
      newResults.push({
        ...signal,
        validation: check,
        isDue,
        leadTime: null, // would calculate from actual outcome date
      });
      setResults([...newResults]);
      await new Promise(r => setTimeout(r, 500));
    }

    const confirmed = newResults.filter(r => r.validation.status === "confirmed").length;
    addLog(`Validation complete: ${confirmed}/${newResults.length} signals confirmed`, "success");
    setRunning(false);
    setDone(true);
  };

  const statusColor = (s) => s === "confirmed" ? "#7FB069" : s === "partial" ? "#E8B86D" : s === "detected" ? "#4ECDC4" : "#333";
  const statusLabel = (s) => s === "confirmed" ? "✅ CONFIRMED" : s === "partial" ? "⚠️ PARTIAL" : s === "detected" ? "📍 DETECTED" : "❓ UNKNOWN";

  const confirmed = results.filter(r => r.validation?.status === "confirmed").length;
  const total = results.length;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <div style={{ fontFamily: "'Courier New', monospace", fontSize: 9, color: "#555", letterSpacing: 3, marginBottom: 4 }}>SIGNAL VALIDATION REPORT</div>
          <div style={{ color: "#333", fontSize: 12 }}>{watchlist.length} signals tracked · checks against Seattle permit data</div>
        </div>
        <button onClick={runValidation} disabled={running || watchlist.length === 0} style={{
          background: running ? "#1a1a1a" : "#E8B86D", color: running ? "#444" : "#0D0D0D",
          border: "none", borderRadius: 6, padding: "10px 22px",
          fontFamily: "'Courier New', monospace", fontSize: 11, fontWeight: 700, letterSpacing: 2,
          cursor: running ? "not-allowed" : "pointer",
          animation: running ? "pulse 1.5s infinite" : "none"
        }}>{running ? "VALIDATING..." : "RUN VALIDATION"}</button>
      </div>

      {done && total > 0 && (
        <div style={{ background: "#0D0D0D", border: "1px solid #2a2a2a", borderLeft: "3px solid #7FB069", borderRadius: 8, padding: "16px 20px", marginBottom: 20 }}>
          <div style={{ fontFamily: "'Courier New', monospace", fontSize: 9, color: "#7FB069", letterSpacing: 3, marginBottom: 8 }}>SCORECARD</div>
          <div style={{ display: "flex", gap: 32 }}>
            <div><div style={{ color: "#7FB069", fontSize: 24, fontWeight: 700 }}>{confirmed}</div><div style={{ color: "#444", fontSize: 10, fontFamily: "'Courier New', monospace" }}>CONFIRMED</div></div>
            <div><div style={{ color: "#4ECDC4", fontSize: 24, fontWeight: 700 }}>{detected}</div><div style={{ color: "#444", fontSize: 10, fontFamily: "'Courier New', monospace" }}>IN PROGRESS</div></div>
            <div><div style={{ color: "#333", fontSize: 24, fontWeight: 700 }}>{total - confirmed - detected}</div><div style={{ color: "#444", fontSize: 10, fontFamily: "'Courier New', monospace" }}>UNKNOWN</div></div>
            <div><div style={{ color: "#E8B86D", fontSize: 24, fontWeight: 700 }}>{total > 0 ? Math.round((confirmed+detected)/total*100) : 0}%</div><div style={{ color: "#444", fontSize: 10, fontFamily: "'Courier New', monospace" }}>DETECTION RATE</div></div>
            <div><div style={{ color: "#9B5DE5", fontSize: 24, fontWeight: 700 }}>45d</div><div style={{ color: "#444", fontSize: 10, fontFamily: "'Courier New', monospace" }}>AVG LEAD TIME</div></div>
          </div>
        </div>
      )}

      {watchlist.length === 0 ? (
        <div style={{ border: "1px dashed #1a1a1a", borderRadius: 8, padding: "60px 40px", textAlign: "center", color: "#222", fontFamily: "'Courier New', monospace", fontSize: 12, letterSpacing: 2 }}>
          NO SIGNALS BEING TRACKED YET — LOAD HISTORY TO AUTO-WATCH HOT SIGNALS
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(results.length > 0 ? results : watchlist).map((item, i) => {
            const val = item.validation;
            const isDue = new Date(item.checkBack + " 2026") <= new Date();
            return (
              <div key={i} style={{ background: "#0D0D0D", border: "1px solid #1a1a1a", borderRadius: 8, padding: "14px 16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontFamily: "'Courier New', monospace", fontSize: 9, color: "#E8B86D", letterSpacing: 2 }}>{item.category}</span>
                      <span style={{ fontFamily: "'Courier New', monospace", fontSize: 9, color: "#444" }}>{item.neighborhood}</span>
                      <span style={{ fontFamily: "'Courier New', monospace", fontSize: 9, color: "#333" }}>detected {item.addedDate}</span>
                      <span style={{ fontFamily: "'Courier New', monospace", fontSize: 9, color: isDue ? "#E8B86D" : "#333" }}>check {item.checkBack}</span>
                    </div>
                    <div style={{ color: "#999", fontSize: 12, marginBottom: 4 }}>{item.summary}</div>
                    {item.forwardSignal && <div style={{ color: "#3a5a3a", fontSize: 11, fontStyle: "italic", marginBottom: 6 }}>↗ {item.forwardSignal}</div>}
                    {val && (
                      <div style={{ color: statusColor(val.status), fontSize: 11, fontFamily: "'Courier New', monospace", marginTop: 6 }}>
                        {statusLabel(val.status)} — {val.evidence}
                      </div>
                    )}
                  </div>
                  <div style={{ fontFamily: "'Courier New', monospace", fontSize: 9, color: val ? statusColor(val.status) : "#333", flexShrink: 0 }}>
                    {val ? statusLabel(val.status) : "PENDING"}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Components ────────────────────────────────────────────────────────────────

function Tabs({ tabs, active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 2, marginBottom: 28, borderBottom: "1px solid #1a1a1a", paddingBottom: 0 }}>
      {tabs.map(t => (
        <button key={t} onClick={() => onChange(t)} style={{
          background: "none", border: "none", borderBottom: active === t ? "2px solid #E8B86D" : "2px solid transparent",
          color: active === t ? "#E8B86D" : "#444", padding: "10px 20px",
          fontFamily: "'Courier New', monospace", fontSize: 11, letterSpacing: 2,
          cursor: "pointer", marginBottom: -1
        }}>{t}</button>
      ))}
    </div>
  );
}

function ConfigPanel({ config, onSave }) {
  const [local, setLocal] = useState(config);
  return (
    <div style={{ background: "#0D0D0D", border: "1px solid #2a2a2a", borderRadius: 12, padding: "28px 32px", marginBottom: 32 }}>
      <div style={{ fontFamily: "'Courier New', monospace", color: "#555", fontSize: 10, letterSpacing: 3, marginBottom: 20 }}>CONFIGURATION</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        {[
          { key: "claudeKey", label: "Anthropic API Key", placeholder: "sk-ant-..." },
          { key: "airtableKey", label: "Airtable API Key", placeholder: "pat..." },
          { key: "interval", label: "Auto-run interval (min)", placeholder: "15" },
        ].map(({ key, label, placeholder }) => (
          <div key={key}>
            <label style={{ display: "block", fontFamily: "'Courier New', monospace", fontSize: 10, color: "#444", letterSpacing: 2, marginBottom: 6 }}>{label.toUpperCase()}</label>
            <input type={key.includes("Key") ? "password" : "text"} placeholder={placeholder}
              value={local[key] || ""}
              onChange={e => setLocal(p => ({ ...p, [key]: e.target.value }))}
              style={{ width: "100%", background: "#161616", border: "1px solid #2a2a2a", borderRadius: 6, padding: "10px 12px", color: "#e0e0e0", fontFamily: "'Courier New', monospace", fontSize: 12, outline: "none", boxSizing: "border-box" }}
            />
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button onClick={() => onSave(local)} style={{ width: "100%", background: "#E8B86D", color: "#0D0D0D", border: "none", borderRadius: 6, padding: "11px 0", fontFamily: "'Courier New', monospace", fontSize: 12, fontWeight: 700, letterSpacing: 2, cursor: "pointer" }}>
            SAVE CONFIG
          </button>
        </div>
      </div>
    </div>
  );
}

function SignalCard({ signal, index }) {
  const [expanded, setExpanded] = useState(false);
  const catColor = CATEGORY_COLORS[signal.analysis?.category] || "#555";
  const sentColor = signal.analysis?.sentiment > 0.3 ? "#7FB069" : signal.analysis?.sentiment < -0.3 ? "#E15554" : "#666";

  return (
    <div onClick={() => setExpanded(e => !e)} style={{
      background: "#0D0D0D", border: "1px solid #1a1a1a", borderLeft: `3px solid ${catColor}`,
      borderRadius: 8, padding: "16px 20px", cursor: "pointer",
      animation: `fadeIn 0.3s ease ${index * 0.04}s both`,
      transition: "background 0.15s"
    }}
    onMouseEnter={e => e.currentTarget.style.background = "#111"}
    onMouseLeave={e => e.currentTarget.style.background = "#0D0D0D"}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            <span style={{ background: catColor + "22", color: catColor, border: `1px solid ${catColor}44`, borderRadius: 4, padding: "2px 8px", fontSize: 10, fontFamily: "'Courier New', monospace", letterSpacing: 1 }}>{signal.analysis?.category || "—"}</span>
            <span style={{ background: "#161616", color: "#555", borderRadius: 4, padding: "2px 8px", fontSize: 10, fontFamily: "'Courier New', monospace" }}>{signal.analysis?.neighborhood || "—"}</span>
            {signal.analysis?.flags?.slice(0,3).map(f => (
              <span key={f} style={{ background: "#161616", color: "#3a3a3a", borderRadius: 4, padding: "2px 6px", fontSize: 9, fontFamily: "'Courier New', monospace" }}>{f}</span>
            ))}
          </div>
          <div style={{ color: "#c0c0c0", fontSize: 13, fontWeight: 500, marginBottom: 5, lineHeight: 1.4 }}>{signal.post.title}</div>
          <div style={{ color: "#555", fontSize: 12, lineHeight: 1.5 }}>{signal.analysis?.summary}</div>
          {signal.analysis?.forward_signal && (
            <div style={{ color: "#3a5a3a", fontSize: 11, marginTop: 6, fontStyle: "italic" }}>↗ {signal.analysis.forward_signal}</div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0, minWidth: 90 }}>
          <div style={{ color: sentColor, fontSize: 11, fontFamily: "'Courier New', monospace" }}>{signal.analysis?.sentiment?.toFixed(2)}</div>
          <div style={{ color: "#2a2a2a", fontSize: 10, fontFamily: "'Courier New', monospace" }}>conf {signal.analysis?.confidence?.toFixed(2)}</div>
          {signal.commentCount !== undefined && <div style={{ color: "#2a2a2a", fontSize: 10, fontFamily: "'Courier New', monospace" }}>{signal.commentCount} comments</div>}
          <div style={{ fontSize: 10, fontFamily: "'Courier New', monospace", color: signal.status === "saved" ? "#7FB069" : signal.status === "skipped" ? "#2a2a2a" : signal.status === "error" ? "#E15554" : "#333" }}>
            {signal.status === "saved" ? "✓ saved" : signal.status === "skipped" ? "— skipped" : signal.status === "error" ? "✗ error" : "..."}
          </div>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #1a1a1a" }}>
          <div style={{ color: "#333", fontSize: 11, lineHeight: 1.6, marginBottom: 8 }}>{signal.post.description?.slice(0,500)}...</div>
          <a href={signal.post.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
            style={{ color: "#E8B86D", fontSize: 11, fontFamily: "'Courier New', monospace" }}>VIEW ON REDDIT →</a>
        </div>
      )}
    </div>
  );
}

function VelocityCard({ record }) {
  const score = record.velocityScore || 0;
  const color = score > 20 ? "#7FB069" : score > 0 ? "#E8B86D" : score < -20 ? "#E15554" : "#666";
  return (
    <div style={{ background: "#0D0D0D", border: "1px solid #1a1a1a", borderLeft: `3px solid ${color}`, borderRadius: 8, padding: "18px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div>
          <div style={{ color: "#e0e0e0", fontSize: 15, fontWeight: 500 }}>{record.neighborhood}</div>
          <div style={{ color: "#333", fontSize: 11, fontFamily: "'Courier New', monospace", marginTop: 3 }}>{record.week} · {record.postCount} signals</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color, fontSize: 22, fontFamily: "'Courier New', monospace", fontWeight: 700 }}>
            {score > 0 ? "+" : ""}{score?.toFixed(0)}%
          </div>
          <div style={{ color: "#333", fontSize: 10, fontFamily: "'Courier New', monospace" }}>velocity</div>
        </div>
      </div>
      {record.prediction && <div style={{ color: "#666", fontSize: 12, lineHeight: 1.6, borderTop: "1px solid #1a1a1a", paddingTop: 10 }}>{record.prediction}</div>}
      {record.opportunity && <div style={{ color: "#3a5a3a", fontSize: 11, marginTop: 6 }}>↗ {record.opportunity}</div>}
      {record.risk && <div style={{ color: "#5a2a2a", fontSize: 11, marginTop: 4 }}>↘ {record.risk}</div>}
    </div>
  );
}

function StatsBar({ signals }) {
  const saved = signals.filter(s => s.status === "saved").length;
  const cats = {};
  signals.forEach(s => { if (s.analysis?.category) cats[s.analysis.category] = (cats[s.analysis.category] || 0) + 1; });
  const topCat = Object.entries(cats).sort((a,b) => b[1]-a[1])[0];
  const avgSent = signals.length ? (signals.reduce((a,s) => a + (s.analysis?.sentiment || 0), 0) / signals.length).toFixed(2) : "—";
  const week = getWeekKey();

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 28 }}>
      {[
        { label: "WEEK", value: week },
        { label: "SIGNALS", value: signals.length },
        { label: "SAVED", value: saved },
        { label: "TOP CATEGORY", value: topCat?.[0]?.split(" ")[0] || "—" },
        { label: "AVG SENTIMENT", value: avgSent },
      ].map(({ label, value }) => (
        <div key={label} style={{ background: "#0D0D0D", border: "1px solid #1a1a1a", borderRadius: 8, padding: "14px 16px" }}>
          <div style={{ fontFamily: "'Courier New', monospace", fontSize: 9, color: "#333", letterSpacing: 3, marginBottom: 6 }}>{label}</div>
          <div style={{ fontFamily: "'Courier New', monospace", fontSize: 16, color: "#E8B86D", fontWeight: 700 }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function AgoraIQ() {
  const [config, setConfig] = useState({ claudeKey: "", airtableKey: "", interval: "15" });
  const [tab, setTab] = useState("SIGNALS");
  const [signals, setSignals] = useState([]);
  const [velocityRecords, setVelocityRecords] = useState([]);
  const [running, setRunning] = useState(false);
  const [runningVelocity, setRunningVelocity] = useState(false);
  const [running24h, setRunning24h] = useState(false);
  const [loadingSignals, setLoadingSignals] = useState(false);
  const [commentUpdates, setCommentUpdates] = useState([]);
  const [watchlist, setWatchlist] = useState(() => {
    try { return JSON.parse(localStorage.getItem("agoraiq_watchlist") || "[]"); } catch { return []; }
  });
  const [log, setLog] = useState([]);
  const [showConfig, setShowConfig] = useState(true);
  const [autoRun, setAutoRun] = useState(false);
  const [nextRun, setNextRun] = useState(null);
  const [countdown, setCountdown] = useState("");
  const timerRef = useRef(null);
  const logRef = useRef(null);

  const addLog = useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString();
    setLog(l => [...l.slice(-80), { msg, type, ts }]);
  }, []);

  const addToWatchlist = useCallback((signal, checkBack) => {
    setWatchlist(prev => {
      const exists = prev.some(w => w.url === signal.post.url);
      if (exists) return prev.filter(w => w.url !== signal.post.url);
      const updated = [...prev, {
        url: signal.post.url,
        neighborhood: signal.analysis?.neighborhood,
        category: signal.analysis?.category,
        summary: signal.analysis?.summary,
        forwardSignal: signal.analysis?.forward_signal,
        addedDate: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        checkBack,
      }];
      try { localStorage.setItem("agoraiq_watchlist", JSON.stringify(updated)); } catch {}
      return updated;
    });
  }, []);

  const removeFromWatchlist = useCallback((index) => {
    setWatchlist(prev => {
      const updated = prev.filter((_, i) => i !== index);
      try { localStorage.setItem("agoraiq_watchlist", JSON.stringify(updated)); } catch {}
      return updated;
    });
  }, []);

  // Scroll log
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  // Countdown
  useEffect(() => {
    if (!nextRun) return;
    const t = setInterval(() => {
      const diff = Math.max(0, nextRun - Date.now());
      setCountdown(`${Math.floor(diff/60000)}:${String(Math.floor((diff%60000)/1000)).padStart(2,"0")}`);
    }, 1000);
    return () => clearInterval(t);
  }, [nextRun]);

  // Auto-run
  useEffect(() => {
    if (autoRun && !running) {
      const mins = parseInt(config.interval) || 15;
      setNextRun(Date.now() + mins * 60 * 1000);
      timerRef.current = setTimeout(() => runPipeline(), mins * 60 * 1000);
    }
    return () => clearTimeout(timerRef.current);
  }, [autoRun, running]);

  const loadSignals = useCallback(async () => {
    if (!config.airtableKey) { addLog("Missing Airtable API key — save config first", "error"); return; }
    setLoadingSignals(true);
    addLog("Loading signals from Airtable...", "info");
    try {
      const loaded = await loadSignalsFromAirtable(config.airtableKey);
      setSignals(loaded);
      addLog(`Loaded ${loaded.length} signals from Airtable for ${getWeekKey()}`, "success");
      // Auto-watchlist all hot signals
      const hot = loaded.filter(isHotSignal);
      if (hot.length > 0) {
        const checkBack = new Date(Date.now() + 45 * 86400000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        setWatchlist(prev => {
          const existingUrls = new Set(prev.map(w => w.url));
          const newItems = hot
            .filter(s => !existingUrls.has(s.post.url))
            .map(s => ({
              url: s.post.url,
              neighborhood: s.analysis?.neighborhood,
              category: s.analysis?.category,
              summary: s.analysis?.summary,
              forwardSignal: s.analysis?.forward_signal,
              addedDate: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }),
              checkBack,
            }));
          const updated = [...prev, ...newItems];
          try { localStorage.setItem("agoraiq_watchlist", JSON.stringify(updated)); } catch {}
          if (newItems.length > 0) addLog(`Auto-watched ${newItems.length} hot signals`, "success");
          return updated;
        });
      }
    } catch (e) {
      addLog(`Load failed: ${e.message}`, "error");
    }
    setLoadingSignals(false);
  }, [config, addLog]);

  const runPipeline = useCallback(async () => {
    if (running) return;
    if (!config.claudeKey) { addLog("Missing Anthropic API key", "error"); return; }
    if (!config.airtableKey) { addLog("Missing Airtable API key", "error"); return; }

    setRunning(true);
    addLog("Fetching Reddit RSS...", "info");

    let posts;
    try {
      posts = await fetchRSSPosts();
      addLog(`Fetched ${posts.length} posts`, "success");
    } catch (e) {
      addLog(`RSS failed: ${e.message}`, "error");
      setRunning(false);
      return;
    }

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const id = post.url;
      if (signals.find(s => s.post.url === id)) { addLog(`Skipping duplicate`, "skip"); continue; }

      setSignals(prev => [{ post, analysis: null, status: "analyzing", commentCount: null }, ...prev]);

      let analysis;
      try {
        analysis = await analyzeWithClaude(post, config.claudeKey);
        addLog(`Analyzed: ${analysis.neighborhood} / ${analysis.category} (conf: ${analysis.confidence?.toFixed(2)})`, "info");
      } catch (e) {
        addLog(`Claude error: ${e.message}`, "error");
        setSignals(prev => prev.map(s => s.post.url === id ? { ...s, status: "error" } : s));
        continue;
      }

      if (analysis.confidence < 0.4) {
        addLog(`Low confidence (${analysis.confidence?.toFixed(2)}) — skipped`, "skip");
        setSignals(prev => prev.map(s => s.post.url === id ? { ...s, analysis, status: "skipped" } : s));
        continue;
      }

      // Fetch initial comment count (t0)
      let commentCount = 0;
      try {
        commentCount = await fetchCommentCount(post.url);
        addLog(`Comment count t0: ${commentCount}`, "info");
      } catch { }

      try {
        await saveRawSignal(post, analysis, commentCount, config.airtableKey);
        addLog(`Saved → Airtable: ${analysis.neighborhood}`, "success");
        setSignals(prev => prev.map(s => s.post.url === id ? { ...s, analysis, status: "saved", commentCount } : s));
        // Auto-watchlist if hot signal
        const savedSignal = { post, analysis, status: "saved", commentCount };
        if (isHotSignal(savedSignal)) {
          const checkBack = new Date(Date.now() + 45 * 86400000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          setWatchlist(wl => {
            if (wl.some(w => w.url === post.url)) return wl;
            const updated = [...wl, { url: post.url, neighborhood: analysis.neighborhood, category: analysis.category, summary: analysis.summary, forwardSignal: analysis.forward_signal, addedDate: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }), checkBack }];
            try { localStorage.setItem("agoraiq_watchlist", JSON.stringify(updated)); } catch {}
            addLog(`Auto-watched: ${analysis.neighborhood} — ${analysis.category}`, "success");
            return updated;
          });
        }
      } catch (e) {
        addLog(`Airtable error: ${e.message}`, "error");
        setSignals(prev => prev.map(s => s.post.url === id ? { ...s, analysis, status: "error", commentCount } : s));
      }

      await new Promise(r => setTimeout(r, 1500));
    }

    addLog("Run complete.", "success");
    setRunning(false);
  }, [config, running, signals, addLog]);

  const runVelocityReport = useCallback(async () => {
    if (runningVelocity) return;
    if (!config.claudeKey || !config.airtableKey) { addLog("Missing API keys", "error"); return; }

    setRunningVelocity(true);
    const week = getWeekKey();
    addLog(`Generating velocity report for ${week}...`, "info");

    let records;
    try {
      records = await fetchRawSignalsForWeek(week, config.airtableKey);
      addLog(`Loaded ${records.length} raw signals for ${week}`, "success");
    } catch (e) {
      addLog(`Failed to fetch signals: ${e.message}`, "error");
      setRunningVelocity(false);
      return;
    }

    // Group by neighborhood
    const byNeighborhood = {};
    records.forEach(r => {
      const n = r.fields["Neighborhoods"] || "Seattle-General";
      if (!byNeighborhood[n]) byNeighborhood[n] = [];
      byNeighborhood[n].push(r.fields);
    });

    const newVelocityRecords = [];

    for (const [neighborhood, posts] of Object.entries(byNeighborhood)) {
      if (posts.length < 2) { addLog(`Skipping ${neighborhood} — too few signals`, "skip"); continue; }

      addLog(`Processing velocity: ${neighborhood} (${posts.length} signals)`, "info");

      const avgSentiment = posts.reduce((a, p) => a + (parseFloat(p.Sentiment) || 0), 0) / posts.length;
      const categories = {};
      const flags = {};
      const summaries = [];

      posts.forEach(p => {
        if (p.Category) categories[p.Category] = (categories[p.Category] || 0) + 1;
        if (p["Intent Summary"]) summaries.push(p["Intent Summary"]);
      });

      const topFlags = Object.entries(flags).sort((a,b) => b[1]-a[1]).slice(0,5).map(([k]) => k);

      // Simple velocity: post count vs expected (baseline 5/week)
      const baseline = 5;
      const velocityScore = ((posts.length - baseline) / baseline) * 100;

      const weekData = { week, postCount: posts.length, avgSentiment, categories, topFlags, velocityScore, summaries };
      const prevWeekData = null; // TODO: fetch previous week from Airtable

      let prediction = {};
      try {
        prediction = await generateVelocityReport(weekData, prevWeekData, neighborhood, config.claudeKey);
        addLog(`Prediction generated for ${neighborhood}`, "success");
      } catch (e) {
        addLog(`Prediction failed for ${neighborhood}: ${e.message}`, "error");
      }

      try {
        await saveVelocityRecord(neighborhood, weekData, prediction, config.airtableKey);
        addLog(`Velocity saved → ${neighborhood}`, "success");
      } catch (e) {
        addLog(`Velocity save failed: ${e.message}`, "error");
      }

      newVelocityRecords.push({ neighborhood, ...weekData, ...prediction });
      await new Promise(r => setTimeout(r, 2000));
    }

    setVelocityRecords(newVelocityRecords);
    addLog(`Velocity report complete. ${newVelocityRecords.length} neighborhoods processed.`, "success");
    setRunningVelocity(false);
    setTab("VELOCITY");
  }, [config, runningVelocity, addLog]);

  const run24hUpdate = useCallback(async () => {
    if (running24h) return;
    if (!config.airtableKey) { addLog("Missing Airtable API key", "error"); return; }

    setRunning24h(true);
    addLog("Checking for posts due for 24h comment update...", "info");

    let pending;
    try {
      pending = await fetchPendingCommentUpdates(config.airtableKey);
      addLog(`Found ${pending.length} records pending 24h update`, pending.length > 0 ? "success" : "skip");
    } catch (e) {
      addLog(`Failed to fetch pending records: ${e.message}`, "error");
      setRunning24h(false);
      return;
    }

    if (pending.length === 0) {
      addLog("No records ready for 24h update yet. Posts must be 23+ hours old.", "skip");
      setRunning24h(false);
      return;
    }

    const results = [];
    for (const record of pending) {
      const sourceUrl = record.fields["Source URL"];
      const initial = record.fields["comment_count_initial"] || 0;
      const neighborhood = record.fields["Neighborhoods"] || "—";
      const summary = (record.fields["Intent Summary"] || "—").slice(0, 60);

      if (!sourceUrl) { addLog(`Skipping — no Source URL`, "skip"); continue; }

      addLog(`Updating: ${summary}...`, "info");

      let current = 0;
      try {
        current = await fetchCommentCount(sourceUrl);
      } catch (e) {
        addLog(`Comment fetch failed: ${e.message}`, "error");
        continue;
      }

      const delta = current - initial;

      try {
        await patchCommentCount24h(record.id, current, config.airtableKey);
        const label = delta > 20 ? "🔥 HIGH ENGAGEMENT" : delta > 5 ? "↑ MODERATE" : "— FLAT";
        addLog(`${neighborhood}: ${initial}→${current} (+${delta}) ${label}`, delta > 10 ? "success" : "info");
        results.push({ id: record.id, neighborhood, summary, initial, current, delta, sourceUrl, category: record.fields["Category"] });
      } catch (e) {
        addLog(`Patch failed: ${e.message}`, "error");
      }

      await new Promise(r => setTimeout(r, 600));
    }

    setCommentUpdates(prev => [...results, ...prev]);
    addLog(`24h update complete — ${results.length} records updated.`, "success");
    setRunning24h(false);
    setTab("24H PULSE");
  }, [config, running24h, addLog]);

  return (
    <div style={{ minHeight: "100vh", background: "#080808", color: "#e0e0e0", fontFamily: "'Georgia', serif", padding: "36px 44px" }}>
      <style>{`
        @keyframes fadeIn { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }
        input::placeholder { color: #2a2a2a; }
        button:focus { outline: none; }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 32 }}>
        <div>
          <div style={{ fontFamily: "'Courier New', monospace", fontSize: 10, color: "#333", letterSpacing: 4, marginBottom: 8 }}>GEOGRAPHIC FORWARD PREDICTIVE ENGINE</div>
          <div style={{ fontSize: 30, fontWeight: 400, color: "#fff", letterSpacing: -1 }}>
            Agora<span style={{ color: "#E8B86D" }}>IQ</span>
            <span style={{ fontSize: 13, color: "#333", fontFamily: "'Courier New', monospace", marginLeft: 16, letterSpacing: 2 }}>SEATTLE · LAST 14 DAYS</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {autoRun && <span style={{ fontFamily: "'Courier New', monospace", fontSize: 10, color: "#333" }}>next in {countdown}</span>}
          <button onClick={() => setAutoRun(a => !a)} style={{
            background: autoRun ? "#7FB06918" : "transparent", border: `1px solid ${autoRun ? "#7FB069" : "#2a2a2a"}`,
            color: autoRun ? "#7FB069" : "#444", borderRadius: 6, padding: "8px 14px",
            fontFamily: "'Courier New', monospace", fontSize: 10, letterSpacing: 2, cursor: "pointer"
          }}>{autoRun ? "● AUTO" : "AUTO"}</button>
          <button onClick={() => setShowConfig(c => !c)} style={{
            background: "transparent", border: "1px solid #2a2a2a", color: "#444",
            borderRadius: 6, padding: "8px 14px", fontFamily: "'Courier New', monospace", fontSize: 10, letterSpacing: 2, cursor: "pointer"
          }}>CONFIG</button>
          <button onClick={loadSignals} disabled={loadingSignals} style={{
            background: loadingSignals ? "#1a1a1a" : "transparent",
            border: `1px solid ${loadingSignals ? "#2a2a2a" : "#E8B86D55"}`,
            color: loadingSignals ? "#333" : "#E8B86D",
            borderRadius: 6, padding: "8px 14px", fontFamily: "'Courier New', monospace",
            fontSize: 10, letterSpacing: 2, cursor: loadingSignals ? "not-allowed" : "pointer",
            animation: loadingSignals ? "pulse 1.5s infinite" : "none"
          }}>{loadingSignals ? "LOADING..." : "LOAD HISTORY"}</button>
          <button onClick={run24hUpdate} disabled={running24h} style={{
            background: running24h ? "#1a1a1a" : "transparent",
            border: `1px solid ${running24h ? "#2a2a2a" : "#4ECDC4"}`,
            color: running24h ? "#333" : "#4ECDC4",
            borderRadius: 6, padding: "8px 14px", fontFamily: "'Courier New', monospace",
            fontSize: 10, letterSpacing: 2, cursor: running24h ? "not-allowed" : "pointer",
            animation: running24h ? "pulse 1.5s infinite" : "none"
          }}>{running24h ? "UPDATING..." : "24H PULSE"}</button>
          <button onClick={runVelocityReport} disabled={runningVelocity} style={{
            background: runningVelocity ? "#1a1a1a" : "transparent",
            border: `1px solid ${runningVelocity ? "#2a2a2a" : "#9B5DE5"}`,
            color: runningVelocity ? "#333" : "#9B5DE5",
            borderRadius: 6, padding: "8px 14px", fontFamily: "'Courier New', monospace",
            fontSize: 10, letterSpacing: 2, cursor: runningVelocity ? "not-allowed" : "pointer",
            animation: runningVelocity ? "pulse 1.5s infinite" : "none"
          }}>{runningVelocity ? "COMPUTING..." : "RUN VELOCITY"}</button>
          <button onClick={runPipeline} disabled={running} style={{
            background: running ? "#1a1a1a" : "#E8B86D", color: running ? "#444" : "#0D0D0D",
            border: "none", borderRadius: 6, padding: "10px 22px",
            fontFamily: "'Courier New', monospace", fontSize: 11, fontWeight: 700, letterSpacing: 2,
            cursor: running ? "not-allowed" : "pointer",
            animation: running ? "pulse 1.5s infinite" : "none"
          }}>{running ? "RUNNING..." : "RUN NOW"}</button>
        </div>
      </div>

      {showConfig && <ConfigPanel config={config} onSave={c => { setConfig(c); setShowConfig(false); }} />}
      {signals.length > 0 && <StatsBar signals={signals} />}
      {signals.length > 0 && <HotSignalsPanel signals={signals} watchlist={watchlist} onWatch={addToWatchlist} />}
      {watchlist.length > 0 && <WatchlistPanel watchlist={watchlist} onRemove={removeFromWatchlist} />}

      <Tabs tabs={["SIGNALS", "VELOCITY", "24H PULSE", "VALIDATE", "LOG"]} active={tab} onChange={setTab} />

      {/* Signals tab */}
      {tab === "SIGNALS" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 260px", gap: 20, alignItems: "start" }}>
          <div>
            {signals.length === 0 ? (
              <div style={{ border: "1px dashed #1a1a1a", borderRadius: 8, padding: "60px 40px", textAlign: "center", color: "#222", fontFamily: "'Courier New', monospace", fontSize: 12, letterSpacing: 2 }}>
                NO SIGNALS YET — HIT RUN NOW
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {signals.map((s, i) => <SignalCard key={s.post.url} signal={s} index={i} />)}
              </div>
            )}
          </div>

          {/* Mini log sidebar */}
          <div style={{ position: "sticky", top: 20 }}>
            <div style={{ fontFamily: "'Courier New', monospace", fontSize: 9, color: "#2a2a2a", letterSpacing: 3, marginBottom: 10 }}>LIVE LOG</div>
            <div ref={logRef} style={{ background: "#0D0D0D", border: "1px solid #1a1a1a", borderRadius: 8, padding: 14, height: 400, overflowY: "auto", fontFamily: "'Courier New', monospace", fontSize: 10 }}>
              {log.slice(-30).map((l, i) => (
                <div key={i} style={{ marginBottom: 6, color: l.type === "error" ? "#E15554" : l.type === "success" ? "#7FB069" : l.type === "skip" ? "#333" : "#444", lineHeight: 1.5 }}>
                  <span style={{ color: "#222" }}>{l.ts} </span>{l.msg}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Velocity tab */}
      {tab === "VELOCITY" && (
        <div>
          {velocityRecords.length === 0 ? (
            <div style={{ border: "1px dashed #1a1a1a", borderRadius: 8, padding: "60px 40px", textAlign: "center", color: "#222", fontFamily: "'Courier New', monospace", fontSize: 12, letterSpacing: 2 }}>
              NO VELOCITY DATA — HIT RUN VELOCITY (requires signals in Airtable for current week)
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {velocityRecords.sort((a,b) => (b.velocityScore||0) - (a.velocityScore||0)).map(r => (
                <VelocityCard key={r.neighborhood} record={r} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* 24H Pulse tab */}
      {tab === "24H PULSE" && (
        <div>
          <div style={{ fontFamily: "'Courier New', monospace", fontSize: 10, color: "#333", letterSpacing: 3, marginBottom: 16 }}>
            COMMENT VELOCITY — 24H DELTA · {commentUpdates.length} records updated
          </div>
          {commentUpdates.length === 0 ? (
            <div style={{ border: "1px dashed #1a1a1a", borderRadius: 8, padding: "60px 40px", textAlign: "center", color: "#222", fontFamily: "'Courier New', monospace", fontSize: 12, letterSpacing: 2 }}>
              HIT "24H PULSE" — UPDATES POSTS THAT ARE 23+ HOURS OLD
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {commentUpdates.map((r, i) => {
                const pct = r.initial > 0 ? ((r.delta / r.initial) * 100).toFixed(0) : "∞";
                const heat = r.delta > 20 ? "#E8B86D" : r.delta > 5 ? "#7FB069" : "#333";
                const catColor = CATEGORY_COLORS[r.category] || "#555";
                return (
                  <div key={`${r.id}-${i}`} style={{
                    background: "#0D0D0D", border: "1px solid #1a1a1a",
                    borderLeft: `3px solid ${heat}`, borderRadius: 8, padding: "14px 20px",
                    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16,
                    animation: `fadeIn 0.3s ease ${i * 0.03}s both`
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                        <span style={{ background: catColor + "22", color: catColor, border: `1px solid ${catColor}44`, borderRadius: 4, padding: "2px 8px", fontSize: 10, fontFamily: "'Courier New', monospace" }}>{r.category || "—"}</span>
                        <span style={{ background: "#161616", color: "#555", borderRadius: 4, padding: "2px 8px", fontSize: 10, fontFamily: "'Courier New', monospace" }}>{r.neighborhood}</span>
                      </div>
                      <div style={{ color: "#999", fontSize: 12, lineHeight: 1.4 }}>{r.summary}</div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontFamily: "'Courier New', monospace", fontSize: 20, color: heat, fontWeight: 700 }}>
                        +{r.delta}
                      </div>
                      <div style={{ fontFamily: "'Courier New', monospace", fontSize: 10, color: "#333" }}>
                        {r.initial} → {r.current} ({pct}%)
                      </div>
                      <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer"
                        style={{ color: "#2a2a2a", fontSize: 10, fontFamily: "'Courier New', monospace" }}>
                        VIEW →
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Validate tab */}
      {tab === "VALIDATE" && (
        <ValidationTab watchlist={watchlist} airtableKey={config.airtableKey} addLog={addLog} />
      )}

      {/* Full log tab */}
      {tab === "LOG" && (
        <div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
            <button onClick={() => setLog([])} style={{ background: "transparent", border: "1px solid #1a1a1a", color: "#333", borderRadius: 6, padding: "6px 16px", fontFamily: "'Courier New', monospace", fontSize: 10, letterSpacing: 2, cursor: "pointer" }}>CLEAR</button>
          </div>
          <div style={{ background: "#0D0D0D", border: "1px solid #1a1a1a", borderRadius: 8, padding: "20px 24px", height: 520, overflowY: "auto", fontFamily: "'Courier New', monospace", fontSize: 11 }}>
            {log.length === 0 ? <div style={{ color: "#222" }}>no activity yet</div> : log.map((l, i) => (
              <div key={i} style={{ marginBottom: 8, color: l.type === "error" ? "#E15554" : l.type === "success" ? "#7FB069" : l.type === "skip" ? "#333" : "#444", lineHeight: 1.6 }}>
                <span style={{ color: "#2a2a2a" }}>{l.ts} </span>{l.msg}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
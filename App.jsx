import { useState, useEffect, useRef, useCallback } from "react";

const CATEGORIES = [
  { id: "all", label: "ALL SIGNALS", icon: "◈" },
  { id: "news", label: "NEWS", icon: "⬡" },
  { id: "stock", label: "STOCK / EARNINGS", icon: "▲" },
  { id: "fcc", label: "FCC DOCKETS", icon: "⊕" },
  { id: "legal", label: "LEGAL", icon: "⚖" },
  { id: "launch", label: "LAUNCHES", icon: "🚀" },
  { id: "satellite", label: "SATELLITES", icon: "◯" },
  { id: "people", label: "PEOPLE", icon: "◎" },
  { id: "partners", label: "PARTNERS", icon: "⬟" },
];

const CATEGORY_COLORS = {
  news: "#00d4ff",
  stock: "#00ff9d",
  fcc: "#ff9d00",
  legal: "#ff4d6d",
  launch: "#bf5af2",
  satellite: "#5af2ff",
  people: "#ffd60a",
  partners: "#ff6b35",
};

const REFRESH_INTERVAL = 5 * 60;

const SEARCH_QUERIES = [
  // News
  { query: "AST SpaceMobile breaking news latest", category: "news" },
  { query: "ASTS SpaceMobile announcement today", category: "news" },
  { query: "AST SpaceMobile press release", category: "news" },

  // Stock & Financial
  { query: "ASTS stock news today", category: "stock" },
  { query: "AST SpaceMobile SEC filing earnings", category: "stock" },
  { query: "ASTS analyst rating price target", category: "stock" },
  { query: "AST SpaceMobile investor capital raise", category: "stock" },
  { query: "ASTS short interest earnings guidance", category: "stock" },

  // Executives & Board
  { query: "Abel Avellan AST SpaceMobile", category: "people" },
  { query: "AST SpaceMobile CEO chairman board directors news", category: "people" },
  { query: "AST SpaceMobile executives management news", category: "people" },

  // Satellites & Technology
  { query: "BlueBird satellite AST SpaceMobile latest", category: "satellite" },
  { query: "AST SpaceMobile satellite orbit status update", category: "satellite" },
  { query: "AST SpaceMobile direct to cell broadband", category: "satellite" },
  { query: "AST SpaceMobile LEO satellite constellation", category: "satellite" },
  { query: "space based cellular technology AST", category: "satellite" },

  // Launches
  { query: "AST SpaceMobile BlueBird satellite launch", category: "launch" },
  { query: "AST SpaceMobile rocket launch schedule", category: "launch" },
  { query: "direct to device satellite launch latest", category: "launch" },

  // FCC & Regulatory
  { query: "AST SpaceMobile FCC docket spectrum license", category: "fcc" },
  { query: "AST SpaceMobile regulatory approval filing", category: "fcc" },
  { query: "AST SpaceMobile ITU spectrum coordination", category: "fcc" },

  // Legal
  { query: "AST SpaceMobile lawsuit court legal", category: "legal" },
  { query: "ASTS litigation patent dispute", category: "legal" },

  // Partners & Deals
  { query: "AST SpaceMobile AT&T Verizon partnership deal", category: "partners" },
  { query: "AST SpaceMobile Vodafone Rakuten agreement", category: "partners" },
  { query: "AST SpaceMobile TELUS Bell Canada carrier", category: "partners" },
  { query: "AST SpaceMobile government contract deal", category: "partners" },
  { query: "AST SpaceMobile carrier partnership latest", category: "partners" },
];

function timeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatCountdown(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function AlertCard({ alert, isNew }) {
  const color = CATEGORY_COLORS[alert.category] || "#00d4ff";
  return (
    <div style={{
      background: isNew ? "rgba(0,212,255,0.05)" : "rgba(10,12,24,0.85)",
      border: `1px solid ${isNew ? color : "rgba(255,255,255,0.06)"}`,
      borderLeft: `3px solid ${color}`,
      borderRadius: "8px",
      padding: "16px 18px",
      marginBottom: "10px",
      position: "relative",
      transition: "all 0.3s ease",
      animation: isNew ? "slideIn 0.4s ease" : "none",
    }}>
      {isNew && (
        <div style={{
          position: "absolute", top: "10px", right: "12px",
          background: color, color: "#000", fontSize: "9px",
          fontWeight: "800", padding: "2px 7px", borderRadius: "20px",
          letterSpacing: "1px", fontFamily: "monospace",
        }}>NEW</div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
        <span style={{ fontSize: "10px", fontWeight: "700", color, letterSpacing: "2px", fontFamily: "monospace", textTransform: "uppercase" }}>
          {alert.category?.toUpperCase()}
        </span>
        <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "10px" }}>•</span>
        <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)", fontFamily: "monospace" }}>
          {timeAgo(alert.timestamp)}
        </span>
      </div>
      <div style={{ fontSize: "13px", color: "rgba(255,255,255,0.9)", lineHeight: "1.6", fontFamily: "Georgia, serif" }}>
        {alert.summary}
      </div>
      {alert.source && (
        <div style={{ marginTop: "8px", fontSize: "10px", color: "rgba(255,255,255,0.25)", fontFamily: "monospace" }}>
          SRC: {alert.source}
        </div>
      )}
    </div>
  );
}

export default function ASTSMonitor() {
  const [alerts, setAlerts] = useState([]);
  const [newAlertIds, setNewAlertIds] = useState(new Set());
  const [activeCategory, setActiveCategory] = useState("all");
  const [isLoading, setIsLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [notifPermission, setNotifPermission] = useState("default");
  const [statusMsg, setStatusMsg] = useState("Initializing ASTS Signal Monitor...");
  const [scanIndex, setScanIndex] = useState(0);
  const seenSummaries = useRef(new Set());
  const countdownRef = useRef(null);

  const requestNotifications = async () => {
    if ("Notification" in window) {
      const perm = await Notification.requestPermission();
      setNotifPermission(perm);
    }
  };

  const sendBrowserNotif = (alert) => {
    if (Notification.permission === "granted") {
      new Notification(`⚡ ASTS ALERT: ${alert.category?.toUpperCase()}`, {
        body: alert.summary,
        tag: alert.id,
      });
    }
  };

  const fetchAlertsForQuery = async ({ query, category }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, category }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return await response.json();
    } catch (e) {
      clearTimeout(timeout);
      console.error("Fetch error:", category, e.message);
      return [];
    }
  };

  const runFullScan = useCallback(async () => {
    setIsLoading(true);
    const freshAlerts = [];
    for (let i = 0; i < SEARCH_QUERIES.length; i++) {
      const q = SEARCH_QUERIES[i];
      setScanIndex(i + 1);
      setStatusMsg(`Scanning ${q.category.toUpperCase()} — ${q.query}`);
      try {
        const results = await fetchAlertsForQuery(q);
        for (const alert of results) {
          if (!seenSummaries.current.has(alert.summary)) {
            seenSummaries.current.add(alert.summary);
            freshAlerts.push(alert);
          }
        }
      } catch (e) {
        console.error("Scan error:", q.category, e);
      }
    }
    if (freshAlerts.length > 0) {
      const freshIds = new Set(freshAlerts.map((a) => a.id));
      setAlerts((prev) => [...freshAlerts, ...prev].sort((a, b) => b.timestamp - a.timestamp).slice(0, 200));
      setNewAlertIds(freshIds);
      freshAlerts.forEach(sendBrowserNotif);
      setTimeout(() => setNewAlertIds(new Set()), 30000);
    }
    setLastRefresh(new Date());
    setCountdown(REFRESH_INTERVAL);
    setIsLoading(false);
    setStatusMsg(freshAlerts.length > 0
      ? `✓ ${freshAlerts.length} new signal${freshAlerts.length > 1 ? "s" : ""} detected`
      : "✓ All channels clear — no new signals");
    setScanIndex(0);
  }, []);

  useEffect(() => {
    if ("Notification" in window) setNotifPermission(Notification.permission);
    runFullScan();
  }, []);

  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) { runFullScan(); return REFRESH_INTERVAL; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(countdownRef.current);
  }, [runFullScan]);

  const filtered = alerts.filter((a) => activeCategory === "all" || a.category === activeCategory);

  return (
    <div style={{ minHeight: "100vh", background: "#04050f", color: "#fff", fontFamily: "monospace" }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes slideIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #1a1f3c; border-radius: 2px; }
      `}</style>

      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
        {Array.from({ length: 60 }).map((_, i) => (
          <div key={i} style={{
            position: "absolute",
            width: i % 5 === 0 ? "2px" : "1px", height: i % 5 === 0 ? "2px" : "1px",
            background: "rgba(255,255,255,0.5)", borderRadius: "50%",
            top: `${(i * 17.3) % 100}%`, left: `${(i * 13.7) % 100}%`,
            animation: `pulse ${2 + (i % 4)}s ease-in-out infinite`,
            animationDelay: `${(i % 4) * 0.5}s`,
          }} />
        ))}
      </div>

      <div style={{
        borderBottom: "1px solid rgba(0,212,255,0.15)",
        background: "rgba(4,5,15,0.95)",
        padding: "18px 24px",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ fontSize: "18px" }}>◉</span>
              <span style={{ fontSize: "15px", fontWeight: "800", letterSpacing: "4px", color: "#00d4ff" }}>
                ASTS SIGNAL MONITOR
              </span>
              <span style={{
                fontSize: "9px", background: "rgba(0,212,255,0.1)",
                border: "1px solid rgba(0,212,255,0.3)", color: "#00d4ff",
                padding: "2px 8px", borderRadius: "4px", letterSpacing: "1px",
              }}>AST SPACEMOBILE</span>
            </div>
            <div style={{ marginTop: "4px", fontSize: "10px", color: isLoading ? "#00d4ff" : "rgba(255,255,255,0.3)", letterSpacing: "1px", maxWidth: "600px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {isLoading ? `[${scanIndex}/${SEARCH_QUERIES.length}] ${statusMsg}` : statusMsg}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
            {notifPermission !== "granted" ? (
              <button onClick={requestNotifications} style={{
                background: "rgba(0,212,255,0.08)", border: "1px solid rgba(0,212,255,0.4)",
                color: "#00d4ff", padding: "7px 14px", borderRadius: "6px",
                fontSize: "10px", cursor: "pointer", letterSpacing: "1px", fontFamily: "monospace",
              }}>🔔 ENABLE ALERTS</button>
            ) : (
              <span style={{ fontSize: "10px", color: "#00ff9d", letterSpacing: "1px" }}>🔔 ALERTS ACTIVE</span>
            )}
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: "18px", fontWeight: "800", color: countdown < 60 ? "#ff4d6d" : "rgba(255,255,255,0.5)", letterSpacing: "2px" }}>
                {formatCountdown(countdown)}
              </div>
              <div style={{ fontSize: "9px", color: "rgba(255,255,255,0.2)", letterSpacing: "1px" }}>NEXT SCAN</div>
            </div>
            <button onClick={runFullScan} disabled={isLoading} style={{
              background: isLoading ? "rgba(0,212,255,0.04)" : "rgba(0,212,255,0.12)",
              border: "1px solid rgba(0,212,255,0.4)", color: "#00d4ff",
              padding: "10px 18px", borderRadius: "6px", fontSize: "11px",
              cursor: isLoading ? "not-allowed" : "pointer", letterSpacing: "2px",
              fontFamily: "monospace", fontWeight: "700", display: "flex", alignItems: "center", gap: "6px",
            }}>
              <span style={isLoading ? { display: "inline-block", animation: "spin 1s linear infinite" } : {}}>⟳</span>
              {isLoading ? "SCANNING" : "SCAN NOW"}
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: "6px", marginTop: "14px", flexWrap: "wrap" }}>
          {CATEGORIES.map((cat) => {
            const count = cat.id === "all" ? alerts.length : alerts.filter((a) => a.category === cat.id).length;
            const isActive = activeCategory === cat.id;
            const color = CATEGORY_COLORS[cat.id] || "#00d4ff";
            return (
              <button key={cat.id} onClick={() => setActiveCategory(cat.id)} style={{
                background: isActive ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.02)",
                border: isActive ? `1px solid ${cat.id === "all" ? "#00d4ff" : color}` : "1px solid rgba(255,255,255,0.07)",
                color: isActive ? (cat.id === "all" ? "#00d4ff" : color) : "rgba(255,255,255,0.35)",
                padding: "5px 12px", borderRadius: "4px", fontSize: "9px",
                cursor: "pointer", letterSpacing: "1.5px", fontFamily: "monospace",
                fontWeight: "700", display: "flex", alignItems: "center", gap: "5px", transition: "all 0.15s",
              }}>
                <span>{cat.icon}</span>{cat.label}
                <span style={{ background: "rgba(255,255,255,0.08)", padding: "0 5px", borderRadius: "10px", fontSize: "9px" }}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ padding: "20px 24px", maxWidth: "860px", margin: "0 auto" }}>
        {isLoading && alerts.length === 0 && (
          <div style={{ textAlign: "center", padding: "80px 0", color: "rgba(255,255,255,0.2)" }}>
            <div style={{ fontSize: "48px", animation: "spin 2s linear infinite", display: "inline-block", marginBottom: "20px" }}>◌</div>
            <div style={{ fontSize: "12px", letterSpacing: "3px", color: "#00d4ff" }}>SCANNING ALL CHANNELS</div>
            <div style={{ fontSize: "10px", marginTop: "8px" }}>News · FCC · SEC · Legal · Launches · Satellites · People · Partners</div>
          </div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div style={{ textAlign: "center", padding: "80px 0", color: "rgba(255,255,255,0.15)" }}>
            <div style={{ fontSize: "36px", marginBottom: "16px" }}>◯</div>
            <div style={{ fontSize: "11px", letterSpacing: "2px" }}>NO SIGNALS DETECTED</div>
            <div style={{ fontSize: "10px", marginTop: "8px" }}>
              {lastRefresh ? `Last scan: ${lastRefresh.toLocaleTimeString()}` : "Run a scan to begin monitoring"}
            </div>
          </div>
        )}
        {filtered.map((alert) => (
          <AlertCard key={alert.id} alert={alert} isNew={newAlertIds.has(alert.id)} />
        ))}
        {lastRefresh && filtered.length > 0 && (
          <div style={{ textAlign: "center", padding: "20px 0", fontSize: "10px", color: "rgba(255,255,255,0.12)", letterSpacing: "1px" }}>
            LAST SCAN: {lastRefresh.toLocaleString()} · {alerts.length} TOTAL SIGNALS · NEXT SCAN IN {formatCountdown(countdown)}
          </div>
        )}
      </div>
    </div>
  );
}

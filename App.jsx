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

// The frontend never calls Anthropic itself — a Vercel cron writes to
// KV every 30 minutes, /api/alerts reads from KV, the dashboard polls
// /api/alerts every 60 seconds. Fixed cost regardless of audience size.
const POLL_INTERVAL = 60;

function timeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 0) return "just now";
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
  const [lastRun, setLastRun] = useState(null); // server-side cron timestamp
  const [lastFetch, setLastFetch] = useState(null); // client-side poll timestamp
  const [countdown, setCountdown] = useState(POLL_INTERVAL);
  const [notifPermission, setNotifPermission] = useState("default");
  const [statusMsg, setStatusMsg] = useState("Connecting to signal cache...");
  const [stale, setStale] = useState(false);
  const seenIds = useRef(new Set());
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

  const pollAlerts = useCallback(async (isFirstLoad = false) => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/alerts", {
        headers: { Accept: "application/json" },
      });
      const body = await response.json();
      if (!response.ok || body?.error) {
        console.error("Poll error:", response.status, body?.error || body);
        setStatusMsg(`✗ ${body?.error || "Cache read failed"} (${response.status})`);
        setIsLoading(false);
        setLastFetch(new Date());
        setCountdown(POLL_INTERVAL);
        return;
      }

      const cachedAlerts = Array.isArray(body.alerts) ? body.alerts : [];
      // Coerce timestamp strings → Date for the AlertCard's timeAgo helper.
      const hydrated = cachedAlerts.map((a) => ({
        ...a,
        timestamp: a.timestamp ? new Date(a.timestamp) : new Date(),
      }));

      // Identify newly-arrived alerts since last poll. Skip on the very
      // first load — we don't want every cached row badged "NEW".
      const incomingIds = new Set(hydrated.map((a) => a.id));
      const freshlyNewIds = isFirstLoad
        ? new Set()
        : new Set(hydrated.filter((a) => !seenIds.current.has(a.id)).map((a) => a.id));
      seenIds.current = incomingIds;

      setAlerts(hydrated);
      if (freshlyNewIds.size > 0) {
        setNewAlertIds(freshlyNewIds);
        // Browser notification for each genuinely new row.
        for (const a of hydrated) {
          if (freshlyNewIds.has(a.id)) sendBrowserNotif(a);
        }
        setTimeout(() => setNewAlertIds(new Set()), 30000);
      }

      setLastRun(body.lastRun ? new Date(body.lastRun) : null);
      setLastFetch(new Date());
      setStale(Boolean(body.stale));

      if (body.empty) {
        setStatusMsg("⌛ Cache empty — waiting for first cron run");
      } else if (body.stale) {
        setStatusMsg("⚠ Cache is stale — last update >75 minutes ago");
      } else {
        const newCount = freshlyNewIds.size;
        setStatusMsg(
          newCount > 0
            ? `✓ ${newCount} new signal${newCount > 1 ? "s" : ""} since last refresh`
            : `✓ ${hydrated.length} signal${hydrated.length === 1 ? "" : "s"} cached`
        );
      }
    } catch (e) {
      console.error("Poll failed:", e.message);
      setStatusMsg(`✗ Network error — ${e.message}`);
      setLastFetch(new Date());
    } finally {
      setIsLoading(false);
      setCountdown(POLL_INTERVAL);
    }
  }, []);

  useEffect(() => {
    if ("Notification" in window) setNotifPermission(Notification.permission);
    pollAlerts(true);
  }, [pollAlerts]);

  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) { pollAlerts(false); return POLL_INTERVAL; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(countdownRef.current);
  }, [pollAlerts]);

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
              {stale && (
                <span style={{
                  fontSize: "9px", background: "rgba(255,77,109,0.1)",
                  border: "1px solid rgba(255,77,109,0.5)", color: "#ff4d6d",
                  padding: "2px 8px", borderRadius: "4px", letterSpacing: "1px",
                }}>CACHE STALE</span>
              )}
            </div>
            <div style={{ marginTop: "4px", fontSize: "10px", color: isLoading ? "#00d4ff" : "rgba(255,255,255,0.3)", letterSpacing: "1px", maxWidth: "640px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {statusMsg}
              {lastRun && (
                <span style={{ marginLeft: "12px", color: "rgba(255,255,255,0.25)" }}>
                  · cache built {timeAgo(lastRun)}
                </span>
              )}
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
              <div style={{ fontSize: "18px", fontWeight: "800", color: countdown < 10 ? "#ff4d6d" : "rgba(255,255,255,0.5)", letterSpacing: "2px" }}>
                {formatCountdown(countdown)}
              </div>
              <div style={{ fontSize: "9px", color: "rgba(255,255,255,0.2)", letterSpacing: "1px" }}>NEXT POLL</div>
            </div>
            <button onClick={() => pollAlerts(false)} disabled={isLoading} style={{
              background: isLoading ? "rgba(0,212,255,0.04)" : "rgba(0,212,255,0.12)",
              border: "1px solid rgba(0,212,255,0.4)", color: "#00d4ff",
              padding: "10px 18px", borderRadius: "6px", fontSize: "11px",
              cursor: isLoading ? "not-allowed" : "pointer", letterSpacing: "2px",
              fontFamily: "monospace", fontWeight: "700", display: "flex", alignItems: "center", gap: "6px",
            }}>
              <span style={isLoading ? { display: "inline-block", animation: "spin 1s linear infinite" } : {}}>⟳</span>
              {isLoading ? "REFRESHING" : "REFRESH"}
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
            <div style={{ fontSize: "12px", letterSpacing: "3px", color: "#00d4ff" }}>READING SIGNAL CACHE</div>
            <div style={{ fontSize: "10px", marginTop: "8px" }}>Updated server-side every 30 minutes</div>
          </div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div style={{ textAlign: "center", padding: "80px 0", color: "rgba(255,255,255,0.15)" }}>
            <div style={{ fontSize: "36px", marginBottom: "16px" }}>◯</div>
            <div style={{ fontSize: "11px", letterSpacing: "2px" }}>NO SIGNALS DETECTED</div>
            <div style={{ fontSize: "10px", marginTop: "8px" }}>
              {lastFetch ? `Last poll: ${lastFetch.toLocaleTimeString()}` : "Connecting..."}
            </div>
          </div>
        )}
        {filtered.map((alert) => (
          <AlertCard key={alert.id} alert={alert} isNew={newAlertIds.has(alert.id)} />
        ))}
        {lastRun && filtered.length > 0 && (
          <div style={{ textAlign: "center", padding: "20px 0", fontSize: "10px", color: "rgba(255,255,255,0.12)", letterSpacing: "1px" }}>
            CACHE BUILT {lastRun.toLocaleString()} · {alerts.length} TOTAL SIGNALS · NEXT POLL IN {formatCountdown(countdown)}
          </div>
        )}
      </div>
    </div>
  );
}

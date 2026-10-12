import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { api, API_BASE_URL } from "../api";
import type { Health } from "../types";

/** Sidebar structure. `runScoped` links keep the selected run when followed. */
const NAV: { section: string; runScoped?: boolean; items: { to: string; label: string; end?: boolean }[] }[] = [
  {
    section: "Overview",
    items: [
      { to: "/", label: "Dashboard", end: true },
      { to: "/analyze", label: "New Analysis" },
      { to: "/runs", label: "Run History", end: true },
    ],
  },
  {
    section: "Run Analysis",
    runScoped: true,
    items: [
      { to: "/trace", label: "Agent Trace" },
      { to: "/feedback-loop", label: "Feedback Loop" },
      { to: "/coverage", label: "Coverage Matrix" },
      { to: "/gaps", label: "Gaps & Validation" },
      { to: "/remediation", label: "Remediation Plan" },
      { to: "/report", label: "Final Report" },
    ],
  },
  {
    section: "Knowledge",
    items: [
      { to: "/regulations", label: "Regulations" },
      { to: "/controls", label: "Control Library" },
    ],
  },
  {
    section: "System",
    items: [
      { to: "/architecture", label: "Architecture" },
      { to: "/n8n-workflow", label: "n8n Workflow" },
      { to: "/settings", label: "Settings & Health" },
    ],
  },
];

/** Polls /api/health every 15 seconds, so a stopped backend is noticed quickly. */
function ApiStatus() {
  const [health, setHealth] = useState<Health | null>(null);
  const [down, setDown] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = () =>
      api.health()
        .then((h) => { if (alive) { setHealth(h); setDown(false); } })
        .catch(() => { if (alive) setDown(true); });
    check();
    const id = window.setInterval(check, 15000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);
  return (
    <div className={`api-status ${down ? "down" : health ? "up" : ""}`} title={API_BASE_URL}>
      <span className="dot" aria-hidden />
      {down ? "API unreachable" : health ? `API online - ${health.llm_provider} LLM` : "Checking API..."}
    </div>
  );
}

/** Light/dark switch; public/theme-init.js restores the choice before first paint. */
function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    return (localStorage.getItem("regradar-theme") as "light" | "dark") || "light";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("regradar-theme", theme);
  }, [theme]);

  return (
    <div className="theme-toggle-wrap">
      <button
        type="button"
        className="theme-toggle-btn"
        onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
        title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
      >
        <span>{theme === "light" ? "☀️ Light Mode" : "🌙 Dark Mode"}</span>
      </button>
    </div>
  );
}

/** App shell: sidebar navigation, mobile top bar and the routed page. */
export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  // keep the selected run when moving between run pages (?run= or /runs/:id/...)
  const runParam = new URLSearchParams(location.search).get("run")
    ?? /^\/runs\/([^/]+)/.exec(location.pathname)?.[1] ?? null;

  return (
    <div className="shell">
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <div className="brand">
          <img src="/favicon.svg" alt="" width={30} height={30} />
          <div>
            <div className="brand-name">RegRadar</div>
            <div className="brand-sub">Regulatory change radar</div>
          </div>
        </div>
        <nav aria-label="Main">
          {NAV.map((group) => (
            <div key={group.section} className="nav-group">
              <div className="nav-section">{group.section}</div>
              {group.items.map((item) => (
                <NavLink key={item.to} to={group.runScoped && runParam ? `${item.to}?run=${encodeURIComponent(runParam)}` : item.to}
                  end={item.end}
                  className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <ThemeToggle />
        <ApiStatus />
      </aside>
      <div className="main">
        <div className="topbar">
          <button className="menu-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="Toggle navigation">
            <span /><span /><span />
          </button>
          <span className="topbar-title">RegRadar</span>
        </div>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

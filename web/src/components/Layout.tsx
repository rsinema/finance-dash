import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { api } from "../lib/api";
import webPkg from "../../package.json";

const links = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/transactions", label: "Transactions" },
  { to: "/review", label: "Review" },
  { to: "/ask", label: "Ask" },
  { to: "/settings", label: "Settings" },
];

const webVersion = (webPkg as { version: string }).version;

export function Layout() {
  const [serverVersion, setServerVersion] = useState<string | null>(null);

  useEffect(() => {
    api
      .version()
      .then((v) => setServerVersion(v.version))
      .catch(() => setServerVersion(null));
  }, []);

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 shrink-0 border-r border-border bg-panel/50 px-4 py-6 flex flex-col">
        <div className="text-lg font-semibold mb-6">Finance</div>
        <nav className="flex flex-col gap-1">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded-md text-sm transition-colors ${
                  isActive
                    ? "bg-accent/15 text-accent"
                    : "text-text/80 hover:bg-panel hover:text-text"
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto pt-6 text-[11px] text-muted font-mono">
          web {webVersion} · server {serverVersion ?? "—"}
        </div>
      </aside>
      <main className="flex-1 px-8 py-6 overflow-x-hidden">
        <Outlet />
      </main>
    </div>
  );
}

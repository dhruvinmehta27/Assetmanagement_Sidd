"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * The application bar: identity, navigation, and the theme control.
 *
 * The nav used to be copy-pasted into all six pages, which meant every new page
 * was seven edits and one of them was always missed. It is defined once here,
 * and adding a page is one line in LINKS.
 */

/**
 * Nine entries is as many as fit. The labels were longer — "Folder Import",
 * "Corporate Actions" — until the ninth page pushed the active one off the
 * right-hand edge at 1280px, which is the width this runs at.
 */
const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/upload", label: "Upload" },
  { href: "/import", label: "Import" },
  { href: "/accounts", label: "Accounts" },
  { href: "/reconcile", label: "Reconcile" },
  { href: "/corporate-actions", label: "Actions" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/pnl", label: "P&L" },
  { href: "/master", label: "Master" },
];

type Choice = "light" | "dark" | "system";

export default function AppBar() {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement | null>(null);

  // On a narrow window the bar scrolls, and the page you are on can start out
  // off-screen — which reads as the nav having lost it.
  useEffect(() => {
    const active = navRef.current?.querySelector(".nav-active");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return (
    <header className="appbar">
      <div className="appbar-inner">
        <a className="brand" href="/">
          <span className="brand-dot" />
          Asset Manager
        </a>
        <nav className="nav" ref={navRef}>
          {LINKS.map((l) =>
            l.href === pathname ? (
              <span key={l.href} className="nav-active">
                {l.label}
              </span>
            ) : (
              <a key={l.href} href={l.href}>
                {l.label}
              </a>
            )
          )}
        </nav>
        <div className="appbar-right">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

/**
 * Light / dark / system.
 *
 * "System" is the default and is a real third state, not a synonym for one of
 * the other two: with it selected the app follows the Mac's appearance as it
 * changes, which is what most people expect and what the CSS is written for.
 * Choosing light or dark stamps `data-theme` on the root, which the stylesheet
 * gives precedence over the media query in both directions.
 */
function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>("system");

  // The stored choice is read and applied by an inline script before first
  // paint (see layout.tsx) — this only syncs the control to what that did.
  useEffect(() => {
    const stored = document.documentElement.dataset.theme as Choice | undefined;
    setChoice(stored === "light" || stored === "dark" ? stored : "system");
    document.body.classList.remove("preload");
  }, []);

  function pick(next: Choice) {
    setChoice(next);
    if (next === "system") {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem("theme");
    } else {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("theme", next);
    }
  }

  const options: { key: Choice; glyph: string; title: string }[] = [
    { key: "light", glyph: "☀", title: "Light" },
    { key: "dark", glyph: "☾", title: "Dark" },
    { key: "system", glyph: "◐", title: "Match the system" },
  ];

  return (
    <div className="themetoggle" role="group" aria-label="Colour theme">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          title={o.title}
          aria-label={o.title}
          aria-pressed={choice === o.key}
          onClick={() => pick(o.key)}
        >
          {o.glyph}
        </button>
      ))}
    </div>
  );
}

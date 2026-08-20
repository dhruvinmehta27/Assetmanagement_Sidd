import type { Metadata } from "next";
import "./globals.css";
import AppBar from "./components/AppBar";

export const metadata: Metadata = {
  title: "Stock Asset Management — Contract Note Extractor",
  description:
    "Upload a broker contract note PDF and extract structured trade data.",
};

/**
 * Applies the saved theme before the browser paints anything.
 *
 * Without this the page renders in the system theme first and then snaps to the
 * chosen one a frame later — a white flash on every navigation for anyone who
 * picked dark. It has to be inline and synchronous in the head for that reason,
 * and it must not throw: private-mode Safari denies localStorage outright.
 *
 * `preload` on the body suppresses the colour transition for that first paint,
 * and the toggle removes it once mounted.
 */
const THEME_SCRIPT = `
try {
  var t = localStorage.getItem("theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
`.trim();

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="preload">
        <AppBar />
        {children}
      </body>
    </html>
  );
}

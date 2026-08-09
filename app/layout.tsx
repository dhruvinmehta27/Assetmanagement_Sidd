import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stock Asset Management — Contract Note Extractor",
  description:
    "Upload a broker contract note PDF and extract structured trade data.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

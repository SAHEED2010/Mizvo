import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mizvo",
  description: "Business clarity. Financial growth.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Workflow Automation Platform",
  description: "Define, execute, and inspect controlled agentic workflows",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      {/* Extensions such as Grammarly add attributes to <body> before React hydrates,
          which reads as a mismatch. Suppressed one level deep only, not app-wide. */}
      <body
        className="bg-slate-50 text-slate-900 antialiased"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}

import type { ReactNode } from "react";
import { APP_NAME } from "@/lib/brand";

/** Server-rendered page container + footer for public pages. */
export function PageFrame({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main style={{ maxWidth: wide ? 1080 : 760, margin: "0 auto", padding: "clamp(16px, 4vw, 48px) 16px 32px" }}>
      {children}
      <footer className="mf-muted" style={{ textAlign: "center", fontSize: 12.5, marginTop: 22 }}>Powered by {APP_NAME}</footer>
    </main>
  );
}

export function FlowSkeleton() {
  return (
    <div className="mf-card" style={{ padding: 28, display: "grid", gap: 14 }} aria-busy="true" aria-label="Loading">
      <div className="mf-skel" style={{ height: 24, width: "40%" }} />
      <div className="mf-skel" style={{ height: 16, width: "25%" }} />
      <div className="mf-skel" style={{ height: 280 }} />
    </div>
  );
}

export function Unavailable({ title, message, href }: { title: string; message: string; href?: string }) {
  return (
    <div className="mf-card" role="alert" style={{ padding: "48px 24px", textAlign: "center", display: "grid", gap: 10, justifyItems: "center" }}>
      <div style={{ fontSize: 44, fontWeight: 800, color: "var(--mf-brand)", lineHeight: 1 }}>404</div>
      <h1 style={{ margin: 0, fontSize: 22 }}>{title}</h1>
      <p className="mf-muted" style={{ margin: 0, maxWidth: 420 }}>{message}</p>
      {href && <a className="mf-btn" href={href} style={{ marginTop: 8 }}>Go back</a>}
    </div>
  );
}

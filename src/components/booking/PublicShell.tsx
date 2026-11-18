"use client";

import type { CSSProperties, ReactNode } from "react";
import { Moon, Sun } from "lucide-react";
import "./booking.css";
import { readableOn } from "./format";
import { themeStore, useSystemDark } from "./client-env";

type Theme = "light" | "dark" | undefined;

/** Wraps every public page: brand color vars, dark/light theme (system default, user toggle), embed mode. */
export function PublicShell({
  brandColor, embed, forcedTheme, children, className = "",
}: { brandColor?: string | null; embed?: boolean; forcedTheme?: Theme; children: ReactNode; className?: string }) {
  const stored = themeStore.use();
  const sysDark = useSystemDark();
  const theme: Theme = forcedTheme ?? (stored === "light" || stored === "dark" ? stored : undefined);
  const isDark = (theme ?? (sysDark ? "dark" : "light")) === "dark";

  const style = brandColor
    ? ({ "--mf-brand": brandColor, "--mf-brand-fg": readableOn(brandColor) } as CSSProperties)
    : undefined;

  return (
    <div className={`mf-pub ${embed ? "mf-embed" : ""} ${className}`} data-theme={theme} style={style}>
      {!embed && !forcedTheme && (
        <button
          type="button" onClick={() => themeStore.set(isDark ? "light" : "dark")} aria-label="Toggle dark mode"
          className="mf-btn mf-btn-ghost" style={{ position: "fixed", top: 14, right: 14, width: 40, height: 40, padding: 0, zIndex: 20, background: "var(--mf-surface)" }}
        >
          {isDark ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
        </button>
      )}
      {children}
    </div>
  );
}

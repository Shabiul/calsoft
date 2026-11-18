"use client";

import { useEffect } from "react";

/** Reports document height to the parent widget (only a number + marker; no booking data). */
export function EmbedResizer() {
  useEffect(() => {
    if (window.parent === window) return;
    const send = () => {
      const h = Math.ceil(document.documentElement.scrollHeight);
      window.parent.postMessage({ source: "meetflow", type: "resize", height: h }, "*");
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(document.body);
    window.addEventListener("load", send);
    return () => { ro.disconnect(); window.removeEventListener("load", send); };
  }, []);
  return null;
}

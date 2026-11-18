/*!
 * MeetFlow embed widget (dependency-free).
 *
 * Inline:       <div data-meetflow-inline data-url="https://HOST/username/event" data-theme="dark" data-color="4f46e5"></div>
 * Popup text:   <a href="#" data-meetflow-popup data-url="https://HOST/username/event">Book a call</a>
 * Popup widget: <script>MeetFlow.initPopupWidget({ url: "https://HOST/username/event", text: "Schedule time", color: "#4f46e5" })</script>
 * JS API:       MeetFlow.initInline({ url, el|selector, theme, color }), MeetFlow.initPopupText({ url, el, text }),
 *               MeetFlow.openPopup({ url, theme, color }), MeetFlow.closePopup()
 * Events (on window): "meetflow:booked" (detail: { eventSlug, startsAt })
 *
 * Security: the iframe only ever posts { source:"meetflow", type: "resize"|"booked"|"redirect" } with no personal data.
 * Messages are accepted only from the iframe's own window + origin.
 */
(function () {
  "use strict";
  if (window.MeetFlow && window.MeetFlow.__loaded) return;

  var script = document.currentScript;
  var scriptOrigin = "";
  try { scriptOrigin = new URL(script && script.src ? script.src : location.href, location.href).origin; } catch (e) { scriptOrigin = location.origin; }

  var frames = []; // { iframe, origin, popup }

  function embedUrl(raw, opts) {
    var u;
    try { u = new URL(raw, scriptOrigin + "/"); } catch (e) { return null; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    var parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts[0] === "embed") parts.shift();
    if (parts.length !== 2 || !/^[A-Za-z0-9._-]+$/.test(parts[0]) || !/^[A-Za-z0-9._-]+$/.test(parts[1])) return null;
    var out = new URL(u.origin + "/embed/" + parts[0] + "/" + parts[1]);
    var theme = (opts && opts.theme) || u.searchParams.get("theme");
    var color = (opts && opts.color) || u.searchParams.get("color");
    if (theme === "dark" || theme === "light") out.searchParams.set("theme", theme);
    if (color && /^#?[0-9a-fA-F]{6}$/.test(color)) out.searchParams.set("color", color.replace("#", ""));
    return out;
  }

  function makeIframe(url) {
    var f = document.createElement("iframe");
    f.src = url.toString();
    f.title = "Schedule a meeting";
    f.loading = "lazy";
    f.setAttribute("allow", "payment");
    f.style.cssText = "width:100%;border:0;display:block;min-height:560px;background:transparent;color-scheme:normal;";
    return f;
  }

  function register(iframe, url, popup) {
    frames.push({ iframe: iframe, origin: url.origin, popup: !!popup });
  }

  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || d.source !== "meetflow" || typeof d.type !== "string") return;
    var rec = null;
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].iframe.contentWindow === ev.source && frames[i].origin === ev.origin) { rec = frames[i]; break; }
    }
    if (!rec) return;
    if (d.type === "resize" && typeof d.height === "number" && isFinite(d.height)) {
      var h = Math.max(320, Math.min(Math.ceil(d.height), 4000));
      rec.iframe.style.height = h + "px";
    } else if (d.type === "booked") {
      try {
        window.dispatchEvent(new CustomEvent("meetflow:booked", { detail: { eventSlug: String(d.eventSlug || ""), startsAt: String(d.startsAt || "") } }));
      } catch (e) { /* old browsers */ }
    } else if (d.type === "redirect" && typeof d.url === "string") {
      try {
        var r = new URL(d.url);
        if (r.protocol === "https:" || r.protocol === "http:") window.location.assign(r.toString());
      } catch (e) { /* ignore */ }
    }
  });

  function resolveEl(o) {
    if (o.el && o.el.nodeType === 1) return o.el;
    if (o.selector) return document.querySelector(o.selector);
    return null;
  }

  function initInline(o) {
    var el = resolveEl(o || {});
    var url = embedUrl(o && o.url, o);
    if (!el || !url) return null;
    if (el.getAttribute("data-meetflow-ready")) return null;
    el.setAttribute("data-meetflow-ready", "1");
    var f = makeIframe(url);
    el.appendChild(f);
    register(f, url, false);
    return f;
  }

  // ───────── popup modal
  var modal = null, lastFocus = null, popupRec = null;
  function openPopup(o) {
    var url = embedUrl(o && o.url, o);
    if (!url) return;
    closePopup();
    lastFocus = document.activeElement;
    modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Schedule a meeting");
    modal.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:rgba(10,12,20,.6);display:flex;align-items:center;justify-content:center;padding:16px;";
    var box = document.createElement("div");
    box.style.cssText = "position:relative;width:min(1040px,100%);max-height:calc(100vh - 32px);overflow:auto;border-radius:16px;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.4);";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", "Close");
    btn.textContent = "×";
    btn.style.cssText = "position:absolute;top:8px;right:10px;z-index:2;width:36px;height:36px;border-radius:50%;border:0;background:rgba(0,0,0,.55);color:#fff;font-size:22px;line-height:1;cursor:pointer;";
    btn.addEventListener("click", closePopup);
    var f = makeIframe(url);
    f.style.minHeight = "600px";
    box.appendChild(btn);
    box.appendChild(f);
    modal.appendChild(box);
    modal.addEventListener("mousedown", function (e) { if (e.target === modal) closePopup(); });
    document.body.appendChild(modal);
    document.documentElement.style.overflow = "hidden";
    register(f, url, true);
    popupRec = frames[frames.length - 1];
    btn.focus();
  }
  function closePopup() {
    if (!modal) return;
    if (popupRec) { var i = frames.indexOf(popupRec); if (i >= 0) frames.splice(i, 1); popupRec = null; }
    modal.remove(); modal = null;
    document.documentElement.style.overflow = "";
    if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) { /* ignore */ }
  }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePopup(); });

  function initPopupText(o) {
    o = o || {};
    var el = resolveEl(o);
    if (!el) {
      el = document.createElement("a");
      el.href = "#";
      el.textContent = o.text || "Schedule a meeting";
      var s = document.currentScript || script;
      if (s && s.parentNode) s.parentNode.insertBefore(el, s.nextSibling); else document.body.appendChild(el);
    }
    if (el.getAttribute("data-meetflow-ready")) return el;
    el.setAttribute("data-meetflow-ready", "1");
    el.addEventListener("click", function (e) { e.preventDefault(); openPopup(o); });
    return el;
  }

  function initPopupWidget(o) {
    o = o || {};
    if (!embedUrl(o.url, o)) return null;
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = o.text || "Schedule time with me";
    var bg = /^#?[0-9a-fA-F]{6}$/.test(o.color || "") ? "#" + String(o.color).replace("#", "") : "#4f46e5";
    var pos = o.position === "left" ? "left:20px;" : "right:20px;";
    b.style.cssText = "position:fixed;bottom:20px;" + pos + "z-index:2147483645;padding:13px 20px;border:0;border-radius:999px;font:600 15px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#fff;background:" + bg + ";box-shadow:0 8px 24px rgba(0,0,0,.28);cursor:pointer;";
    b.addEventListener("click", function () { openPopup(o); });
    document.body.appendChild(b);
    return b;
  }

  function autoInit() {
    var i, nodes;
    nodes = document.querySelectorAll("[data-meetflow-inline]");
    for (i = 0; i < nodes.length; i++) initInline({ el: nodes[i], url: nodes[i].getAttribute("data-url"), theme: nodes[i].getAttribute("data-theme"), color: nodes[i].getAttribute("data-color") });
    nodes = document.querySelectorAll("[data-meetflow-popup]");
    for (i = 0; i < nodes.length; i++) initPopupText({ el: nodes[i], url: nodes[i].getAttribute("data-url"), theme: nodes[i].getAttribute("data-theme"), color: nodes[i].getAttribute("data-color") });
    nodes = document.querySelectorAll("[data-meetflow-widget]");
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute("data-meetflow-ready")) continue;
      nodes[i].setAttribute("data-meetflow-ready", "1");
      initPopupWidget({ url: nodes[i].getAttribute("data-url"), text: nodes[i].getAttribute("data-text"), color: nodes[i].getAttribute("data-color"), theme: nodes[i].getAttribute("data-theme"), position: nodes[i].getAttribute("data-position") });
    }
  }

  window.MeetFlow = { __loaded: true, initInline: initInline, initPopupText: initPopupText, initPopupWidget: initPopupWidget, openPopup: openPopup, closePopup: closePopup, scan: autoInit };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoInit); else autoInit();
})();

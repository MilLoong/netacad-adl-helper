"use strict";

/** 从各 frame 的 Resource Timing 补抓 ADL URL（不依赖 webRequest 是否进 SW）。 */

(function adlPerfBridge() {
  if (!chrome?.runtime?.id) return;

  function isNetacadLikeHost(hostname) {
    const h = String(hostname || "").toLowerCase();
    return h.endsWith("netacad.com") || h === "netacad.com" || h.endsWith("cisco.com") || h === "cisco.com";
  }

  let lastSig = "";

  function collect() {
    const out = [];
    const seen = new Set();
    try {
      const entries =
        typeof performance?.getEntriesByType === "function"
          ? performance.getEntriesByType("resource")
          : [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const n = entries[i].name;
        if (typeof n !== "string" || n.indexOf("/adl/data/") < 0) continue;
        if (!/\/(?:activities\/state|activity\/state)(?:[?#]|$)/i.test(n)) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        try {
          const u = new URL(n);
          if (!isNetacadLikeHost(u.hostname)) continue;
          out.push(u.href);
        } catch (_) {}
        if (out.length >= 16) break;
      }
    } catch (_) {}
    return out;
  }

  function tick() {
    const urls = collect();
    if (!urls.length) return;
    const sig = urls.join("\u0001");
    if (sig === lastSig) return;
    lastSig = sig;
    void chrome.runtime.sendMessage({ type: "MERGE_CAPTURE_URLS", urls }).catch(() => {});
  }

  tick();
  setInterval(tick, 2500);
})();

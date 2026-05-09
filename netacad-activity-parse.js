"use strict";

/** activityId 解析 */

function decodeNetacadMaybeRepeated(encoded, maxPasses) {
  let t = String(encoded || "").trim();
  const passes =
    typeof maxPasses === "number" ? Math.min(12, Math.max(1, maxPasses)) : 6;
  for (let i = 0; i < passes && t.length > 0; i++) {
    let next = t;
    try {
      next = decodeURIComponent(t);
    } catch {
      break;
    }
    next = next.replace(/\+/g, " ");
    if (next === t) break;
    t = next;
  }
  return t;
}

function normalizeNetacadModuleDigits(chunk) {
  const n = Number.parseInt(String(chunk || "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? String(n) : "";
}

function extractCiscoCourseSlugLeading(sDecoded) {
  let h = /^https?:\/\/cisco_([a-z0-9_-]+)_/i.exec(sDecoded);
  if (!h) h = /^cisco_([a-z0-9_-]+)_/i.exec(sDecoded);
  return h ? h[1] : "";
}

function parseActivityIdHints(activityId) {
  const out = { courseSlug: "", moduleId: "" };
  if (!activityId || typeof activityId !== "string") return out;

  const s = decodeNetacadMaybeRepeated(activityId.trim());

  const modLoose = /_mod(\d+)/i.exec(s);
  if (modLoose) {
    const mid = normalizeNetacadModuleDigits(modLoose[1]);
    if (mid) out.moduleId = mid;
    const slug = extractCiscoCourseSlugLeading(s);
    if (slug) out.courseSlug = slug;
    return out;
  }

  const cm = /\/courses\/content\/m(\d{1,4})(?:\/|$)/i.exec(s);
  if (cm) {
    out.moduleId = normalizeNetacadModuleDigits(cm[1]);
  }

  const modAlt = /\b(?:module|mod)[._-](\d{1,4})\b/i.exec(s);
  if (modAlt && !out.moduleId) {
    out.moduleId = normalizeNetacadModuleDigits(modAlt[1]);
  }

  let m = /^https?:\/\/cisco_([a-z0-9_-]+)_([a-z0-9_-]+)/i.exec(s);
  if (!m) m = /^cisco_([a-z0-9_-]+)_([a-z0-9_-]+)/i.exec(s);
  if (m) {
    const tail = m[2];
    const tailMod = /^mod(\d+)$/i.exec(tail || "");
    if (tailMod && !out.moduleId) {
      const mid = normalizeNetacadModuleDigits(tailMod[1]);
      if (mid) out.moduleId = mid;
    }
    if (!out.courseSlug) out.courseSlug = m[1];
    return out;
  }

  if (out.moduleId && !out.courseSlug) {
    const slug = extractCiscoCourseSlugLeading(s);
    if (slug) out.courseSlug = slug;
  }

  return out;
}

function isLikelySupplementaryActivityId(activityId) {
  if (!activityId || typeof activityId !== "string") return false;
  const s = decodeNetacadMaybeRepeated(activityId.trim());
  return /supplementary|supply/i.test(s);
}

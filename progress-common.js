"use strict";

const MSG_NEED_REFRESH = "异常：请刷新课程网页后重试";
globalThis.MSG_NEED_REFRESH = MSG_NEED_REFRESH;

async function adlSend(type, payload) {
  try {
    const r = await chrome.runtime.sendMessage({ type, ...(payload || {}) });
    if (r === undefined) return { ok: false, error: "扩展无响应，请刷新课程网页后再试" };
    return r;
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function guessXapiLaunchUuidsFromPage() {
  const out = [];
  const re = /xAPILaunchKey=([a-f0-9-]{36})/gi;
  const scan = (href) => {
    if (!href || typeof href !== "string") return;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(href))) {
      const u = m[1].toLowerCase();
      if (!out.includes(u)) out.push(u);
    }
  };
  try {
    scan(String(globalThis.location?.href || ""));
  } catch (_) {}
  try {
    if (typeof document !== "undefined" && document.referrer) scan(document.referrer);
  } catch (_) {}
  try {
    if (typeof document !== "undefined") {
      document.querySelectorAll("iframe[src]").forEach((el) => scan(el.getAttribute("src") || ""));
    }
  } catch (_) {}
  return out;
}

function normalizeCountsDisplay(cc) {
  if (!cc || typeof cc !== "object") return null;
  const flag =
    cc.courseJsonFlag !== undefined ? cc.courseJsonFlag : cc.course !== undefined ? cc.course : undefined;
  return {
    courseJsonFlag: flag,
    contentObjects: cc.contentObjects,
    articles: cc.articles,
    blocks: cc.blocks,
    components: cc.components,
  };
}

function nonEmptyTrim(x) {
  if (x == null || x === "") return "";
  const s = String(x).trim();
  if (!s || /^null$/i.test(s)) return "";
  return s;
}

function normalizeUrlPrefixForPopup(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  try {
    const u = new URL(t);
    let path = u.pathname;
    if (!path.endsWith("/")) path += "/";
    return `${u.origin}${path}`;
  } catch {
    return t.endsWith("/") ? t : `${t}/`;
  }
}

function contentJsonUrlLegacyForPopup(courseSlug, moduleNum, locale, name) {
  return `https://www.netacad.com/content/${encodeURIComponent(courseSlug)}/1.0/courses/content/m${encodeURIComponent(
    String(moduleNum)
  )}/${locale}/${name}.json`;
}

function buildBundleLegacyUrlsForPopup(courseSlug, moduleId, prefsLocale) {
  const loc =
    prefsLocale === "en-US" || String(prefsLocale || "").toLowerCase() === "en-us" ? "en-US" : "zh-CN";
  const parts = ["course", "contentObjects", "articles", "blocks", "components"];
  const o = {};
  for (const p of parts) {
    o[p] = contentJsonUrlLegacyForPopup(courseSlug, moduleId, loc, p);
  }
  return o;
}

function buildBundlePrefixUrlsForPopup(prefixRaw) {
  const base = normalizeUrlPrefixForPopup(prefixRaw);
  if (!base) return null;
  const parts = ["course", "contentObjects", "articles", "blocks", "components"];
  const o = {};
  for (const p of parts) {
    o[p] = `${base}${p}.json`;
  }
  return o;
}

function modFromActivityIdForPopup(act) {
  if (typeof act !== "string") return "";
  return nonEmptyTrim(parseActivityIdHints(act).moduleId);
}

function bundleDisplayUrlsAndMode(r) {
  const prefs = r.prefs || {};
  const cap = r.capture || {};
  const derived = r.derivedLesson || {};
  const localeHint = prefs.locale;
  const actStr = typeof cap.activityId === "string" ? cap.activityId : "";
  const actHints = parseActivityIdHints(actStr);
  const slugFromAct = nonEmptyTrim(actHints.courseSlug);
  const modFromAct = nonEmptyTrim(actHints.moduleId);

  const slugResolved =
    slugFromAct ||
    nonEmptyTrim(derived.courseSlug) ||
    nonEmptyTrim(prefs.courseSlug) ||
    nonEmptyTrim(cap.courseSlug);

  let modResolved =
    modFromAct ||
    nonEmptyTrim(derived.moduleId) ||
    (Array.isArray(derived.moduleList) && derived.moduleList.length
      ? nonEmptyTrim(derived.moduleList[0])
      : "");
  if (!modResolved) modResolved = modFromActivityIdForPopup(actStr);
  if (!modResolved) modResolved = nonEmptyTrim(cap.moduleId);

  if (modFromAct && slugResolved) {
    return { urls: buildBundleLegacyUrlsForPopup(slugResolved, modFromAct, localeHint), mode: "legacy" };
  }

  const bg = r.bundleSourceUrls;
  if (bg && typeof bg === "object" && typeof bg.course === "string" && bg.course) {
    return {
      urls: bg,
      mode: r.bundleUrlMode ?? r.resolvedMode ?? null,
    };
  }

  if (slugResolved && modResolved) {
    return { urls: buildBundleLegacyUrlsForPopup(slugResolved, modResolved, localeHint), mode: "legacy" };
  }
  const bases = Array.isArray(r.contentBases) ? r.contentBases : [];
  for (let i = 0; i < bases.length; i++) {
    const byPrefix = buildBundlePrefixUrlsForPopup(bases[i]?.prefix);
    if (byPrefix) return { urls: byPrefix, mode: "prefix" };
  }
  return { urls: bg && typeof bg === "object" ? bg : null, mode: r.bundleUrlMode ?? r.resolvedMode ?? null };
}

const BUNDLE_JSON_PARTS_ORDER = ["course", "contentObjects", "articles", "blocks", "components"];

function bundleJsonFileUrlsArray(urlsObj) {
  if (!urlsObj || typeof urlsObj !== "object") return null;
  const out = [];
  for (let i = 0; i < BUNDLE_JSON_PARTS_ORDER.length; i++) {
    const u = urlsObj[BUNDLE_JSON_PARTS_ORDER[i]];
    if (typeof u === "string" && u.trim()) out.push(u.trim());
  }
  return out.length ? out : null;
}

function isNetacadLikeHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h.endsWith("netacad.com") || h === "netacad.com" || h.endsWith("cisco.com") || h === "cisco.com";
}

function collectAdlStateUrlsFromPerformance() {
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
      if (out.length >= 24) break;
    }
  } catch (_) {}
  return out;
}

async function flushAdlFromPerformanceIfLessonPage() {
  try {
    const host = String(globalThis.location?.hostname || "").toLowerCase();
    if (!isNetacadLikeHost(host)) return;
    const urls = collectAdlStateUrlsFromPerformance();
    if (!urls.length) return;
    await adlSend("MERGE_CAPTURE_URLS", { urls });
  } catch (_) {}
}

function heardDisplayFromCapture(capture) {
  if (!capture || typeof capture !== "object") return "";
  const id = typeof capture.activityId === "string" ? capture.activityId.trim() : "";
  if (!id) return "";
  if (isLikelySupplementaryActivityId(id)) return "补充小节";
  const mid = nonEmptyTrim(parseActivityIdHints(id).moduleId);
  return mid || "";
}

function captureDetailPreClass(el) {
  try {
    if (el && typeof el.closest === "function" && el.closest("#netacad-adl-helper-panel")) {
      return "netacad-adl-json";
    }
  } catch (_) {}
  return "json";
}

function clearCaptureDetail(el) {
  if (!el) return;
  el.replaceChildren();
}

function renderCaptureDetail(el, coreObj, urls) {
  if (!el) return;
  const preCls = captureDetailPreClass(el);
  clearCaptureDetail(el);
  const appendPre = (data) => {
    const pre = document.createElement("pre");
    pre.className = preCls;
    pre.textContent = JSON.stringify(data, null, 2);
    el.appendChild(pre);
  };
  const appendHeading = (text) => {
    const row = document.createElement("div");
    row.className = "capture-detail-heading";
    const s = document.createElement("strong");
    s.textContent = text;
    row.appendChild(s);
    el.appendChild(row);
  };
  appendPre(coreObj);
  appendHeading("json网址");
  appendPre(urls ?? null);
}

/** 刷新进度 UI */
async function refreshProgressInto(els, opts) {
  const coursePageStrict = Boolean(opts?.coursePageStrict);
  const setEmpty = () => {
    if (els.toast) els.toast.textContent = "";
  };
  setEmpty();
  try {
    await flushAdlFromPerformanceIfLessonPage();
    const lk = guessXapiLaunchUuidsFromPage();
    const r = await adlSend("GET_STATUS", { launchKeys: lk });
    if (!r || !r.ok) {
      els.lessonLine.textContent = MSG_NEED_REFRESH;
      els.syncLine.textContent = MSG_NEED_REFRESH;
      clearCaptureDetail(els.captureDetail);
      els.heardCurrentModule.value = "";
      els.courseSlug.value = "";
      return;
    }
    const bundleUi = bundleDisplayUrlsAndMode(r);
    const urlModeDisplay = bundleUi.mode ?? r.bundleUrlMode ?? r.resolvedMode;
    const c = r.capture;
    const derived = r.derivedLesson || {};
    const actRaw = typeof c?.activityId === "string" ? c.activityId.trim() : "";
    const actHintsForSlug = parseActivityIdHints(actRaw);

    const prefsMergedCourseSlug = String(
      nonEmptyTrim(actHintsForSlug.courseSlug) ||
        derived.courseSlug ||
        r.prefs?.courseSlug ||
        c?.courseSlug ||
        ""
    ).trim();
    const actHintsStrict = actRaw ? actHintsForSlug : parseActivityIdHints("");
    const strictCourseSlug = nonEmptyTrim(c?.courseSlug) || nonEmptyTrim(actHintsStrict.courseSlug) || "";

    const adlOk = Boolean(c?.postOrigin && c?.activityId && c?.agent && c?.stateId);

    if (coursePageStrict && !adlOk) {
      els.lessonLine.textContent = "";
      els.syncLine.textContent = '学习会话：本页尚未加载课件；请先进入一节学习内容，再点开 "发"。';
      clearCaptureDetail(els.captureDetail);
      els.heardCurrentModule.value = "";
      els.courseSlug.value = "";
      return;
    }

    const slugForLessonUi = coursePageStrict ? strictCourseSlug : prefsMergedCourseSlug;

    els.courseSlug.value = coursePageStrict ? strictCourseSlug : prefsMergedCourseSlug;
    const line = String(r.heardSessionLine || "").trim();
    const num = String(r.heardCurrentModule || "").trim();
    const fromCap = heardDisplayFromCapture(r.capture);
    const actUi = typeof c?.activityId === "string" ? c.activityId.trim() : "";
    const supplUi = isLikelySupplementaryActivityId(actUi);
    const modFromActUi = supplUi ? "" : nonEmptyTrim(parseActivityIdHints(actUi).moduleId);
    els.heardCurrentModule.value = modFromActUi || num || fromCap || line;

    const mods = Array.isArray(r.moduleTargets) ? r.moduleTargets.filter(Boolean) : [];
    const hasCourseName = Boolean(slugForLessonUi);
    const hasModules = mods.length > 0;
    if (!urlModeDisplay) {
      if (hasCourseName && !hasModules) {
        els.lessonLine.textContent = "";
      } else if (!hasCourseName) {
        els.lessonLine.textContent = "课件 JSON：尚未识别课程名，请在课程页正常学习以捕获会话。";
      } else {
        els.lessonLine.textContent = "课件 JSON：会话或路径不完整（请打开一页正课课件触发请求）。";
      }
    } else if (r.contentCounts) {
      els.lessonLine.textContent = "课件 JSON：就绪";
    } else {
      els.lessonLine.textContent = "课件 JSON：目录或路径已知，但数量预览未加载成功";
    }
    els.syncLine.textContent = adlOk ? "学习会话：正常" : `学习会话：${MSG_NEED_REFRESH}`;
    const counts = normalizeCountsDisplay(r.contentCounts);
    const urlsForDetail = bundleJsonFileUrlsArray(bundleUi.urls);
    const actStr = typeof c?.activityId === "string" ? c.activityId : "";
    const hintsActUi = parseActivityIdHints(actStr);
    const modFromSessionRaw = nonEmptyTrim(hintsActUi.moduleId);
    const modFromSession = modFromSessionRaw === "" ? null : modFromSessionRaw;
    const isSuppl = isLikelySupplementaryActivityId(actStr);
    renderCaptureDetail(els.captureDetail, {
      postOrigin: c?.postOrigin ?? null,
      activityIdPreview: actStr ? actStr.slice(0, 80) + (actStr.length > 80 ? "…" : "") : null,
      stateId: c?.stateId ?? null,
      课程: c?.courseSlug ?? null,
      会话类型: isSuppl ? "补充小节" : modFromSession ? "正课" : "其他",
      会话中的模块编号: isSuppl ? null : modFromSession,
      capturedAt: c?.capturedAt ? new Date(c.capturedAt).toLocaleString() : null,
      数量预览: counts,
    }, urlsForDetail);
  } catch {
    els.lessonLine.textContent = MSG_NEED_REFRESH;
    els.syncLine.textContent = MSG_NEED_REFRESH;
    clearCaptureDetail(els.captureDetail);
    els.heardCurrentModule.value = "";
    els.courseSlug.value = "";
  }
}

async function submitProgressFromPanel(els) {
  const lk = guessXapiLaunchUuidsFromPage();
  const r = await adlSend("POST_PROGRESS", {
    courseSlug: els.courseSlug.value,
    launchKeys: lk,
  });
  if (!r.ok) return { ok: false, error: r.error || MSG_NEED_REFRESH };
  const batch = Array.isArray(r.batchResults) ? r.batchResults : [];
  const failed = batch.find((x) => !x.ok);
  if (failed) {
    const tag = failed.mod != null ? String(failed.mod) : failed.tag ?? "?";
    const st = failed.status != null ? String(failed.status) : "";
    return { ok: false, error: `失败：模块 ${tag}${st ? `（${st}）` : ""}` };
  }
  if (r.result && !r.result.ok) return { ok: false, error: MSG_NEED_REFRESH };
  return { ok: true };
}

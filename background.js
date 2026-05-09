importScripts("netacad-activity-parse.js");

/** NetAcad 后台 */

const STORAGE_KEYS = {
  capture: "netacadCapture",
  captureByAdlUuid: "netacadCaptureByAdlUuid",
  prefs: "netacadPrefs",
  contentBases: "netacadContentJsonBases",
};

const DEFAULT_PREFS = {
  selectedContentPrefix: "",
  courseSlug: "srwe",
  moduleStart: "",
  moduleEnd: "",
  modulesInput: "",
  moduleId: "",
  locale: "zh-CN",
};

const CONTENT_JSON_LEGACY_PATH =
  /^\/content\/([^/]+)\/1\.0\/courses\/content\/m(\d+)\/(zh-CN|en-US)\/.+\.json$/i;

const MAX_STORED_BASES = 40;
const MAX_ADL_BUCKETS = 40;

const NETACAD_WEB_URLS = [
  "https://www.netacad.com/*",
  "https://*.netacad.com/*",
  "https://netacad.com/*",
  "https://*.cisco.com/*",
  "https://cisco.com/*",
];

function utcIsoWithMs(date) {
  return date.toISOString();
}

async function getPrefs() {
  const { [STORAGE_KEYS.prefs]: p } = await chrome.storage.local.get(STORAGE_KEYS.prefs);
  const merged = { ...DEFAULT_PREFS, ...(p || {}) };

  merged.selectedContentPrefix =
    merged.selectedContentPrefix == null ||
    merged.selectedContentPrefix === "null" ||
    merged.selectedContentPrefix === "undefined"
      ? ""
      : String(merged.selectedContentPrefix).trim();

  const slug = merged.courseSlug;
  merged.courseSlug =
    slug == null ||
    String(slug).trim() === "" ||
    /^null$/i.test(String(slug)) ||
    /^undefined$/i.test(String(slug))
      ? DEFAULT_PREFS.courseSlug
      : String(slug).trim();

  const mod = merged.moduleId;
  merged.moduleId =
    mod == null ||
    String(mod).trim() === "" ||
    /^null$/i.test(String(mod)) ||
    /^undefined$/i.test(String(mod))
      ? DEFAULT_PREFS.moduleId
      : String(mod).trim();

  let modsIn = merged.modulesInput;
  if (
    modsIn == null ||
    modsIn === "null" ||
    modsIn === "undefined" ||
    /^null$/i.test(String(modsIn)) ||
    /^undefined$/i.test(String(modsIn))
  )
    modsIn = "";
  merged.modulesInput = String(modsIn).trim();
  const oldMod = merged.moduleId;
  if (!merged.modulesInput && oldMod != null && String(oldMod).trim() !== "") {
    merged.modulesInput = String(oldMod).trim();
  }

  let mst =
    merged.moduleStart == null || merged.moduleStart === "null" || merged.moduleStart === "undefined"
      ? ""
      : String(merged.moduleStart).trim();
  let mend =
    merged.moduleEnd == null || merged.moduleEnd === "null" || merged.moduleEnd === "undefined"
      ? ""
      : String(merged.moduleEnd).trim();
  if (/^null$/i.test(mst)) mst = "";
  if (/^null$/i.test(mend)) mend = "";

  if (!mst && !mend) {
    const tokens = splitModulesInput(merged.modulesInput);
    const nums = tokens
      .map((x) => (/^\d+$/.test(x) ? Number.parseInt(x, 10) : NaN))
      .filter((n) => Number.isFinite(n) && n >= 1);
    if (nums.length === 1) {
      mst = String(nums[0]);
      mend = String(nums[0]);
    } else if (nums.length >= 2) {
      mst = String(Math.min(...nums));
      mend = String(Math.max(...nums));
    }
  }
  merged.moduleStart = mst;
  merged.moduleEnd = mend;

  merged.locale = merged.locale === "en-US" ? "en-US" : "zh-CN";
  return merged;
}

async function setPrefs(patch) {
  const cur = await getPrefs();
  await chrome.storage.local.set({ [STORAGE_KEYS.prefs]: { ...cur, ...patch } });
}

async function getCapture() {
  const { [STORAGE_KEYS.capture]: c } = await chrome.storage.local.get(STORAGE_KEYS.capture);
  return c || null;
}

async function setCapture(data) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.capture]: {
      ...data,
      capturedAt: Date.now(),
    },
  });
}

async function getAdlBucketMap() {
  const { [STORAGE_KEYS.captureByAdlUuid]: m } = await chrome.storage.local.get(
    STORAGE_KEYS.captureByAdlUuid
  );
  return m && typeof m === "object" ? { ...m } : {};
}

async function saveAdlBucketMap(map) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.captureByAdlUuid]: map,
  });
}

function decodeAdlsessionCookieToUuid(rawVal) {
  if (rawVal == null || rawVal === "") return "";
  try {
    let s = String(rawVal).trim();
    try {
      s = decodeURIComponent(s);
    } catch (_) {}
    const uuidRe =
      /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/i;
    const direct = uuidRe.exec(s);
    if (direct) return direct[0].toLowerCase();

    let b64 = String(s).replace(/\s+/g, "");
    try {
      b64 = decodeURIComponent(b64);
    } catch (_) {}
    b64 = b64.replace(/-/g, "+");
    while (b64.length % 4) b64 += "=";

    const bin = atob(b64);
    const inner = uuidRe.exec(bin);
    return inner ? inner[0].toLowerCase() : "";
  } catch (_) {
    return "";
  }
}

async function readAdlsessionUuidFromCookies() {
  const origins = ["https://www.netacad.com/", "https://netacad.com/", "https://content.netacad.com/"];
  for (const url of origins) {
    try {
      const dome = await chrome.cookies.getAll({ url });
      for (const c of dome) {
        if (String(c?.name || "").toLowerCase() !== "adlsession" || !c.value) continue;
        const uuid = decodeAdlsessionCookieToUuid(c.value);
        if (uuid) return uuid;
      }
    } catch (_) {}
  }
  try {
    const all = await chrome.cookies.getAll({ domain: ".netacad.com" });
    for (const c of all) {
      if (String(c?.name || "").toLowerCase() !== "adlsession" || !c.value) continue;
      const uuid = decodeAdlsessionCookieToUuid(c.value);
      if (uuid) return uuid;
    }
  } catch (_) {}
  return "";
}

function normalizeUuidList(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  const uuidRe =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  for (let i = 0; i < list.length; i++) {
    const raw = String(list[i] || "")
      .trim()
      .toLowerCase();
    if (!uuidRe.test(raw) || out.includes(raw)) continue;
    out.push(raw);
  }
  return out;
}

function hasCompleteAdlCapture(o) {
  if (!o || typeof o !== "object") return false;
  return Boolean(
    String(o.postOrigin || "").trim() &&
      String(o.activityId || "").trim() &&
      String(o.agent || "").trim() &&
      String(o.stateId || "").trim()
  );
}

function applyAdlBucketToCapture(globalCap, bucket) {
  const g = globalCap && typeof globalCap === "object" ? { ...globalCap } : {};
  if (!hasCompleteAdlCapture(bucket)) return g;
  const act = String(bucket.activityId || "");
  const hints = parseActivityIdHints(act);
  const suppl = act && isLikelySupplementaryActivityId(act);

  const out = {
    ...g,
    postOrigin: bucket.postOrigin,
    activityId: bucket.activityId,
    agent: bucket.agent,
    stateId: bucket.stateId,
    adlUuid: bucket.adlUuid || g.adlUuid,
  };

  if (suppl) {
    out.moduleId = "";
  } else {
    if (nonEmptyModuleId(hints.moduleId)) out.moduleId = String(hints.moduleId).trim();
    else if (nonEmptyModuleId(bucket.moduleId)) out.moduleId = String(bucket.moduleId).trim();

    if (nonEmptySlug(hints.courseSlug)) out.courseSlug = String(hints.courseSlug).trim();
    else if (nonEmptySlug(bucket.courseSlug)) out.courseSlug = String(bucket.courseSlug).trim();
  }

  return out;
}



async function pickEffectiveCapture(launchKeys) {
  const [globalCapRaw, bucketMap, cookieUuid] = await Promise.all([
    getCapture(),
    getAdlBucketMap(),
    readAdlsessionUuidFromCookies(),
  ]);
  const launchNorm = normalizeUuidList(launchKeys);

  const prioritized = [];
  function pushPri(u) {
    const x = String(u || "")
      .trim()
      .toLowerCase();
    if (!/^[a-f0-9-]{36}$/.test(x) || prioritized.includes(x)) return;
    prioritized.push(x);
  }
  if (cookieUuid) pushPri(cookieUuid);
  for (let i = 0; i < launchNorm.length; i++) pushPri(launchNorm[i]);

  let cap =
    globalCapRaw && typeof globalCapRaw === "object" ? { ...globalCapRaw } : {};
  let matchedBucket = "";

  function tryBuckets(idList) {
    for (let i = 0; i < idList.length; i++) {
      const uid = idList[i];
      const b = bucketMap[uid];
      if (hasCompleteAdlCapture(b)) {
        matchedBucket = uid;
        cap = applyAdlBucketToCapture(cap, { ...b, adlUuid: uid });
        return true;
      }
    }
    return false;
  }

  tryBuckets(prioritized);

  const strictLaunchContext =
    !!(String(cookieUuid || "").trim() || (launchNorm && launchNorm.length > 0));
  if (!matchedBucket && !strictLaunchContext) {
    const newestFirst = Object.keys(bucketMap || {}).sort(
      (a, b) => (bucketMap[b]?.ts || 0) - (bucketMap[a]?.ts || 0)
    );
    tryBuckets(newestFirst);
  }

  if (!matchedBucket && hasCompleteAdlCapture(cap)) {
    const gu = String(cap.adlUuid || "")
      .trim()
      .toLowerCase();
    if (!strictLaunchContext) {
      if (gu) matchedBucket = gu;
    } else if (gu && prioritized.includes(gu)) {
      matchedBucket = gu;
    }
  }

  if (
    strictLaunchContext &&
    !matchedBucket &&
    hasCompleteAdlCapture(cap) &&
    prioritized.length > 0 &&
    !prioritized.includes(String(cap.adlUuid || "").trim().toLowerCase())
  ) {
    cap = {
      ...cap,
      postOrigin: "",
      activityId: "",
      agent: "",
      stateId: "",
    };
  }

  return {
    capture: cap,
  };
}

async function recordAdlBucket(uuidRaw, fields) {
  const uuid = String(uuidRaw || "")
    .trim()
    .toLowerCase();
  if (!uuid || !/^[a-f0-9-]{36}$/.test(uuid)) return;
  const map = await getAdlBucketMap();
  const prev = map[uuid] || {};
  map[uuid] = { ...prev, ...fields, adlUuid: uuid, ts: Date.now() };

  const keys = Object.keys(map);
  if (keys.length > MAX_ADL_BUCKETS) {
    keys.sort((a, b) => (map[a]?.ts || 0) - (map[b]?.ts || 0));
    const overflow = keys.length - MAX_ADL_BUCKETS;
    for (let i = 0; i < overflow; i++) delete map[keys[i]];
  }
  await saveAdlBucketMap(map);
}

let captureMergeChain = Promise.resolve();

function scheduleMergeCaptureFromUrl(url, requestBody) {
  captureMergeChain = captureMergeChain
    .then(() => mergeCaptureFromUrl(url, requestBody ?? null))
    .catch(() => {});
  return captureMergeChain;
}

async function getContentBaseRegistry() {
  const { [STORAGE_KEYS.contentBases]: rows } = await chrome.storage.local.get(
    STORAGE_KEYS.contentBases
  );
  return Array.isArray(rows) ? rows : [];
}

function normalizeContentPrefix(prefix) {
  const s = String(prefix || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    let path = u.pathname;
    if (!path.endsWith("/")) path += "/";
    return `${u.origin}${path}`;
  } catch {
    return s.endsWith("/") ? s : `${s}/`;
  }
}

function legacyDirectoryPrefix(courseSlug, moduleId, locale) {
  const loc =
    locale === "en-US" ||
    locale === "en-us" ||
    String(locale || DEFAULT_PREFS.locale).toLowerCase() === "en-us"
      ? "en-US"
      : "zh-CN";
  return normalizeContentPrefix(
    `https://www.netacad.com/content/${encodeURIComponent(String(courseSlug))}/1.0/courses/content/m${encodeURIComponent(
      String(moduleId)
    )}/${loc}/`
  );
}

function augmentBasesForPopup(registryRows, prefs, resolved) {
  const list = (registryRows || []).map((r) => ({
    ...r,
    prefix: normalizeContentPrefix(r.prefix),
  }));

  const seen = new Set(list.map((r) => r.prefix).filter(Boolean));

  function pushSynth(prefixRaw, label) {
    const p = normalizeContentPrefix(prefixRaw);
    if (!p || seen.has(p)) return;
    seen.add(p);
    list.unshift({
      prefix: p,
      label,
      lastFile: "course.json",
      lastSeen: Date.now(),
      synthetic: true,
    });
  }

  pushSynth(prefs.selectedContentPrefix, "已选用的课件目录");

  if (resolved?.mode === "prefix") {
    pushSynth(resolved.prefix, "当前所用的课件目录");
  } else if (resolved?.mode === "legacy") {
    pushSynth(
      legacyDirectoryPrefix(resolved.courseSlug, resolved.moduleId, resolved.locale),
      `兼容 content 路径 · ${resolved.courseSlug} · m${resolved.moduleId}`
    );
  }

  list.sort((a, b) => b.lastSeen - a.lastSeen);
  return list;
}

function jsonDirPrefixFromUrl(urlString) {
  try {
    const u = new URL(urlString);
    const path = u.pathname;
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash < 0) return null;
    const file = path.slice(lastSlash + 1);
    if (!/\.json(?:[?#].*)?$/i.test(file.replace(/[#?].*$/, ""))) return null;
    return `${u.origin}${path.slice(0, lastSlash + 1)}`;
  } catch {
    return null;
  }
}

function makeLabelFromPrefix(prefix) {
  try {
    const u = new URL(prefix);
    const p = u.pathname.replace(/\/+$/, "");
    const parts = p.split("/").filter(Boolean);
    const tail = parts.slice(-5).join("/");
    return tail || p.slice(1) || prefix;
  } catch {
    return prefix;
  }
}

async function recordContentJsonBase(urlString) {
  const prefix = jsonDirPrefixFromUrl(urlString);
  if (!prefix) return;

  let basename = "";
  try {
    basename = new URL(urlString).pathname.split("/").filter(Boolean).pop() || "";
  } catch {}

  const registry = await getContentBaseRegistry();
  const now = Date.now();
  const idx = registry.findIndex((x) => x.prefix === prefix);
  const entry = {
    prefix,
    label: makeLabelFromPrefix(prefix),
    lastFile: basename,
    lastSeen: now,
  };
  if (idx >= 0) {
    registry[idx] = { ...registry[idx], ...entry };
  } else {
    registry.push(entry);
  }
  registry.sort((a, b) => b.lastSeen - a.lastSeen);

  await chrome.storage.local.set({
    [STORAGE_KEYS.contentBases]: registry.slice(0, MAX_STORED_BASES),
  });
}

function pickRegistryPrefixForCapture(capture, registryRows) {
  const rows = Array.isArray(registryRows) ? registryRows : [];
  if (!rows.length) return "";
  const sorted = [...rows].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  const suppl =
    capture?.activityId && isLikelySupplementaryActivityId(capture.activityId);
  if (suppl) {
    const authoring = sorted.find((r) => /\/authoring-resources\//i.test(String(r.prefix || "")));
    if (authoring) return normalizeContentPrefix(authoring.prefix);
  }
  return normalizeContentPrefix(sorted[0].prefix);
}

function buildAdlCaptureFromPathAndParams(urlString, activityId, agent, stateId) {
  try {
    if (!activityId || !agent || !stateId) return null;
    const u = new URL(urlString);
    const path = u.pathname || "";
    const pl = path.toLowerCase();
    if (!pl.includes("/adl/data/")) return null;
    let suf = "";
    if (pl.includes("/activities/state")) suf = "/activities/state";
    else if (pl.includes("/activity/state")) suf = "/activity/state";
    else return null;
    const uuidM = path.match(/\/adl\/data\/([^/]+)(?:\/|$)/);
    if (!uuidM) return null;
    const uuid = uuidM[1];
    const idxLow = pl.lastIndexOf(suf);
    if (idxLow < 0) return null;
    const pathBase = path.slice(0, idxLow + suf.length).replace(/\/+$/, "");
    return {
      uuid,
      postOrigin: `${u.origin}${pathBase}`,
      activityId,
      agent,
      stateId,
    };
  } catch {
    return null;
  }
}

function urlSearchParamsGetCI(params, ...names) {
  if (!params || typeof params.get !== "function") return "";
  for (let ni = 0; ni < names.length; ni++) {
    const name = names[ni];
    if (!name) continue;
    try {
      const direct = params.get(name);
      if (direct !== null && String(direct) !== "") return String(direct);
    } catch (_) {}
    const wl = String(name).toLowerCase();
    try {
      const keys = [...params.keys()];
      for (let i = 0; i < keys.length; i++) {
        if (String(keys[i]).toLowerCase() !== wl) continue;
        const v = params.get(keys[i]);
        if (v !== null && String(v) !== "") return String(v);
      }
    } catch (_) {}
  }
  return "";
}

function multipartPickField(formDataMap, names) {
  if (!formDataMap || typeof formDataMap !== "object") return "";
  const lowered = new Map();
  for (const k of Object.keys(formDataMap)) {
    lowered.set(String(k).toLowerCase(), formDataMap[k]);
  }
  for (let ni = 0; ni < names.length; ni++) {
    const kl = String(names[ni]).toLowerCase();
    if (!lowered.has(kl)) continue;
    const raw = lowered.get(kl);
    if (raw == null) continue;
    if (typeof raw === "string" && raw !== "") return raw;
    if (Array.isArray(raw) && raw.length) return String(raw[0]);
  }
  return "";
}

function parseAdlStateUrl(urlString) {
  try {
    const u = new URL(urlString);
    let activityId =
      urlSearchParamsGetCI(u.searchParams, "activityId", "activity_id") || "";
    let agent = urlSearchParamsGetCI(u.searchParams, "agent") || "";
    let stateId = urlSearchParamsGetCI(u.searchParams, "stateId", "state_id") || "";

    if (!activityId || !agent || !stateId) {
      const rawHash = u.hash.replace(/^#\??/, "").trim();
      if (rawHash) {
        const hp = new URLSearchParams(rawHash);
        activityId =
          activityId ||
          urlSearchParamsGetCI(hp, "activityId", "activity_id") ||
          "";
        agent = agent || urlSearchParamsGetCI(hp, "agent") || "";
        stateId =
          stateId ||
          urlSearchParamsGetCI(hp, "stateId", "state_id") ||
          "";
      }
    }

    return buildAdlCaptureFromPathAndParams(urlString, activityId, agent, stateId);
  } catch {
    return null;
  }
}

function parseAdlStateFromMultipartBody(urlString, requestBody) {
  if (!requestBody?.formData) return null;
  const fd = requestBody.formData;
  const activityId = multipartPickField(fd, ["activityId", "activity_id"]);
  const agent = multipartPickField(fd, ["agent"]);
  const stateId = multipartPickField(fd, ["stateId", "state_id"]);
  return buildAdlCaptureFromPathAndParams(urlString, activityId, agent, stateId);
}

function decodeWebRequestRawBody(requestBody) {
  if (!requestBody?.raw?.length) return "";
  try {
    let out = "";
    for (let i = 0; i < requestBody.raw.length; i++) {
      const bytes = requestBody.raw[i]?.bytes;
      if (bytes) out += new TextDecoder("utf-8").decode(bytes);
    }
    return out;
  } catch {
    return "";
  }
}

function parseAdlFromRawJsonBody(urlString, requestBody) {
  const text = decodeWebRequestRawBody(requestBody).trim();
  if (!text || text.charCodeAt(0) !== 123) return null;
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const activityId =
    typeof j.activityId === "string"
      ? j.activityId
      : typeof j.activity_id === "string"
        ? j.activity_id
        : "";
  const agent = typeof j.agent === "string" ? j.agent : "";
  const stateId =
    typeof j.stateId === "string" ? j.stateId : typeof j.state_id === "string" ? j.state_id : "";
  return buildAdlCaptureFromPathAndParams(urlString, activityId, agent, stateId);
}

function parseLegacyContentJsonUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(CONTENT_JSON_LEGACY_PATH);
    if (!m) return null;
    return { courseSlug: m[1], moduleId: m[2], locale: m[3] };
  } catch {
    return null;
  }
}

function nonEmptySlug(v) {
  if (v === undefined || v === null) return "";
  const s = String(v).trim();
  if (!s || /^null$/i.test(s) || /^undefined$/i.test(s)) return "";
  return s;
}

function nonEmptyModuleId(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v));
  const s = String(v).trim();
  if (!s || /^null$/i.test(s)) return "";
  return s;
}

function splitModulesInput(raw) {
  if (raw === undefined || raw === null) return [];
  const s = String(raw).trim();
  if (!s || /^null$/i.test(s) || /^undefined$/i.test(s)) return [];
  return s
    .split(/[,，]+|\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function deriveCourseModuleForLegacy(prefs, capture) {
  let courseSlug = nonEmptySlug(prefs?.courseSlug) || nonEmptySlug(capture?.courseSlug);

  const hints = parseActivityIdHints(capture?.activityId || "");

  let moduleList = [];
  const fromHintMod = nonEmptyModuleId(hints.moduleId);
  const fromCaptureJson = nonEmptyModuleId(capture?.moduleId);
  const suppl = capture?.activityId && isLikelySupplementaryActivityId(capture.activityId);

  if (fromHintMod) moduleList.push(fromHintMod);
  else if (!suppl && fromCaptureJson) moduleList.push(fromCaptureJson);

  if (!courseSlug && hints.courseSlug) courseSlug = nonEmptySlug(hints.courseSlug);

  let moduleId = moduleList[0] || "";
  if (moduleId && moduleList.length === 0) moduleList = [moduleId];
  else if (!moduleId && moduleList.length > 0) moduleId = moduleList[0];

  return { courseSlug, moduleId, moduleList };
}

function heardCurrentModuleFromCapture(capture) {
  return nonEmptyModuleId(parseActivityIdHints(typeof capture?.activityId === "string" ? capture.activityId : "").moduleId);
}

function heardSessionSummary(capture) {
  if (!capture || typeof capture !== "object") return { line: "", numericHint: "" };
  const raw = typeof capture.activityId === "string" ? capture.activityId : "";
  const hints = parseActivityIdHints(raw);
  const modA = nonEmptyModuleId(hints.moduleId);
  if (modA) return { line: modA, numericHint: modA };

  if (isLikelySupplementaryActivityId(raw)) {
    return { line: "补充小节", numericHint: "" };
  }

  const tailM = /cisco_[a-z0-9_-]+_([a-z0-9_-]+)/i.exec(raw);
  if (tailM && !/^mod\d+$/i.test(tailM[1])) {
    const m = nonEmptyModuleId(hints.moduleId);
    const tail = tailM[1];
    return {
      line: m ? m : `后缀 ${tail}，请打开一节正课以确认`,
      numericHint: m || "",
    };
  }

  const fromHintsTail = nonEmptyModuleId(hints.moduleId);
  if (fromHintsTail) return { line: fromHintsTail, numericHint: fromHintsTail };
  return { line: "", numericHint: "" };
}

function captureAuthoritiesFromActivityId(activityIdRaw) {
  const raw =
    typeof activityIdRaw !== "string" || !activityIdRaw.trim() ? "" : activityIdRaw;
  if (!raw) return { suppl: false, moduleId: "", courseSlug: "" };
  if (isLikelySupplementaryActivityId(raw)) return { suppl: true, moduleId: "", courseSlug: "" };
  const h = parseActivityIdHints(raw);
  return {
    suppl: false,
    moduleId: nonEmptyModuleId(h.moduleId),
    courseSlug: nonEmptySlug(h.courseSlug),
  };
}

async function mergeCaptureFromUrl(url, requestBody) {
  if (/\.json(?:[?#]|$)/i.test(url)) {
    await recordContentJsonBase(url);
  }

  const cur = (await getCapture()) || {};
  let next = { ...cur };

  let adl = parseAdlStateUrl(url);
  if (!adl && requestBody) {
    adl = parseAdlStateFromMultipartBody(url, requestBody);
  }
  if (!adl && requestBody) {
    adl = parseAdlFromRawJsonBody(url, requestBody);
  }
  if (adl) {
    const h = parseActivityIdHints(adl.activityId);
    next = {
      ...next,
      adlUuid: adl.uuid,
      postOrigin: adl.postOrigin,
      activityId: adl.activityId,
      agent: adl.agent,
      stateId: adl.stateId,
    };
    if (!next.courseSlug && h.courseSlug) next.courseSlug = h.courseSlug;
    if (isLikelySupplementaryActivityId(adl.activityId)) {
      next.moduleId = "";
    } else if (h.moduleId) {
      next.moduleId = h.moduleId;
    }
    await recordAdlBucket(adl.uuid, {
      postOrigin: adl.postOrigin,
      activityId: adl.activityId,
      agent: adl.agent,
      stateId: adl.stateId,
      ...(isLikelySupplementaryActivityId(adl.activityId)
        ? { moduleId: "" }
        : {
            ...(nonEmptySlug(h.courseSlug) ? { courseSlug: nonEmptySlug(h.courseSlug) } : {}),
            ...(nonEmptyModuleId(h.moduleId) ? { moduleId: String(h.moduleId).trim() } : {}),
          }),
    });
  }

  const content = parseLegacyContentJsonUrl(url);
  if (content) {
    const meta = captureAuthoritiesFromActivityId(next.activityId);
    const courseSlugMerged = meta.courseSlug ? meta.courseSlug : content.courseSlug;
    const moduleIdMerged = meta.moduleId ? meta.moduleId : content.moduleId;

    next = {
      ...next,
      courseSlug: courseSlugMerged,
      moduleId: moduleIdMerged,
    };

    await setPrefs({
      courseSlug: courseSlugMerged,
      modulesInput: "",
      moduleId: String(moduleIdMerged),
      locale: content.locale === "en-US" ? "en-US" : "zh-CN",
    });
  }

  if (adl || content) {
    await setCapture(next);
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    scheduleMergeCaptureFromUrl(details.url, null);
  },
  { urls: NETACAD_WEB_URLS }
);

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    scheduleMergeCaptureFromUrl(details.url, details.requestBody || null);
  },
  { urls: NETACAD_WEB_URLS },
  ["requestBody"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    scheduleMergeCaptureFromUrl(details.url, null);
  },
  { urls: NETACAD_WEB_URLS }
);

async function cookieHeaderForNetacad() {
  const merged = new Map();
  try {
    const dome = await chrome.cookies.getAll({ domain: ".netacad.com" });
    for (const c of dome) merged.set(c.name, c.value);
  } catch {}

  const origins = ["https://www.netacad.com/", "https://netacad.com/", "https://content.netacad.com/"];
  for (const url of origins) {
    try {
      const all = await chrome.cookies.getAll({ url });
      for (const c of all) merged.set(c.name, c.value);
    } catch {}
  }
  return [...merged.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
}

function contentJsonUrlLegacy(course, moduleNum, locale, name) {
  return `https://www.netacad.com/content/${encodeURIComponent(
    course
  )}/1.0/courses/content/m${encodeURIComponent(String(moduleNum))}/${locale}/${name}.json`;
}

function bundleSourceUrlsForResolved(resolved) {
  if (!resolved) return null;
  const parts = ["course", "contentObjects", "articles", "blocks", "components"];
  if (resolved.mode === "prefix") {
    const base = normalizeContentPrefix(resolved.prefix);
    const o = {};
    for (const p of parts) o[p] = `${base}${p}.json`;
    return o;
  }
  const loc =
    resolved.locale === "en-US" ||
    String(resolved.locale || "").toLowerCase() === "en-us"
      ? "en-US"
      : "zh-CN";
  const o = {};
  for (const p of parts) {
    o[p] = contentJsonUrlLegacy(resolved.courseSlug, resolved.moduleId, loc, p);
  }
  return o;
}

async function fetchNetacadJson(absUrl) {
  const cookie = await cookieHeaderForNetacad();
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 35_000);
  let res;
  try {
    res = await fetch(absUrl, {
      method: "GET",
      credentials: "omit",
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        Accept: "application/json,text/plain,*/*",
      },
      signal: ac.signal,
    });
  } finally {
    clearTimeout(tid);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} — ${absUrl}\n${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

async function fetchBundleFromPrefix(prefixRaw) {
  const base = normalizeContentPrefix(prefixRaw);
  if (!base) throw new Error("NO_PREFIX");

  const [courseJson, contentObjects, articles, blocks, components] = await Promise.all([
    fetchNetacadJson(`${base}course.json`),
    fetchNetacadJson(`${base}contentObjects.json`),
    fetchNetacadJson(`${base}articles.json`),
    fetchNetacadJson(`${base}blocks.json`),
    fetchNetacadJson(`${base}components.json`),
  ]);

  return { courseJson, contentObjects, articles, blocks, components };
}

async function fetchBundleLegacy(courseSlug, moduleNum, locale) {
  const courseJson = await fetchNetacadJson(
    contentJsonUrlLegacy(courseSlug, moduleNum, locale, "course")
  );
  const contentObjects = await fetchNetacadJson(
    contentJsonUrlLegacy(courseSlug, moduleNum, locale, "contentObjects")
  );
  const articles = await fetchNetacadJson(contentJsonUrlLegacy(courseSlug, moduleNum, locale, "articles"));
  const blocks = await fetchNetacadJson(contentJsonUrlLegacy(courseSlug, moduleNum, locale, "blocks"));
  const components = await fetchNetacadJson(
    contentJsonUrlLegacy(courseSlug, moduleNum, locale, "components")
  );

  return { courseJson, contentObjects, articles, blocks, components };
}

function bundleToCounts(bundle) {
  const { courseJson, contentObjects, articles, blocks, components } = bundle;
  return {
    courseJsonFlag: courseJson && typeof courseJson === "object" ? 1 : 0,
    contentObjects: Array.isArray(contentObjects) ? contentObjects.length : 0,
    articles: Array.isArray(articles) ? articles.length : 0,
    blocks: Array.isArray(blocks) ? blocks.length : 0,
    components: Array.isArray(components) ? components.length : 0,
  };
}

async function fetchContentSummaryFromPrefix(prefix) {
  const bundle = await fetchBundleFromPrefix(prefix);
  return bundleToCounts(bundle);
}

async function fetchContentSummaryLegacy(courseSlug, moduleNum, locale) {
  const bundle = await fetchBundleLegacy(courseSlug, moduleNum, locale);
  return bundleToCounts(bundle);
}

function resolvedPreviewEquals(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.mode !== b.mode) return false;
  if (a.mode === "prefix")
    return normalizeContentPrefix(a.prefix) === normalizeContentPrefix(b.prefix);
  return (
    String(a.courseSlug || "") === String(b.courseSlug || "") &&
    String(a.moduleId || "") === String(b.moduleId || "") &&
    String(a.locale || "") === String(b.locale || "")
  );
}

async function fetchContentCountsForResolved(resolved) {
  if (!resolved) return null;
  if (resolved.mode === "prefix") {
    try {
      return await fetchContentSummaryFromPrefix(resolved.prefix);
    } catch {
      return null;
    }
  }
  try {
    return await fetchContentSummaryLegacy(resolved.courseSlug, resolved.moduleId, resolved.locale);
  } catch {
    return null;
  }
}

function resolveContentCore(prefs, capture, registry) {
  const locale = prefs.locale || DEFAULT_PREFS.locale;
  const derived = deriveCourseModuleForLegacy(prefs, capture);
  const suppl =
    capture?.activityId && isLikelySupplementaryActivityId(capture.activityId);

  if (suppl && !derived.moduleId && registry.length >= 1) {
    const p = pickRegistryPrefixForCapture(capture, registry);
    if (p) return { mode: "prefix", prefix: p };
  }

  if (derived.courseSlug && derived.moduleId) {
    return {
      mode: "legacy",
      courseSlug: derived.courseSlug,
      moduleId: derived.moduleId,
      locale,
    };
  }

  if (registry.length >= 1) {
    const sorted = [...registry].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    return {
      mode: "prefix",
      prefix: normalizeContentPrefix(sorted[0].prefix),
    };
  }

  const tailHints = parseActivityIdHints(capture?.activityId || "");
  const modAct = nonEmptyModuleId(tailHints.moduleId);
  const slugAct =
    nonEmptySlug(prefs?.courseSlug) ||
    nonEmptySlug(capture?.courseSlug) ||
    nonEmptySlug(tailHints.courseSlug);
  if (slugAct && modAct) {
    return {
      mode: "legacy",
      courseSlug: slugAct,
      moduleId: modAct,
      locale,
    };
  }

  return null;
}

async function resolveContentPrefix(msg, prefs, capture, registry) {
  const explicit = normalizeContentPrefix(msg?.contentPrefix || prefs.selectedContentPrefix);
  if (explicit) return { mode: "prefix", prefix: explicit };
  return resolveContentCore(prefs, capture, registry);
}

async function buildProgressPayloadFlexible(resolved) {
  const bundle =
    resolved.mode === "prefix"
      ? await fetchBundleFromPrefix(resolved.prefix)
      : await fetchBundleLegacy(resolved.courseSlug, resolved.moduleId, resolved.locale);

  const { courseJson, contentObjects, articles, blocks, components } = bundle;
  let now = new Date();
  const data = {};

  data.course = {
    _id: courseJson._id,
    _isComplete: true,
    _isInteractionComplete: false,
    _isInprogress: true,
  };

  data.contentObjects = contentObjects.map((co) => {
    now = new Date(now.getTime() + 10_000);
    return {
      _id: co._id,
      _isComplete: true,
      _isInteractionComplete: false,
      _isInprogress: true,
      timestamp: utcIsoWithMs(now),
    };
  });

  data.articles = articles.map((a) => {
    now = new Date(now.getTime() + 10_000);
    return {
      _id: a._id,
      _isComplete: true,
      _isInteractionComplete: false,
      _isInprogress: true,
      timestamp: utcIsoWithMs(now),
    };
  });

  data.blocks = blocks.map((b) => {
    now = new Date(now.getTime() + 10_000);
    return {
      _id: b._id,
      _isComplete: true,
      _isInteractionComplete: false,
      _isInprogress: true,
      timestamp: utcIsoWithMs(now),
    };
  });

  data.components = components.map((c) => {
    now = new Date(now.getTime() + 10_000);
    return {
      _id: c._id,
      _isComplete: true,
      _isInteractionComplete: false,
      _isInprogress: true,
      _userAnswer: null,
      _attemptStates: null,
      timestamp: utcIsoWithMs(now),
    };
  });

  data.offlineStorage = {
    assessmentDuration: {},
    location: "",
  };

  now = new Date(now.getTime() + 10_000);
  data.timestamp = utcIsoWithMs(now);

  return data;
}

async function postProgress({ resolved, capture }) {
  const cap =
    capture ||
    (await getCapture()) ||
    (() => {
      throw new Error("尚未捕获到 ADL 请求。请先在学习页面正常加载。");
    })();

  if (!cap.postOrigin || !cap.activityId || !cap.agent || !cap.stateId) {
    throw new Error("捕获信息不完整（需要 ADL activities/state URL 中的参数）。");
  }

  const payload = await buildProgressPayloadFlexible(resolved);

  const u = new URL(cap.postOrigin);
  u.searchParams.set("activityId", cap.activityId);
  u.searchParams.set("agent", cap.agent);
  u.searchParams.set("stateId", cap.stateId);

  const cookie = await cookieHeaderForNetacad();

  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 60_000);
  let res;
  try {
    res = await fetch(u.toString(), {
      method: "POST",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(tid);
  }

  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    bodyPreview: text.slice(0, 500),
    requestUrl: u.toString(),
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "MERGE_CAPTURE_URLS") {
    void (async () => {
      try {
        const urls = Array.isArray(msg.urls) ? msg.urls.filter((u) => typeof u === "string") : [];
        for (let i = 0; i < urls.length; i++) {
          await scheduleMergeCaptureFromUrl(urls[i], null);
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg?.type === "GET_STATUS") {
    void (async () => {
      try {
        const launchKeysNorm = normalizeUuidList(msg.launchKeys);

        const picked = await pickEffectiveCapture(launchKeysNorm);
        const capture = picked.capture;

        const [prefs, registry] = await Promise.all([getPrefs(), getContentBaseRegistry()]);

        const resolved = await resolveContentPrefix({}, prefs, capture, registry);
        const coreFallback = resolveContentCore(prefs, capture, registry);
        let contentCounts = await fetchContentCountsForResolved(resolved);

        let previewResolved = resolved || coreFallback;
        if (
          !contentCounts &&
          coreFallback &&
          !resolvedPreviewEquals(resolved, coreFallback)
        ) {
          const alt = await fetchContentCountsForResolved(coreFallback);
          if (alt) {
            contentCounts = alt;
            previewResolved = coreFallback;
          }
        }
        if (!previewResolved) previewResolved = coreFallback;

        const contentBasesUi = augmentBasesForPopup(registry, prefs, resolved);

        const derivedUi = deriveCourseModuleForLegacy(prefs, capture);
        const heardSum = heardSessionSummary(capture);

        const rawActForHeard = typeof capture?.activityId === "string" ? capture.activityId : "";
        let heardCurrentModuleOut = "";
        if (rawActForHeard && !isLikelySupplementaryActivityId(rawActForHeard)) {
          const ahH = parseActivityIdHints(rawActForHeard);
          heardCurrentModuleOut = nonEmptyModuleId(ahH.moduleId);
        }
        if (!heardCurrentModuleOut) {
          heardCurrentModuleOut =
            heardSum.numericHint || heardCurrentModuleFromCapture(capture) || "";
        }

        let bundleSourceUrls = bundleSourceUrlsForResolved(previewResolved);
        let bundleUrlModeOut = previewResolved?.mode ?? null;

        if (contentCounts && !bundleSourceUrls) {

          const pr2 = previewResolved || coreFallback || resolveContentCore(prefs, capture, registry);

          bundleSourceUrls = bundleSourceUrlsForResolved(pr2);

          bundleUrlModeOut = pr2?.mode ?? null;

        }

        sendResponse({
          ok: true,
          capture,
          prefs,
          contentBases: contentBasesUi,
          contentBasesListenerOnly: registry.length,
          contentCounts,
          resolvedMode: resolved?.mode ?? null,
          bundleUrlMode: bundleUrlModeOut,
          bundleSourceUrls,
          derivedLesson: derivedUi,
          moduleTargets: derivedUi.moduleList || [],
          heardCurrentModule: heardCurrentModuleOut,
          heardSessionLine: heardSum.line,
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg?.type === "SET_PREFS") {
    void (async () => {
      try {
        const patch = { ...(msg.prefs || {}) };
        if (patch.selectedContentPrefix != null && patch.selectedContentPrefix !== "") {
          patch.selectedContentPrefix = normalizeContentPrefix(patch.selectedContentPrefix);
        }
        await setPrefs(patch);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg?.type === "POST_PROGRESS") {
    void (async () => {
      try {
        const patch = {};
        if (Object.prototype.hasOwnProperty.call(msg, "courseSlug")) {
          const t = String(msg.courseSlug ?? "").trim();
          if (t) patch.courseSlug = t;
        }
        if (Object.keys(patch).length) await setPrefs(patch);

        const prefs = await getPrefs();
        const launchKeysNorm = normalizeUuidList(msg.launchKeys);
        const pickedCap = await pickEffectiveCapture(launchKeysNorm);
        const capture =
          msg.capture && typeof msg.capture === "object" && hasCompleteAdlCapture(msg.capture)
            ? msg.capture
            : pickedCap.capture;
        const registry = await getContentBaseRegistry();

        const explicit = normalizeContentPrefix(msg.contentPrefix || prefs.selectedContentPrefix);

        if (explicit) {
          const result = await postProgress({
            resolved: { mode: "prefix", prefix: explicit },
            capture,
          });
          sendResponse({
            ok: true,
            result,
            batchResults: [{ tag: "prefix", ok: result.ok, status: result.status }],
            moduleTargets: [],
          });
          return;
        }

        const derived = deriveCourseModuleForLegacy(prefs, capture);
        const uniq = [...new Set(derived.moduleList.map((x) => String(x).trim()).filter(Boolean))];

        const modSingle = uniq[0];

        if (!derived.courseSlug || !modSingle) {
          if (registry.length >= 1) {
            const prefix = pickRegistryPrefixForCapture(capture, registry);
            const result = await postProgress({
              resolved: { mode: "prefix", prefix },
              capture,
            });
            sendResponse({
              ok: true,
              result,
              batchResults: [{ tag: "prefix", ok: result.ok, status: result.status }],
              moduleTargets: [],
            });
            return;
          }
          throw new Error(
            "无法从当前会话推断课件：请先打开一页正课再发送；若为补充小节，请先回到对应正课。"
          );
        }

        const locale = prefs.locale || DEFAULT_PREFS.locale;

        const result = await postProgress({
          resolved: {
            mode: "legacy",
            courseSlug: derived.courseSlug,
            moduleId: modSingle,
            locale,
          },
          capture,
        });

        sendResponse({
          ok: true,
          result,
          batchResults: [{ mod: modSingle, ok: result.ok, status: result.status }],
          moduleTargets: [modSingle],
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  return false;
});

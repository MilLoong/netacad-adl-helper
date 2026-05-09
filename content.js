"use strict";

/** 页面浮层 */

(function injectAdlProgressPanelHost() {
  if (!chrome?.runtime?.id) return;

  if (window !== window.top) return;

  const PANEL_ID = "netacad-adl-helper-panel";

  /** FAB 路由匹配 */
  function netacadLessonFabUrlMatch(href) {
    try {
      const u = new URL(href);
      const host = u.hostname.toLowerCase();
      if (!host.endsWith("netacad.com")) return false;
      if (host === "content.netacad.com") return false;

      const pl = (u.pathname || "").toLowerCase();
      if (
        /(^|\/)(login|signin|signup|register|password-reset|logout|oauth|authorize)(\/|$)/i.test(pl)
      ) {
        return false;
      }

      let h = (u.hash || "").replace(/^#/, "");
      if (h.includes("%")) {
        try {
          h = decodeURIComponent(h);
        } catch (_) {}
      }
      const blob = `${u.pathname}/${h}`.replace(/\/+/g, "/").toLowerCase();

      const strongCourse =
        pl.includes("/courses/") ||
        pl.includes("/learn/") ||
        pl === "/launch" ||
        pl.startsWith("/launch/") ||
        blob.includes("/courses/content/") ||
        blob.includes("courses/content");

      const shellPrefixes = [
        "/dashboard",
        "/home",
        "/profile",
        "/settings",
        "/account",
        "/messages",
        "/notifications",
        "/help",
        "/support",
        "/community",
        "/search",
      ];
      const onShell = shellPrefixes.some((p) => pl === p || pl.startsWith(p + "/"));
      if (onShell && !strongCourse) return false;

      if ((pl === "/" || pl === "") && !strongCourse) return false;

      const weakCourse =
        pl.includes("/launcher") ||
        (pl.includes("/portal/") &&
          /(course|learn|lesson|module|activity|assignment|launch|player)/i.test(blob)) ||
        /\/(player|lesson|assignment)\b/i.test(blob);

      return strongCourse || weakCourse;
    } catch (_) {
      return false;
    }
  }

  function destroyPanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  function mountPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    const fab = document.createElement("button");
    fab.type = "button";
    fab.className = "netacad-adl-fab";
    fab.title = "展开 NetAcad 学习进度助手";
    fab.setAttribute("aria-label", "展开学习进度助手");
    fab.setAttribute("aria-expanded", "false");
    fab.textContent = "发";

    const card = document.createElement("div");
    card.className = "netacad-adl-card";

    const head = document.createElement("div");
    head.className = "netacad-adl-head";

    const headTitle = document.createElement("span");
    headTitle.className = "netacad-adl-head-title";
    headTitle.textContent = "NetAcad 学习进度助手";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "netacad-adl-close";
    closeBtn.title = "收起";
    closeBtn.textContent = "×";

    head.appendChild(headTitle);
    head.appendChild(closeBtn);

    const bodyEl = document.createElement("div");
    bodyEl.className = "netacad-adl-body";

    const sec1 = document.createElement("div");
    sec1.className = "netacad-adl-section";

    const h32 = document.createElement("div");
    h32.className = "netacad-adl-section-title";
    h32.textContent = "课程与模块";

    const lb1 = document.createElement("label");
    lb1.className = "netacad-adl-field";
    const lb1s = document.createElement("span");
    lb1s.textContent = "课程";
    const courseIn = document.createElement("input");
    courseIn.type = "text";
    courseIn.readOnly = true;
    courseIn.tabIndex = -1;
    courseIn.id = "netacad-adl-courseSlug";
    courseIn.placeholder = "尚未从页面检测到";
    lb1.appendChild(lb1s);
    lb1.appendChild(courseIn);

    const lb2 = document.createElement("label");
    lb2.className = "netacad-adl-field";
    const lb2s = document.createElement("span");
    lb2s.textContent = "当前模块";
    const modIn = document.createElement("input");
    modIn.type = "text";
    modIn.readOnly = true;
    modIn.tabIndex = -1;
    modIn.id = "netacad-adl-heardModule";
    modIn.placeholder = "尚未从页面检测到";
    lb2.appendChild(lb2s);
    lb2.appendChild(modIn);

    const tip = document.createElement("div");
    tip.className = "netacad-adl-tip";
    tip.innerHTML = `<ul class="netacad-adl-tip-list">
<li>发送进度 <strong>每次只提交当前这一次会话</strong> 对应的课件</li>
<li>发送前请在下方 <strong>展开查看监听参数</strong> 里核对 <strong>json网址</strong> 是否与当前课程一致</li>
<li>若仍没有所需数据或未对齐，请先点击下方的 <strong>刷新</strong> 按钮再试</li>
<li>若仍然没有，请 <strong>刷新本页网页</strong> 后再试</li>
</ul>`;

    const btnRow = document.createElement("div");
    btnRow.className = "netacad-adl-btn-row";

    const btnRefresh = document.createElement("button");
    btnRefresh.type = "button";
    btnRefresh.className = "netacad-adl-btn netacad-adl-btn--secondary";
    btnRefresh.textContent = "刷新";
    btnRefresh.title = "按 Cookie adlsession 与页面 launchKey 对齐当前 ADL";

    const btnSend = document.createElement("button");
    btnSend.type = "button";
    btnSend.className = "netacad-adl-btn netacad-adl-btn--primary";
    btnSend.textContent = "发送进度";

    btnRow.appendChild(btnRefresh);
    btnRow.appendChild(btnSend);

    sec1.appendChild(h32);
    sec1.appendChild(lb1);
    sec1.appendChild(lb2);
    sec1.appendChild(tip);
    sec1.appendChild(btnRow);

    const sec2 = document.createElement("div");
    sec2.className = "netacad-adl-section";
    const h33 = document.createElement("div");
    h33.className = "netacad-adl-section-title";
    h33.textContent = "状态";
    const ln1 = document.createElement("p");
    ln1.id = "netacad-adl-lessonLine";
    ln1.className = "netacad-adl-status";
    ln1.setAttribute("aria-live", "polite");
    const ln2 = document.createElement("p");
    ln2.id = "netacad-adl-syncLine";
    ln2.className = "netacad-adl-status";
    ln2.setAttribute("aria-live", "polite");
    const det = document.createElement("details");
    det.className = "netacad-adl-details";
    const summ = document.createElement("summary");
    summ.textContent = "展开查看监听参数";
    const capDetail = document.createElement("div");
    capDetail.id = "netacad-adl-captureDetail";
    capDetail.className = "netacad-adl-json-stack";
    capDetail.setAttribute("aria-live", "polite");
    det.appendChild(summ);
    det.appendChild(capDetail);
    sec2.appendChild(h33);
    sec2.appendChild(ln1);
    sec2.appendChild(ln2);
    sec2.appendChild(det);

    const toastEl = document.createElement("p");
    toastEl.id = "netacad-adl-toast";
    toastEl.className = "netacad-adl-toast";

    bodyEl.appendChild(sec1);
    bodyEl.appendChild(sec2);
    bodyEl.appendChild(toastEl);

    card.appendChild(head);
    card.appendChild(bodyEl);

    panel.appendChild(fab);
    panel.appendChild(card);
    document.documentElement.appendChild(panel);

    const reduceMotion = Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    function clearFabIntro() {
      fab.style.pointerEvents = "";
      panel.classList.remove("netacad-adl-fab-defer");
    }
    if (!reduceMotion) {
      panel.classList.add("netacad-adl-fab-defer");
      fab.style.pointerEvents = "none";
      fab.addEventListener(
        "animationend",
        (e) => {
          if (e.target !== fab || e.animationName !== "netacad-adl-fab-enter") return;
          clearFabIntro();
        },
        { passive: true }
      );
      globalThis.setTimeout(clearFabIntro, 1500);
    }

    const els = {
      toast: toastEl,
      lessonLine: ln1,
      syncLine: ln2,
      captureDetail: capDetail,
      courseSlug: courseIn,
      heardCurrentModule: modIn,
    };

    function stopBubble(ev) {
      ev.stopPropagation();
      if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
    }

    function expand(ev) {
      if (ev) {
        ev.preventDefault();
        stopBubble(ev);
      }
      clearFabIntro();
      panel.classList.add("netacad-adl-expanded");
      fab.setAttribute("aria-expanded", "true");
      void refreshProgressInto(els, { coursePageStrict: true });
    }

    function collapse(ev) {
      if (ev) {
        ev.preventDefault();
        stopBubble(ev);
      }
      panel.classList.remove("netacad-adl-expanded");
      fab.setAttribute("aria-expanded", "false");
    }

    fab.addEventListener("pointerdown", stopBubble, true);
    fab.addEventListener("mousedown", stopBubble, true);
    fab.addEventListener("click", expand, true);

    closeBtn.addEventListener("click", collapse, true);

    btnRefresh.addEventListener(
      "click",
      async (ev) => {
        ev.preventDefault();
        stopBubble(ev);
        toastEl.textContent = "同步中…";
        await flushAdlFromPerformanceIfLessonPage();
        await refreshProgressInto(els, { coursePageStrict: true });
        toastEl.textContent = "";
      },
      true
    );

    btnSend.addEventListener(
      "click",
      async (ev) => {
        ev.preventDefault();
        stopBubble(ev);
        toastEl.textContent = "请稍候…";
        const result = await submitProgressFromPanel(els);
        if (!result.ok) {
          toastEl.textContent = result.error || globalThis.MSG_NEED_REFRESH;
          return;
        }
        toastEl.textContent = "完成";
        await refreshProgressInto(els, { coursePageStrict: true });
      },
      true
    );
  }

  let pollHref = "";

  function syncPanelToLessonUrl() {
    const href = location.href;
    if (!netacadLessonFabUrlMatch(href)) {
      pollHref = href;
      destroyPanel();
      return;
    }
    pollHref = href;
    mountPanel();
  }

  syncPanelToLessonUrl();
  window.addEventListener("popstate", syncPanelToLessonUrl, true);
  window.addEventListener("hashchange", syncPanelToLessonUrl, true);
  globalThis.setInterval(() => {
    const h = location.href;
    if (h !== pollHref) syncPanelToLessonUrl();
  }, 450);
})();

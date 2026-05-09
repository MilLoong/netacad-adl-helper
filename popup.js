function $(id) {
  return document.getElementById(id);
}

function setToast(text) {
  $("toast").textContent = text || "";
}

function panelEls() {
  return {
    toast: $("toast"),
    lessonLine: $("lessonLine"),
    syncLine: $("syncLine"),
    captureDetail: $("captureDetail"),
    courseSlug: $("courseSlug"),
    heardCurrentModule: $("heardCurrentModule"),
  };
}

async function refresh() {
  setToast("");
  await refreshProgressInto(panelEls());
}

$("postProgress").addEventListener("click", async () => {
  setToast("请稍候…");
  const result = await submitProgressFromPanel(panelEls());
  if (!result.ok) {
    setToast(result.error || globalThis.MSG_NEED_REFRESH);
    return;
  }
  setToast("完成");
  await refresh();
});

$("refreshStatus").addEventListener("click", async () => {
  setToast("同步中…");
  await refresh();
  setToast("");
});

void refresh();

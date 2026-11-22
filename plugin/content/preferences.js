/* global Zotero, document, window */
"use strict";

var ZotMuPDFPrefs = (function () {
  const PREF_PREFIX = "extensions.zotero-mupdf-engine.";
  const DEFAULTS = {
    enabled: true,
    renderThumbnails: true,
    aaLevel: 8,
    workers: 2,
    bgWorkers: 1,
    storeMB: 96,
    pixCacheMB: 96,
    prerender: true,
    softwareCanvas: true,
    maxOutputScale: "",
    debugLog: false,
  };

  let initialized = false;
  let toastTimer = null;

  function getPref(key) {
    try {
      const v = Zotero.Prefs.get(PREF_PREFIX + key, true);
      return v === undefined || v === null ? DEFAULTS[key] : v;
    } catch {
      return DEFAULTS[key];
    }
  }

  function setPref(key, val) {
    try {
      Zotero.Prefs.set(PREF_PREFIX + key, val, true);
    } catch {}
  }

  function el(id) {
    return document.getElementById(id);
  }

  function showToast(msg, isError = false) {
    const t = el("zot-mupdf-toast");
    if (!t) return;
    t.textContent = msg;
    t.style.color = isError ? "#dc2626" : "#16a34a";
    if (toastTimer) {
      window.clearTimeout(toastTimer);
    }
    toastTimer = window.setTimeout(() => {
      toastTimer = null;
      if (t) t.textContent = "";
    }, 3500);
  }

  function ensureSelectOption(selectEl, valueStr) {
    if (!selectEl) return;
    for (const opt of Array.from(selectEl.options || [])) {
      if (opt.value === valueStr) {
        selectEl.value = valueStr;
        return;
      }
    }
    const custom = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
    custom.value = valueStr;
    custom.textContent = `${valueStr}（自定义）`;
    selectEl.appendChild(custom);
    selectEl.value = valueStr;
  }

  function loadValuesIntoUI() {
    const boolKeys = ["enabled", "renderThumbnails", "softwareCanvas", "prerender", "debugLog"];
    for (const k of boolKeys) {
      const cb = el("zot-mupdf-" + k);
      if (cb) cb.checked = !!getPref(k);
    }

    const numSelectKeys = ["aaLevel", "workers", "bgWorkers", "pixCacheMB", "storeMB"];
    for (const k of numSelectKeys) {
      ensureSelectOption(el("zot-mupdf-" + k), String(getPref(k)));
    }

    ensureSelectOption(el("zot-mupdf-maxOutputScale"), String(getPref("maxOutputScale") || ""));
    updateBgWorkersDisabled();
  }

  function updateBgWorkersDisabled() {
    const preCb = el("zot-mupdf-prerender");
    const bgSel = el("zot-mupdf-bgWorkers");
    if (preCb && bgSel) {
      bgSel.disabled = !preCb.checked;
    }
  }

  function fmtMs(v) {
    if (!Number.isFinite(v)) return "0";
    return v < 10 ? v.toFixed(1) : String(Math.round(v));
  }

  function refreshStatus() {
    const dot = el("zot-mupdf-status-dot");
    const title = el("zot-mupdf-status-title");
    const detail = el("zot-mupdf-status-detail");
    if (!dot || !title || !detail) return;

    const plugin = Zotero.ZotMuPDF;
    if (!plugin || !plugin.engineClient) {
      dot.style.backgroundColor = "#9ca3af";
      title.textContent = "Zotero MuPDF Engine 未启动";
      detail.textContent = "插件尚未完成初始化。";
      return;
    }

    const s = plugin.engineClient.getSummary();
    if (!s.enabled) {
      dot.style.backgroundColor = "#9ca3af";
      title.textContent = `已暂停（当前使用原生 PDF.js · v${plugin.version || ""}）`;
    } else if (s.lastError && !s.ready) {
      dot.style.backgroundColor = "#dc2626";
      title.textContent = `启动失败（已回退原生 PDF.js）`;
    } else if (s.ready) {
      dot.style.backgroundColor = "#16a34a";
      title.textContent = `运行中 · MuPDF ${s.mupdfVersion || "1.28.0"} 进程内无锁原生库（${s.workers} 线程 · v${plugin.version || ""}）`;
    } else {
      dot.style.backgroundColor = "#eab308";
      title.textContent = `就绪待命（打开任意 PDF 自动激活 · v${plugin.version || ""}）`;
    }

    const lines = [];
    if (s.totalRenders > 0) {
      const pixPct = Math.round((s.pixHits / s.totalRenders) * 100);
      lines.push(
        `已渲染 ${s.totalRenders} 次 | 均耗时 ${fmtMs(s.avgE2EMs || s.avgRenderMs)}ms | 预渲染位图命中 ${pixPct}% | 回退 ${s.fallbacks} 次`
      );
    } else {
      lines.push("打开任意 PDF 文档即可体验 MuPDF 硬件级加速与实时统计。");
    }
    if (s.thumbCount > 0) {
      lines.push(`侧栏缩略图加速：已渲染 ${s.thumbCount} 张（最近 ${fmtMs(s.thumbLastMs)}ms · ${s.fgWorkers || 2} 线程直出）`);
    }
    if (s.pdfjsRenders > 0) {
      lines.push(`对比原生 PDF.js 实测：均值 ${fmtMs(s.pdfjsAvgMs)}ms（${s.pdfjsRenders} 次）`);
    }
    if (s.lastError) {
      lines.push(`最近错误：${s.lastError}`);
    }
    detail.textContent = lines.join("\n");
  }

  function applyLiveVisualChange(msg) {
    const plugin = Zotero.ZotMuPDF;
    if (plugin?.readerHook) {
      plugin.readerHook.refreshAllViewers(false);
    }
    refreshStatus();
    if (msg) showToast(msg);
  }

  function bindEvents() {
    const bindBool = (key, liveRefresh, engineRestartHint) => {
      const cb = el("zot-mupdf-" + key);
      if (!cb) return;
      cb.addEventListener("command", () => {
        const val = !!cb.checked;
        if (key === "enabled" && Zotero.ZotMuPDF?.engineClient) {
          Zotero.ZotMuPDF.engineClient.setEnabled(val);
          if (val) {
            Zotero.ZotMuPDF.engineClient
              .ensureStarted()
              .then(() => applyLiveVisualChange("已启用 MuPDF 渲染加速"))
              .catch(err => {
                refreshStatus();
                showToast("启动失败：" + (err?.message || err), true);
              });
          } else {
            applyLiveVisualChange("已切换为原生 PDF.js");
          }
          return;
        }
        setPref(key, val);
        if (key === "prerender") {
          updateBgWorkersDisabled();
        }
        if (liveRefresh) {
          applyLiveVisualChange("设置已保存并立即生效");
        } else if (engineRestartHint) {
          showToast("已保存，点击“应用并重载引擎”即可立即生效");
        } else {
          showToast("设置已保存");
        }
      });
    };

    bindBool("enabled", true, false);
    bindBool("renderThumbnails", true, false);
    bindBool("softwareCanvas", true, false);
    bindBool("prerender", false, true);
    bindBool("debugLog", false, false);

    const bindNumSelect = (key, liveRefresh) => {
      const sel = el("zot-mupdf-" + key);
      if (!sel) return;
      sel.addEventListener("change", () => {
        const num = Number(sel.value);
        if (!Number.isFinite(num)) return;
        setPref(key, Math.round(num));
        if (liveRefresh) {
          applyLiveVisualChange("设置已保存并立即重绘");
        } else {
          showToast("已保存，点击“应用并重载引擎”即可立即生效");
        }
      });
    };

    bindNumSelect("aaLevel", true);
    bindNumSelect("workers", false);
    bindNumSelect("bgWorkers", false);
    bindNumSelect("pixCacheMB", false);
    bindNumSelect("storeMB", false);

    const dprSel = el("zot-mupdf-maxOutputScale");
    if (dprSel) {
      dprSel.addEventListener("change", () => {
        setPref("maxOutputScale", String(dprSel.value || ""));
        applyLiveVisualChange("高分屏 DPR 设置已保存并立即重绘");
      });
    }

    const btnTrim = el("zot-mupdf-btn-trim");
    if (btnTrim) {
      btnTrim.addEventListener("command", () => {
        const eng = Zotero.ZotMuPDF?.engineClient;
        if (eng) {
          eng.trimMemory(true);
          refreshStatus();
          showToast("已释放全部原生位图、Display List 与 Worker 缓存");
        }
      });
    }

    const btnRestart = el("zot-mupdf-btn-restart");
    if (btnRestart) {
      btnRestart.addEventListener("command", async () => {
        const plugin = Zotero.ZotMuPDF;
        if (!plugin?.engineClient) return;
        btnRestart.disabled = true;
        try {
          await plugin.engineClient.restart();
          plugin.readerHook?.refreshAllViewers(true);
          refreshStatus();
          showToast("原生引擎已按最新配置重载完成");
        } catch (err) {
          refreshStatus();
          showToast("引擎重载失败：" + (err?.message || err), true);
        } finally {
          btnRestart.disabled = false;
        }
      });
    }

    const btnReset = el("zot-mupdf-btn-reset");
    if (btnReset) {
      btnReset.addEventListener("command", async () => {
        for (const [k, v] of Object.entries(DEFAULTS)) {
          setPref(k, v);
        }
        loadValuesIntoUI();
        const plugin = Zotero.ZotMuPDF;
        if (plugin?.engineClient) {
          try {
            await plugin.engineClient.restart();
            plugin.readerHook?.refreshAllViewers(true);
          } catch {}
        }
        refreshStatus();
        showToast("已恢复全部默认推荐配置并重载引擎");
      });
    }
  }

  function init() {
    if (initialized) {
      loadValuesIntoUI();
      refreshStatus();
      return;
    }
    initialized = true;
    loadValuesIntoUI();
    bindEvents();
    refreshStatus();

    const pane = el("zot-mupdf-prefpane");
    if (pane) {
      pane.addEventListener("showing", () => {
        loadValuesIntoUI();
        refreshStatus();
      });
    }
  }

  return { init, refreshStatus };
})();

window.ZotMuPDFPrefs = ZotMuPDFPrefs;

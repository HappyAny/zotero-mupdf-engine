/* global Zotero, Services, Components, ChromeUtils, IOUtils, PathUtils */
"use strict";

var ZotMuPDFPlugin = null;
var ZotMuPDFChromeHandle = null;
var ZotMuPDFPrefPaneID = null;

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }) {
  try {
    await Zotero.initializationPromise;

    // Register chrome://zotmupdf/content/ (src/) & chrome://zotmupdfui/content/ (content/)
    // so ChromeWorker AND Zotero.PreferencePanes load cleanly even from jar: URLs containing '@'
    const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
      .getService(Components.interfaces.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(rootURI + "manifest.json");
    ZotMuPDFChromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "zotmupdf", rootURI + "src/"],
      ["content", "zotmupdfui", rootURI + "content/"],
    ]);

    const prefBranch = Services.prefs.getDefaultBranch("");
    const defaults = {
      "extensions.zotero-mupdf-engine.enabled": true,
      "extensions.zotero-mupdf-engine.renderThumbnails": true,
      "extensions.zotero-mupdf-engine.aaLevel": 8,
      "extensions.zotero-mupdf-engine.workers": 2,
      "extensions.zotero-mupdf-engine.bgWorkers": 1,
      "extensions.zotero-mupdf-engine.storeMB": 96,
      "extensions.zotero-mupdf-engine.pixCacheMB": 96,
      "extensions.zotero-mupdf-engine.prerender": true,
      "extensions.zotero-mupdf-engine.softwareCanvas": true,
      "extensions.zotero-mupdf-engine.maxOutputScale": "",
      "extensions.zotero-mupdf-engine.debugLog": false,
    };
    for (const [k, v] of Object.entries(defaults)) {
      if (typeof v === "boolean") prefBranch.setBoolPref(k, v);
      else if (typeof v === "number") prefBranch.setIntPref(k, v);
      else if (typeof v === "string") prefBranch.setStringPref(k, v);
    }

    Services.scriptloader.loadSubScript(rootURI + "src/engine-client.js", globalThis);
    Services.scriptloader.loadSubScript(rootURI + "src/reader-hook.js", globalThis);

    const engineClient = new globalThis.ZotMuPDFEngineClient.EngineClient({ rootURI, version });
    const readerHook = new globalThis.ZotMuPDFReaderHook.ReaderHook({
      pluginID: id,
      rootURI,
      engineClient,
    });

    ZotMuPDFPlugin = { engineClient, readerHook, version, rootURI };
    Zotero.ZotMuPDF = ZotMuPDFPlugin;

    await readerHook.init();

    if (Zotero.PreferencePanes && typeof Zotero.PreferencePanes.register === "function") {
      try {
        ZotMuPDFPrefPaneID = await Zotero.PreferencePanes.register({
          pluginID: id,
          id: "zotero-mupdf-engine-prefpane",
          label: "MuPDF Engine",
          image: "chrome://zotmupdfui/content/icons/icon.svg",
          src: "chrome://zotmupdfui/content/preferences.xhtml",
          scripts: ["chrome://zotmupdfui/content/preferences.js"],
          stylesheets: ["chrome://zotmupdfui/content/preferences.css"],
          helpURL: "https://github.com/HappyAny/zotero-mupdf-engine",
        });
      } catch (prefErr) {
        Zotero.logError(prefErr);
      }
    }

    Zotero.debug(`[ZotMuPDF] Plugin v${version} initialized (in-process native MuPDF library)`);

    if (engineClient.isEnabled()) {
      engineClient.ensureStarted().catch(err => {
        Zotero.debug("[ZotMuPDF] Native DLL warm-up error: " + (err?.message || String(err)));
      });
    }
  } catch (err) {
    Zotero.logError("[ZotMuPDF] startup failed:");
    Zotero.logError(err);
  }
}

function onMainWindowLoad() {
  ZotMuPDFPlugin?.readerHook?._scanAllReaders?.();
}

function onMainWindowUnload() {}

async function shutdown() {
  if (ZotMuPDFPrefPaneID) {
    try {
      Zotero.PreferencePanes?.unregister?.(ZotMuPDFPrefPaneID);
    } catch {}
    ZotMuPDFPrefPaneID = null;
  }
  if (ZotMuPDFPlugin) {
    const plugin = ZotMuPDFPlugin;
    ZotMuPDFPlugin = null;
    if (Zotero.ZotMuPDF === plugin) {
      delete Zotero.ZotMuPDF;
    }
    try {
      plugin.readerHook?.shutdown();
    } catch (e) {
      Zotero.logError(e);
    }
    try {
      await plugin.engineClient?.shutdown();
    } catch (e) {
      Zotero.logError(e);
    }
  }
  if (ZotMuPDFChromeHandle) {
    try {
      ZotMuPDFChromeHandle.destruct();
    } catch {}
    ZotMuPDFChromeHandle = null;
  }
  globalThis.ZotMuPDFEngineClient = undefined;
  globalThis.ZotMuPDFReaderHook = undefined;
}

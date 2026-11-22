/* global Zotero, Services, Components, ChromeUtils, IOUtils, PathUtils */
"use strict";

var ZotMuPDFPlugin = null;
var ZotMuPDFChromeHandle = null;

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }) {
  try {
    await Zotero.initializationPromise;

    // Register chrome://zotmupdf/content/ so ChromeWorker loads cleanly even from jar: URLs containing '@'
    const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
      .getService(Components.interfaces.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(rootURI + "manifest.json");
    ZotMuPDFChromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "zotmupdf", rootURI + "src/"],
    ]);

    const prefBranch = Services.prefs.getDefaultBranch("");
    const defaults = {
      "extensions.zotero-mupdf-engine.enabled": true,
      "extensions.zotero-mupdf-engine.renderThumbnails": true,
      "extensions.zotero-mupdf-engine.aaLevel": 8,
      "extensions.zotero-mupdf-engine.workers": 3,
      "extensions.zotero-mupdf-engine.bgWorkers": 2,
      "extensions.zotero-mupdf-engine.storeMB": 256,
      "extensions.zotero-mupdf-engine.pixCacheMB": 512,
      "extensions.zotero-mupdf-engine.prerender": true,
      "extensions.zotero-mupdf-engine.softwareCanvas": true,
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
    Zotero.debug(`[ZotMuPDF] Plugin v${version} initialized (in-process native MuPDF DLL)`);

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

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PLUGIN_DIR = path.join(ROOT, "plugin");

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
}

// 1. Verify manifest.json, syntax of all 5 plugin JS files, and Zotero 10 _loadScope startup/shutdown
async function verifySyntaxAndBootstrap() {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "manifest.json"), "utf8"));
  assert(manifest.manifest_version === 2, "manifest_version must be 2");
  assert(manifest.applications?.zotero?.id, "applications.zotero.id is required by Zotero 10");
  assert(
    typeof manifest.applications?.zotero?.update_url === "string" &&
      manifest.applications.zotero.update_url.startsWith("https://"),
    "applications.zotero.update_url (https://) is required by Zotero 10"
  );
  assert(manifest.applications?.zotero?.strict_max_version === "10.*", "must support Zotero 10.*");

  const jsFiles = [
    "bootstrap.js",
    "src/engine-client.js",
    "src/reader-hook.js",
    "src/page-patch.js",
    "src/render-worker.js",
  ];
  for (const rel of jsFiles) {
    const src = fs.readFileSync(path.join(PLUGIN_DIR, rel), "utf8");
    new vm.Script(src, { filename: rel });
  }

  const fakePrefs = new Map();
  let registeredToolbarCb = null;
  let chromeRegistered = false;
  let chromeDestructed = false;
  let loggedErrors = [];

  const fakeGlobal = {
    Zotero: {
      initializationPromise: Promise.resolve(),
      debug() {},
      logError(e) { loggedErrors.push(e); },
      Prefs: {
        get(k) { return fakePrefs.get(k); },
        set(k, v) { fakePrefs.set(k, v); },
      },
      File: {
        async getResourceAsync(uri) {
          assert(uri.endsWith("src/page-patch.js"), "unexpected getResourceAsync uri: " + uri);
          return fs.readFileSync(path.join(PLUGIN_DIR, "src/page-patch.js"), "utf8");
        },
      },
      Reader: {
        _readers: [],
        registerEventListener(type, fn) {
          if (type === "renderToolbar") registeredToolbarCb = fn;
        },
        async open() { return null; },
        async openPreview() { return null; },
      },
      Notifier: {
        registerObserver() { return 1; },
        unregisterObserver() {},
      },
      getMainWindow() { return null; },
      Profile: { dir: "C:\\tmp" },
    },
    Services: {
      io: { newURI: u => ({ spec: u }) },
      prefs: {
        getDefaultBranch() {
          return {
            setBoolPref(k, v) { fakePrefs.set(k, v); },
            setIntPref(k, v) { fakePrefs.set(k, v); },
            setStringPref(k, v) { fakePrefs.set(k, v); },
          };
        },
      },
      scriptloader: {
        loadSubScript(uri) {
          const rel = uri.replace(/^jar:file:\/\/\/test@local\.xpi!\//, "");
          const src = fs.readFileSync(path.join(PLUGIN_DIR, rel), "utf8");
          vm.runInContext(src, ctx, { filename: rel });
        },
      },
      wm: { getMostRecentWindow() { return null; } },
    },
    Components: {
      classes: {
        "@mozilla.org/addons/addon-manager-startup;1": {
          getService() {
            return {
              registerChrome(_uri, entries) {
                chromeRegistered = entries.some(e => e[0] === "content" && e[1] === "zotmupdf");
                return { destruct() { chromeDestructed = true; } };
              },
            };
          },
        },
      },
      interfaces: { amIAddonManagerStartup: {} },
      utils: {},
      isSuccessCode: () => true,
    },
    ChromeUtils: {
      importESModule(uri) {
        if (uri.includes("Timer.sys.mjs")) return { setTimeout, clearTimeout };
        return {};
      },
    },
    ChromeWorker: class MockChromeWorker {},
    IOUtils: {},
    PathUtils: { join: (...p) => p.join("\\") },
    setTimeout,
    clearTimeout,
    console,
  };
  const ctx = vm.createContext(fakeGlobal);
  vm.runInContext(fs.readFileSync(path.join(PLUGIN_DIR, "bootstrap.js"), "utf8"), ctx, { filename: "bootstrap.js" });
  fakePrefs.set("extensions.zotero-mupdf-engine.enabled", false);

  await ctx.startup({
    id: "zotero-mupdf-engine@happyany.local",
    version: manifest.version,
    rootURI: "jar:file:///test@local.xpi!/",
  });
  assert(loggedErrors.length === 0, "Unexpected startup errors: " + loggedErrors.map(String).join("; "));
  assert(chromeRegistered, "chrome://zotmupdf/content/ must be registered for ChromeWorker");
  assert(typeof registeredToolbarCb === "function", "renderToolbar listener was NOT registered!");
  assert(fakePrefs.get("extensions.zotero-mupdf-engine.workers") === 2, "v0.7.0 default workers must be 2");
  assert(fakePrefs.get("extensions.zotero-mupdf-engine.bgWorkers") === 1, "v0.7.0 default bgWorkers must be 1");
  assert(fakePrefs.get("extensions.zotero-mupdf-engine.storeMB") === 96, "v0.7.0 default storeMB must be 96");
  assert(fakePrefs.get("extensions.zotero-mupdf-engine.pixCacheMB") === 128, "v0.7.0 default pixCacheMB must be 128");
  await ctx.shutdown();
  assert(chromeDestructed, "chromeHandle.destruct() must run on shutdown");
  console.log("[check 1] manifest.json, 5 JS files syntax, v0.7.0 lean defaults & Zotero 10 startup/shutdown OK!");
}

// Exact copy of Zotero 10.0.8 pdf.mjs PageViewport constructor
function makePageViewport({ viewBox, userUnit = 1, scale, rotation = 0, offsetX = 0, offsetY = 0, dontFlip = false }) {
  const s = scale * userUnit;
  const centerX = (viewBox[2] + viewBox[0]) / 2;
  const centerY = (viewBox[3] + viewBox[1]) / 2;
  let rot = rotation % 360;
  if (rot < 0) rot += 360;
  let rA, rB, rC, rD;
  switch (rot) {
    case 180: rA = -1; rB = 0; rC = 0; rD = 1; break;
    case 90:  rA = 0;  rB = 1; rC = 1; rD = 0; break;
    case 270: rA = 0;  rB = -1; rC = -1; rD = 0; break;
    case 0:   rA = 1;  rB = 0; rC = 0; rD = -1; break;
    default: throw new Error("bad rotation");
  }
  if (dontFlip) { rC = -rC; rD = -rD; }
  let ox, oy, width, height;
  if (rA === 0) {
    ox = Math.abs(centerY - viewBox[1]) * s + offsetX;
    oy = Math.abs(centerX - viewBox[0]) * s + offsetY;
    width = (viewBox[3] - viewBox[1]) * s;
    height = (viewBox[2] - viewBox[0]) * s;
  } else {
    ox = Math.abs(centerX - viewBox[0]) * s + offsetX;
    oy = Math.abs(centerY - viewBox[1]) * s + offsetY;
    width = (viewBox[2] - viewBox[0]) * s;
    height = (viewBox[3] - viewBox[1]) * s;
  }
  const transform = [
    rA * s,
    rB * s,
    rC * s,
    rD * s,
    ox - rA * s * centerX - rC * s * centerY,
    oy - rB * s * centerX - rD * s * centerY,
  ];
  return { viewBox, userUnit, scale, rotation: rot, offsetX, offsetY, width, height, transform };
}

function apply2D(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function utilTransform(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

// 2. Verify page-patch.js direct Chrome paint, fallback RGBA, queue unblocking, getProcessedData prefetch, geometry math, cancel, and uninstall
async function verifyPagePatchZeroCopy() {
  let enabled = true;
  let forceBridgeError = false;
  let useFallbackRgba = false;
  let capturedPayloads = [];
  let fallbackReasons = [];
  let origRenderCalls = 0;
  let pdfjsTimings = [];
  let mupdfPaints = [];
  let textLayerTimings = [];
  let queueKickCount = 0;
  let getPageCalls = [];
  let getProcessedDataCalls = 0;

  class RenderingCancelledException extends Error {
    constructor(msg, type) {
      super(msg);
      this.name = "RenderingCancelledException";
      this.type = type;
    }
  }

  class MockImageData {
    constructor(data, width, height) {
      assert(data instanceof Uint8ClampedArray, "ImageData expects Uint8ClampedArray");
      assert(data.byteLength === width * height * 4, "ImageData byteLength mismatch");
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }

  class MockPDFPageProxy {
    constructor(pageIndex, { view = [0, 0, 595.276, 841.89], rotate = 0, userUnit = 1 } = {}) {
      this._pageIndex = pageIndex;
      this.pageNumber = pageIndex + 1;
      this.view = view;
      this.rotate = rotate;
      this.userUnit = userUnit;
    }
    getViewport({ scale, rotation = this.rotate, offsetX = 0, offsetY = 0, dontFlip = false }) {
      return makePageViewport({ viewBox: this.view, userUnit: this.userUnit, scale, rotation, offsetX, offsetY, dontFlip });
    }
    render() {
      origRenderCalls++;
      return {
        promise: Promise.resolve("orig-pdfjs-render"),
        cancel() {},
        separateAnnots: false,
      };
    }
  }

  class MockPDFDocumentProxy {
    constructor() {
      this.numPages = 20;
    }
    getPage(pageNumber) {
      getPageCalls.push(pageNumber);
      return Promise.resolve(new MockPDFPageProxy(pageNumber - 1));
    }
    getProcessedData() {
      getProcessedDataCalls++;
      return Promise.resolve({ pages: {} });
    }
  }

  const busListeners = new Map();
  const eventBus = {
    on(ev, fn) {
      if (!busListeners.has(ev)) busListeners.set(ev, new Set());
      busListeners.get(ev).add(fn);
    },
    off(ev, fn) {
      busListeners.get(ev)?.delete(fn);
    },
    dispatch(ev, data) {
      for (const fn of busListeners.get(ev) || []) fn(data);
    },
  };

  const mockPages = [1, 2, 3, 4, 5, 6].map(id => ({ id, finished: id === 3 || id === 4 }));
  const mockDoc = new MockPDFDocumentProxy();
  const viewerApp = {
    open() {
      this.pdfDocument = mockDoc;
      eventBus.dispatch("documentloaded");
      return Promise.resolve();
    },
    eventBus,
    pdfDocument: null,
    pdfViewer: { _pages: mockPages, update() {} },
    pdfRenderingQueue: {
      isViewFinished(v) {
        return !!v.finished;
      },
      getHighestPriority() {
        return null; // Simulate visible + (+1) already finished
      },
      renderHighestPriority() {
        queueKickCount++;
      },
    },
  };

  const sandbox = {
    window: null,
    Uint8ClampedArray,
    Uint8Array,
    ArrayBuffer,
    ImageData: MockImageData,
    Promise,
    JSON,
    Number,
    Math,
    Object,
    Array,
    Map,
    String,
    Error,
    performance,
    setTimeout,
    clearTimeout,
    pdfjsLib: { RenderingCancelledException, Util: { transform: utilTransform } },
    PDFViewerApplication: viewerApp,
    theme: null,
    __zotMuPDFBridge: {
      isEnabled: () => enabled,
      getConfig: () => ({ renderThumbnails: true, aaLevel: 8, debugLog: false }),
      setPassword: () => {},
      cancelRequest: () => {},
      reportFallback: reason => fallbackReasons.push(reason),
      reportMuPDFPaint: (e2e, paint, mode, isMain) => mupdfPaints.push({ e2e, paint, mode, isMain }),
      reportTextLayerTiming: ms => textLayerTimings.push(ms),
      reportPdfJsTiming: ms => pdfjsTimings.push(ms),
      renderPage: (reqJSON, targetCanvas, _providedCtx, isCancelledFn, onPainted, onFallbackRgba, onError) => {
        const parsed = JSON.parse(reqJSON);
        capturedPayloads.push(parsed);
        if (forceBridgeError) {
          setTimeout(() => onError("simulated-error", false), 5);
          return;
        }
        setTimeout(() => {
          if (isCancelledFn()) return;
          if (useFallbackRgba) {
            const u8 = new Uint8Array(parsed.width * parsed.height * 4);
            onFallbackRgba(u8, parsed.width, parsed.height, 1.5);
          } else {
            // Simulate direct Chrome-side zero-copy paint onto targetCanvas
            targetCanvas.getContext("2d").putImageData(
              new MockImageData(new Uint8ClampedArray(parsed.width * parsed.height * 4), parsed.width, parsed.height),
              0,
              0
            );
            onPainted(2.1, "bitmap");
          }
        }, 2);
      },
    },
  };
  sandbox.window = sandbox;

  const patchSrc = fs.readFileSync(path.join(PLUGIN_DIR, "src/page-patch.js"), "utf8");
  vm.runInNewContext(patchSrc, sandbox, { filename: "page-patch.js" });

  await viewerApp.open({ url: "zotero://attachment/test", password: "" });
  const page = await viewerApp.pdfDocument.getPage(1);

  let lastPut = null;
  const makeCanvas = (w, h, skipBlender = false) => ({
    width: w,
    height: h,
    getContext() {
      return {
        skipBlender,
        putImageData(imgData, x, y) {
          lastPut = { imgData, x, y };
        },
      };
    },
  });

  // 2a. Direct Chrome-side paint + fallback RGBA paint
  const vp = page.getViewport({ scale: 1.5 });
  const c1 = makeCanvas(Math.round(vp.width * 1.25), Math.round(vp.height * 1.25));
  await page.render({ canvas: c1, viewport: vp, transform: [1.25, 0, 0, 1.25, 0, 0], annotationMode: 1 }).promise;
  assert(lastPut && lastPut.imgData.width === c1.width && lastPut.imgData.height === c1.height, "direct paint failed");
  assert(mupdfPaints.length === 1 && mupdfPaints[0].mode === "bitmap" && mupdfPaints[0].isMain === true, "reportMuPDFPaint direct failed");
  assert(origRenderCalls === 0, "origRender should not be called");

  useFallbackRgba = true;
  await page.render({ canvas: c1, viewport: vp, transform: [1.25, 0, 0, 1.25, 0, 0], annotationMode: 1 }).promise;
  assert(mupdfPaints.length === 2 && mupdfPaints[1].mode === "clone", "fallback RGBA paint failed");
  useFallbackRgba = false;

  // 2a2. Queue unblocking on pagerendered + textlayerrendered timing (without fighting Zotero's _trimPageBuffer!)
  eventBus.dispatch("pagerendered", { pageNumber: 1, error: null, cssTransform: false, isDetailView: false });
  await Promise.resolve();
  assert(queueKickCount === 1, "pagerendered must immediately kick pdfRenderingQueue.renderHighestPriority()");
  eventBus.dispatch("textlayerrendered", { pageNumber: 1 });
  assert(textLayerTimings.length === 1, "textlayerrendered timing must be reported");

  // getHighestPriority must stay untouched so Zotero's _trimPageBuffer/trimMemory never fights extra DOM canvases
  const vis3 = { first: { id: 3 }, last: { id: 3 }, views: [{ view: mockPages[2] }], ids: new Set([3]) };
  assert(
    viewerApp.pdfRenderingQueue.getHighestPriority(vis3, mockPages, true, false, false) === null,
    "getHighestPriority must stay native (no +2/-1 DOM canvas bloat)"
  );

  // 2a3. getProcessedData must prefetch getPage(2..6) ONLY (lean cap, not 32!) BEFORE calling origGetProcessedData
  getPageCalls.length = 0;
  await viewerApp.pdfDocument.getProcessedData();
  assert(getProcessedDataCalls === 1, "origGetProcessedData must still run");
  assert(
    getPageCalls.includes(2) && getPageCalls.includes(6) && !getPageCalls.includes(7),
    "getProcessedData must prefetch getPage(2..6) only, got: " + getPageCalls.join(",")
  );

  // 2b. Coordinate math check across rotated/cropped/zoomed-tile/UserUnit
  const testCases = [
    { view: [0, 0, 595, 842], rotate: 0, userRot: 0, scale: 1.5, out: [1.25, 0, 0, 1.25, 0, 0], ox: 0, oy: 0, uu: 1 },
    { view: [72, 36, 612, 792], rotate: 0, userRot: 90, scale: 2.0, out: [1.5, 0, 0, 1.5, -200, -150], ox: 0, oy: 0, uu: 1 },
    { view: [50, 50, 500, 700], rotate: 90, userRot: 180, scale: 1.33, out: [1.248, 0, 0, 1.251, 0, 0], ox: -30, oy: -40, uu: 1 },
    { view: [-20, -10, 600, 800], rotate: 270, userRot: 270, scale: 0.8, out: null, ox: -120, oy: -230, uu: 2 },
  ];
  for (const tc of testCases) {
    const pGeom = new MockPDFPageProxy(0, { view: tc.view, rotate: tc.rotate, userUnit: tc.uu });
    const baseVp = pGeom.getViewport({ scale: 1 });
    const reqVp = pGeom.getViewport({ scale: tc.scale, rotation: tc.userRot, offsetX: tc.ox, offsetY: tc.oy });
    capturedPayloads.length = 0;
    await pGeom.render({ canvas: makeCanvas(200, 200), viewport: reqVp, transform: tc.out }).promise;
    const muM = capturedPayloads[0].matrix;
    const totalT = tc.out ? utilTransform(tc.out, reqVp.transform) : reqVp.transform;
    for (const [px, py] of [[tc.view[0], tc.view[1]], [tc.view[2], tc.view[3]]]) {
      const [muX, muY] = apply2D(baseVp.transform, px, py);
      const [gotX, gotY] = apply2D(muM, muX, muY);
      const [expX, expY] = apply2D(totalT, px, py);
      assert(Math.abs(gotX - expX) < 1e-4 && Math.abs(gotY - expY) < 1e-4, "Coordinate mismatch");
    }
  }
  console.log("[check 2] Sub-pixel coordinate alignment, queue unblocking, and getProcessedData prefetch verified");

  // 2c. Cancel, fallback, print bypass, PDF.js timing when disabled, and clean uninstall
  let onErrCancel = false;
  const ct = page.render({ canvas: makeCanvas(400, 500), viewport: vp });
  ct.onError = e => { onErrCancel = e instanceof RenderingCancelledException; };
  ct.cancel();
  let caughtCancel = false;
  try { await ct.promise; } catch (e) { caughtCancel = e instanceof RenderingCancelledException; }
  assert(caughtCancel && onErrCancel, "cancel must throw RenderingCancelledException");

  forceBridgeError = true;
  const fb = await page.render({ canvas: makeCanvas(300, 400), viewport: vp }).promise;
  assert(fb === "orig-pdfjs-render" && fallbackReasons.includes("simulated-error"), "fallback failed");
  forceBridgeError = false;

  enabled = false;
  const beforeDisabled = pdfjsTimings.length;
  await page.render({ canvas: makeCanvas(300, 400), viewport: vp }).promise;
  assert(pdfjsTimings.length === beforeDisabled + 1, "PDF.js timing must be recorded when disabled");

  const savedBridge = sandbox.__zotMuPDFBridge;
  sandbox.__zotMuPDFControl.uninstall();
  assert((busListeners.get("pagerendered")?.size || 0) === 0, "uninstall must remove pagerendered listener");
  assert((busListeners.get("textlayerrendered")?.size || 0) === 0, "uninstall must remove textlayerrendered listener");
  assert(viewerApp.pdfRenderingQueue.getHighestPriority(vis3, mockPages, true, false, false) === null, "uninstall must restore getHighestPriority");

  // 2d. Regression test: injecting page-patch.js BEFORE window.PDFViewerApplication is defined (new tab race!)
  enabled = true;
  const lateSandbox = {
    ...sandbox,
    __zotMuPDFBridge: savedBridge,
    PDFViewerApplication: undefined,
  };
  lateSandbox.window = lateSandbox;
  vm.runInNewContext(patchSrc, lateSandbox, { filename: "page-patch-late.js" });
  const lateApp = {
    open() {
      this.pdfDocument = new MockPDFDocumentProxy();
      return Promise.resolve();
    },
    eventBus: { on() {}, off() {} },
    pdfDocument: new MockPDFDocumentProxy(),
    pdfViewer: { _pages: [], update() {} },
    pdfRenderingQueue: { isViewFinished: () => false, getHighestPriority: () => null, renderHighestPriority() {} },
  };
  lateSandbox.PDFViewerApplication = lateApp;
  await new Promise(r => setTimeout(r, 60));
  const latePage = await lateApp.pdfDocument.getPage(1);
  mupdfPaints.length = 0;
  await latePage.render({ canvas: makeCanvas(600, 800), viewport: latePage.getViewport({ scale: 1.5 }) }).promise;
  assert(mupdfPaints.length === 1, "late PDFViewerApplication attach race must still hook PDFPageProxy.prototype.render");
  lateSandbox.__zotMuPDFControl.uninstall();

  console.log("[check 3] Direct paint, fallback RGBA, lean prefetch, late-attach race fix, cancel, timing, and clean uninstall ALL PASSED!");
}

// 3. Regression test: closing a PDF tab MUST release thumbHooks, viewerEntries, and evict native path cache!
async function verifyTabCloseZeroLeak() {
  let evictedPaths = [];
  let notifierObs = null;

  const fakeGlobal = {
    Zotero: {
      debug() {},
      logError(e) { throw e; },
      Prefs: { get: () => true, set() {} },
      File: {
        async getResourceAsync() {
          return fs.readFileSync(path.join(PLUGIN_DIR, "src/page-patch.js"), "utf8");
        },
      },
      Reader: {
        _readers: [],
        registerEventListener() {},
        async open() { return null; },
        async openPreview() { return null; },
      },
      Notifier: {
        registerObserver(obs) {
          notifierObs = obs;
          return 1;
        },
        unregisterObserver() {},
      },
    },
    Services: {
      wm: { getMostRecentWindow: () => null },
    },
    Components: {
      utils: {
        exportFunction: fn => fn,
        cloneInto: obj => obj,
        unwaiveXrays: obj => obj,
      },
    },
    ChromeUtils: {
      importESModule(uri) {
        if (uri.includes("Timer.sys.mjs")) return { setTimeout, clearTimeout };
        return {};
      },
      now: () => performance.now(),
    },
    setTimeout,
    clearTimeout,
    console,
  };

  const ctx = vm.createContext(fakeGlobal);
  vm.runInContext(fs.readFileSync(path.join(PLUGIN_DIR, "src/reader-hook.js"), "utf8"), ctx, {
    filename: "reader-hook.js",
  });

  const mockEngine = {
    workerCount: 2,
    isEnabled: () => true,
    ensureStarted: () => Promise.resolve(),
    getSummary: () => ({ enabled: true, ready: true, totalRenders: 0, workers: 3, fgWorkers: 2 }),
    getConfig: () => ({ renderThumbnails: true, aaLevel: 8, softwareCanvas: true }),
    onStatsChange: () => () => {},
    evictPath: p => evictedPaths.push(p),
    log() {},
  };

  const hook = new ctx.ZotMuPDFReaderHook.ReaderHook({
    pluginID: "zotero-mupdf-engine@happyany.local",
    rootURI: "jar:file:///test@local.xpi!/",
    engineClient: mockEngine,
  });
  await hook.init();

  const origThumbRender = function origRender() {};
  const origInitThumbs = function origInit() {};
  const mockThumbs = {
    _render: origThumbRender,
    _renderQueue: { concurrency: 1 },
  };
  const mockPv = {
    _pdfThumbnails: mockThumbs,
    _initThumbnails: origInitThumbs,
  };
  let unloadCb = null;
  const mockIframeWin = {
    closed: false,
    Promise,
    document: {
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    addEventListener(ev, fn) {
      if (ev === "unload") unloadCb = fn;
    },
    removeEventListener() {},
  };
  const mockReader = {
    tabID: "tab-leak-test",
    type: "pdf",
    _isUninitialized: false,
    _isTabClosed: false,
    _iframeWindow: mockIframeWin,
    _internalReader: { _primaryView: mockPv },
    _item: { getFilePathAsync: async () => "C:\\temp\\sample.pdf" },
  };

  hook.attachReader(mockReader);
  await new Promise(r => setTimeout(r, 30));

  assert(hook.readerStates.size === 1, "readerStates should track open tab");
  assert(hook.thumbHooks.size === 1, "thumbHooks should hook open tab thumbnails");
  assert(mockThumbs._renderQueue.concurrency === 2, "thumbnail concurrency should match 2 fg workers");

  // Simulate tab close via Zotero Notifier + _isTabClosed flag (even before unload fires!)
  mockReader._isTabClosed = true;
  notifierObs.notify("close", "tab");

  assert(hook.readerStates.size === 0, "readerStates must be empty after tab close");
  assert(hook.thumbHooks.size === 0, "thumbHooks MUST be empty after tab close (zero GPU/DOM leak!)");
  assert(mockThumbs._render === origThumbRender, "original _render must be restored on detach");
  assert(mockThumbs._renderQueue.concurrency === 1, "original concurrency must be restored on detach");
  assert(
    evictedPaths.length === 1 && evictedPaths[0] === "C:\\temp\\sample.pdf",
    "evictPath must be called immediately when the last tab for that PDF closes"
  );

  // Also ensure unload firing afterward is a safe no-op
  if (unloadCb) unloadCb();
  hook.shutdown();
  console.log("[check 4] Tab-close thumbHooks zero-leak cleanup & native evictPath verified!");
}

async function main() {
  await verifySyntaxAndBootstrap();
  await verifyPagePatchZeroCopy();
  await verifyTabCloseZeroLeak();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

/* Page-context script injected into Zotero's pdf/web/viewer.html iframe.
 * Hooks PDFPageProxy.prototype.render so canvas rasterization runs on in-process lock-free
 * native MuPDF DLL via ChromeWorker + direct zero-copy Skia putImageData (async WebRender GPU upload),
 * decouples PDFRenderingQueue from slow PDF.js textLayer/annotationLayer stalls,
 * pre-renders +2 ahead & -1 behind into DOM canvases (0ms smooth scroll within Zotero's keep window),
 * and prioritizes getPage() ahead of Zotero's heavy 100-page getProcessedData() scan —
 * while preserving 100% of Zotero native highlights, text selection, links, themes, and 3rd-party plugins.
 */
(function initZotMuPDFPagePatch() {
  "use strict";

  if (window.__zotMuPDFPatched) {
    return;
  }
  window.__zotMuPDFPatched = true;

  const bridge = window.__zotMuPDFBridge;
  if (!bridge) {
    return;
  }

  let origOpen = null;
  let origGetPage = null;
  let origGetProcessedData = null;
  let patchedDocProto = null;
  let origPageRender = null;
  let patchedPageProto = null;
  let origGetHighestPriority = null;
  let patchedQueue = null;
  let nextReqId = 1;
  let docLoadedListener = null;
  let pageRenderedListener = null;
  let textLayerRenderedListener = null;
  let attachRetryTimer = null;
  let attachRetryTries = 0;

  const pageRenderEndTimes = new Map(); // pageNumber -> performance.now()

  function invert2D(m) {
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
      return null;
    }
    const invDet = 1 / det;
    return [
      d * invDet,
      -b * invDet,
      -c * invDet,
      a * invDet,
      (c * f - d * e) * invDet,
      (b * e - a * f) * invDet,
    ];
  }

  function multiply2D(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
  }

  function isThumbnailCanvas(canvas, ctxAlreadyProvided, width, height) {
    if (canvas && canvas.closest && canvas.closest(".thumbnail, #thumbnailView")) {
      return true;
    }
    // Zotero 10's PDFThumbnails uses DRAW_UPSCALE_FACTOR=2 * THUMBNAIL_WIDTH=120 * dpr (up to 480x680+ on 2x HiDPI)
    if (ctxAlreadyProvided && width <= 720 && height <= 960) {
      return true;
    }
    return false;
  }

  function makeCancelledError(pageNumber) {
    const Ctor = window.pdfjsLib?.RenderingCancelledException;
    if (Ctor) {
      return new Ctor(`Rendering cancelled, page ${pageNumber}`, "canvas");
    }
    const err = new Error(`Rendering cancelled, page ${pageNumber}`);
    err.name = "RenderingCancelledException";
    return err;
  }

  function patchPagePrototype(page) {
    if (!page) return;
    const proto = Object.getPrototypeOf(page);
    if (!proto || typeof proto.render !== "function") return;
    if (patchedPageProto === proto) return;

    origPageRender = proto.render;
    patchedPageProto = proto;

    proto.render = function zotMuPDFRender(params) {
      const invokeTimedOrigRender = () => {
        const tStart = performance.now();
        const origTask = origPageRender.call(this, params);
        if (origTask && origTask.promise && typeof origTask.promise.then === "function") {
          origTask.promise.then(
            () => {
              try {
                bridge.reportPdfJsTiming?.(performance.now() - tStart);
              } catch {}
            },
            () => {}
          );
        }
        return origTask;
      };

      try {
        if (!bridge.isEnabled()) {
          return invokeTimedOrigRender();
        }
        if (!params || !params.viewport) {
          return invokeTimedOrigRender();
        }
        if (params.intent === "print" || params.isEditing || params.annotationCanvasMap) {
          return invokeTimedOrigRender();
        }

        const targetCanvas = params.canvas || params.canvasContext?.canvas;
        if (!targetCanvas) {
          return invokeTimedOrigRender();
        }
        const width = targetCanvas.width | 0;
        const height = targetCanvas.height | 0;
        if (width <= 0 || height <= 0 || width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) {
          return invokeTimedOrigRender();
        }

        const ctxAlreadyProvided = !!params.canvasContext;
        const isThumb = isThumbnailCanvas(targetCanvas, ctxAlreadyProvided, width, height);
        const cfg = bridge.getConfig();
        if (!cfg.renderThumbnails && isThumb) {
          return invokeTimedOrigRender();
        }

        const baseVp = this.getViewport({ scale: 1 });
        const invBase = invert2D(baseVp.transform);
        if (!invBase) {
          return invokeTimedOrigRender();
        }

        const totalT = params.transform
          ? multiply2D(params.transform, params.viewport.transform)
          : params.viewport.transform;
        const muMatrix = multiply2D(totalT, invBase);
        for (let i = 0; i < 6; i++) {
          if (!Number.isFinite(muMatrix[i])) {
            return invokeTimedOrigRender();
          }
        }

        const pageIndex = this._pageIndex != null ? this._pageIndex : this.pageNumber - 1;
        const pageNumber = this.pageNumber;
        const includeAnnots = params.annotationMode !== 0;
        const isMainPage = !isThumb && (width > 450 || height > 450);

        const skipBlender = !!(params.canvasContext && params.canvasContext.skipBlender);
        let theme = null;
        if (!skipBlender && window.theme && window.theme.background && window.theme.foreground) {
          theme = {
            background: String(window.theme.background),
            foreground: String(window.theme.foreground),
            invertImages: !!window.theme.invertImages,
          };
        }

        const pageSelf = this;
        const reqId = nextReqId++;
        let cancelled = false;
        let settled = false;
        let started = false;
        let fallbackTask = null;

        let resolvePromise;
        let rejectPromise;
        const promise = new Promise((resolve, reject) => {
          resolvePromise = resolve;
          rejectPromise = reject;
        });

        const task = {
          onContinue: null,
          onError: null,
          separateAnnots: false,
          recordedBBoxes: null,
          imageCoordinates: null,
          get promise() {
            return promise;
          },
          cancel(extraDelay = 0) {
            if (cancelled || settled) return;
            cancelled = true;
            if (fallbackTask) {
              try {
                fallbackTask.cancel(extraDelay);
              } catch {}
              return;
            }
            if (started) {
              try {
                bridge.cancelRequest(reqId);
              } catch {}
            }
            settled = true;
            const err = makeCancelledError(pageNumber);
            try {
              task.onError?.(err);
            } catch {}
            rejectPromise(err);
          },
        };

        const runFallback = reason => {
          if (cancelled || settled) return;
          try {
            bridge.reportFallback(String(reason || "unknown"));
          } catch {}
          try {
            const tFb0 = performance.now();
            fallbackTask = origPageRender.call(pageSelf, params);
            fallbackTask.onContinue = task.onContinue;
            fallbackTask.onError = task.onError;
            fallbackTask.promise.then(
              val => {
                try {
                  bridge.reportPdfJsTiming?.(performance.now() - tFb0);
                } catch {}
                if (!settled) {
                  settled = true;
                  resolvePromise(val);
                }
              },
              err => {
                if (!settled) {
                  settled = true;
                  rejectPromise(err);
                }
              }
            );
          } catch (fbErr) {
            if (!settled) {
              settled = true;
              try {
                task.onError?.(fbErr);
              } catch {}
              rejectPromise(fbErr);
            }
          }
        };

        const beginMuPDFRender = () => {
          if (cancelled || settled) return;
          started = true;
          const tE2EStart = performance.now();

          const payload = JSON.stringify({
            reqId,
            pageIndex,
            width,
            height,
            baseW: baseVp.width,
            baseH: baseVp.height,
            matrix: muMatrix,
            includeAnnots,
            aaLevel: cfg.aaLevel || 8,
            theme,
            isMainPage,
            hasProvidedCtx: ctxAlreadyProvided,
          });

          bridge.renderPage(
            payload,
            targetCanvas,
            ctxAlreadyProvided ? params.canvasContext : null,
            () => cancelled || settled,
            (paintMs, paintMode) => {
              if (cancelled || settled) return;
              const e2eMs = performance.now() - tE2EStart;
              settled = true;
              try {
                bridge.reportMuPDFPaint?.(e2eMs, Number(paintMs) || 0, paintMode || "skia", isMainPage);
              } catch {}
              resolvePromise();
            },
            (rgbaU8, respW, respH, cloneMs) => {
              if (cancelled || settled) return;
              try {
                if (
                  !targetCanvas ||
                  targetCanvas.width !== respW ||
                  targetCanvas.height !== respH ||
                  !rgbaU8 ||
                  rgbaU8.byteLength !== respW * respH * 4
                ) {
                  runFallback("canvas-size-mismatch");
                  return;
                }
                const tPaint0 = performance.now();
                const ctx = ctxAlreadyProvided
                  ? params.canvasContext
                  : targetCanvas.getContext("2d", {
                      alpha: false,
                      willReadFrequently: cfg.softwareCanvas !== false,
                    });
                if (!ctx) {
                  runFallback("no-2d-context");
                  return;
                }
                const clamped = new Uint8ClampedArray(rgbaU8.buffer, rgbaU8.byteOffset, rgbaU8.byteLength);
                const imgData = new ImageData(clamped, respW, respH);
                ctx.putImageData(imgData, 0, 0);
                const paintMs = performance.now() - tPaint0 + (Number(cloneMs) || 0);
                const e2eMs = performance.now() - tE2EStart;
                settled = true;
                try {
                  bridge.reportMuPDFPaint?.(e2eMs, paintMs, "clone", isMainPage);
                } catch {}
                resolvePromise();
              } catch (drawErr) {
                runFallback(drawErr && drawErr.message ? drawErr.message : String(drawErr));
              }
            },
            (errMsg, isCancelled) => {
              if (settled) return;
              if (cancelled || isCancelled) {
                cancelled = true;
                settled = true;
                const err = makeCancelledError(pageNumber);
                try {
                  task.onError?.(err);
                } catch {}
                rejectPromise(err);
                return;
              }
              runFallback(errMsg);
            }
          );
        };

        // Defer by one microtask so PDFPageView._drawCanvas attaches renderTask.onContinue & onError first.
        Promise.resolve().then(() => {
          if (cancelled || settled) return;
          beginMuPDFRender();
        });

        return task;
      } catch (outerErr) {
        try {
          bridge.reportFallback(outerErr && outerErr.message ? outerErr.message : String(outerErr));
        } catch {}
        return invokeTimedOrigRender();
      }
    };
  }

  function hookPdfDocument(pdfDoc) {
    if (!pdfDoc) return;
    const proto = Object.getPrototypeOf(pdfDoc);
    if (proto && patchedDocProto !== proto) {
      patchedDocProto = proto;
      if (typeof proto.getPage === "function") {
        origGetPage = proto.getPage;
        proto.getPage = function zotMuPDFGetPage(pageNumber) {
          const p = origGetPage.call(this, pageNumber);
          return Promise.resolve(p).then(page => {
            patchPagePrototype(page);
            return page;
          });
        };
      }
      // Prevent Zotero's heavy 100-page GetProcessedData scan from queueing ahead of getPage(2..32)
      // on PDF.js's single-threaded worker right when a heavy PDF opens!
      if (typeof proto.getProcessedData === "function") {
        origGetProcessedData = proto.getProcessedData;
        proto.getProcessedData = function zotMuPDFGetProcessedData() {
          if (!bridge.isEnabled()) {
            return origGetProcessedData.apply(this, arguments);
          }
          const docSelf = this;
          const args = arguments;
          return (async () => {
            try {
              const total = Math.min(docSelf.numPages || 0, 32);
              const pre = [];
              for (let p = 2; p <= total; p++) {
                pre.push(docSelf.getPage(p).catch(() => null));
              }
              if (pre.length > 0) {
                await Promise.all(pre);
              }
            } catch {}
            await new Promise(r => setTimeout(r, 200));
            return origGetProcessedData.apply(docSelf, args);
          })();
        };
      }
    }

    let patchedFromExisting = false;
    try {
      const pages = window.PDFViewerApplication?.pdfViewer?._pages;
      if (Array.isArray(pages)) {
        for (const pv of pages) {
          if (pv && pv.pdfPage) {
            patchPagePrototype(pv.pdfPage);
            patchedFromExisting = true;
            break;
          }
        }
      }
    } catch {}

    // If pdfDocument exists before page 1 is attached to pdfViewer._pages, grab page 1 handle
    // immediately so PDFPageProxy.prototype.render is patched even if pagesinit already raced!
    if (!patchedFromExisting && !patchedPageProto && typeof pdfDoc.getPage === "function") {
      try {
        Promise.resolve(pdfDoc.getPage(1))
          .then(p => {
            if (p) patchPagePrototype(p);
          })
          .catch(() => {});
      } catch {}
    }
  }

  function hookRenderingQueue(app) {
    const queue = app?.pdfRenderingQueue;
    if (!queue || typeof queue.getHighestPriority !== "function" || patchedQueue === queue) {
      return;
    }
    patchedQueue = queue;
    origGetHighestPriority = queue.getHighestPriority;
    // Extend idle DOM canvas pre-rendering to +2 ahead & -1 behind (fits strictly inside Zotero's
    // _trimPageBuffer keepIds + PAGE_BUFFER_KEEP_RECENT=2 window -> 0ms instant scrolling!)
    queue.getHighestPriority = function zotMuPDFGetHighestPriority(
      visible,
      views,
      scrolledDown,
      preRenderExtra = false,
      ignoreDetailViews = false
    ) {
      const chosen = origGetHighestPriority.call(
        this,
        visible,
        views,
        scrolledDown,
        preRenderExtra,
        ignoreDetailViews
      );
      if (chosen || !bridge.isEnabled()) {
        return chosen;
      }
      try {
        const mainPages = window.PDFViewerApplication?.pdfViewer?._pages;
        if (!views || views !== mainPages || !visible || !visible.first || !visible.last) {
          return null;
        }
        const firstId = visible.first.id;
        const lastId = visible.last.id;
        // 1. Pre-render +2 in scroll direction (1-based page id -> 0-based views index: lastId+1 or firstId-3)
        const ahead2Idx = scrolledDown ? lastId + 1 : firstId - 3;
        const ahead2 = views[ahead2Idx];
        if (ahead2 && !this.isViewFinished(ahead2)) {
          return ahead2;
        }
        // 2. Pre-render -1 opposite scroll direction (always preserved in Zotero's keepIds!)
        const back1Idx = scrolledDown ? firstId - 2 : lastId;
        const back1 = views[back1Idx];
        if (back1 && !this.isViewFinished(back1)) {
          return back1;
        }
      } catch {}
      return null;
    };
  }

  function attachToViewerApp() {
    const app = window.PDFViewerApplication;
    if (!app) return false;

    if (!origOpen && typeof app.open === "function") {
      origOpen = app.open;
      app.open = function zotMuPDFOpen(args) {
        try {
          if (args && typeof args === "object" && typeof args.password === "string") {
            bridge.setPassword(args.password);
          }
        } catch {}
        return origOpen.apply(this, arguments);
      };
    }

    if (app.pdfDocument) {
      hookPdfDocument(app.pdfDocument);
    }
    hookRenderingQueue(app);

    const bindBus = () => {
      if (!app.eventBus || docLoadedListener) return;
      docLoadedListener = () => {
        if (app.pdfDocument) {
          hookPdfDocument(app.pdfDocument);
        }
        hookRenderingQueue(app);
      };

      // Decouple PDFRenderingQueue from PDF.js textLayer/annotationLayer stalls:
      // kick renderHighestPriority() as soon as MuPDF finishes painting the canvas!
      pageRenderedListener = ev => {
        if (!ev || ev.error || ev.cssTransform) return;
        if (ev.pageNumber != null && !ev.isDetailView) {
          pageRenderEndTimes.set(ev.pageNumber, performance.now());
        }
        if (!bridge.isEnabled()) return;
        Promise.resolve().then(() => {
          try {
            window.PDFViewerApplication?.pdfRenderingQueue?.renderHighestPriority();
          } catch {}
        });
      };

      textLayerRenderedListener = ev => {
        if (!ev || ev.pageNumber == null) return;
        const t0 = pageRenderEndTimes.get(ev.pageNumber);
        if (t0 != null) {
          pageRenderEndTimes.delete(ev.pageNumber);
          try {
            bridge.reportTextLayerTiming?.(performance.now() - t0);
          } catch {}
        }
      };

      app.eventBus.on("documentloaded", docLoadedListener);
      app.eventBus.on("pagesinit", docLoadedListener);
      app.eventBus.on("pagerendered", pageRenderedListener);
      app.eventBus.on("textlayerrendered", textLayerRenderedListener);
    };

    if (app.eventBus) {
      bindBus();
    } else if (app.initializedPromise) {
      app.initializedPromise.then(() => {
        bindBus();
        hookRenderingQueue(app);
        if (app.pdfDocument) {
          hookPdfDocument(app.pdfDocument);
        }
      });
    }
    return true;
  }

  function refreshAllPages(coldReset = false) {
    try {
      const app = window.PDFViewerApplication;
      const viewer = app?.pdfViewer;
      if (!viewer) return;
      if (Array.isArray(viewer._pages)) {
        for (const pv of viewer._pages) {
          if (coldReset && pv?.pdfPage?._intentStates?.clear) {
            try {
              pv.pdfPage._intentStates.clear();
            } catch {}
          }
          if (pv && typeof pv.reset === "function") {
            pv.reset({ keepTextLayer: true, keepAnnotationLayer: true });
          }
        }
      }
      viewer.update();
    } catch {}
  }

  function ensureAttached() {
    if (attachToViewerApp()) {
      if (attachRetryTimer) {
        clearTimeout(attachRetryTimer);
        attachRetryTimer = null;
      }
      return true;
    }
    if (!attachRetryTimer && attachRetryTries < 80) {
      attachRetryTries++;
      attachRetryTimer = setTimeout(() => {
        attachRetryTimer = null;
        ensureAttached();
      }, 25);
    }
    return false;
  }

  function uninstall() {
    try {
      if (attachRetryTimer) {
        clearTimeout(attachRetryTimer);
        attachRetryTimer = null;
      }
      pageRenderEndTimes.clear();
      if (patchedQueue && origGetHighestPriority) {
        patchedQueue.getHighestPriority = origGetHighestPriority;
      }
      if (patchedPageProto && origPageRender) {
        patchedPageProto.render = origPageRender;
      }
      if (patchedDocProto) {
        if (origGetPage) patchedDocProto.getPage = origGetPage;
        if (origGetProcessedData) patchedDocProto.getProcessedData = origGetProcessedData;
      }
      if (window.PDFViewerApplication && origOpen) {
        window.PDFViewerApplication.open = origOpen;
      }
      if (window.PDFViewerApplication?.eventBus) {
        if (docLoadedListener) {
          window.PDFViewerApplication.eventBus.off("documentloaded", docLoadedListener);
          window.PDFViewerApplication.eventBus.off("pagesinit", docLoadedListener);
        }
        if (pageRenderedListener) {
          window.PDFViewerApplication.eventBus.off("pagerendered", pageRenderedListener);
        }
        if (textLayerRenderedListener) {
          window.PDFViewerApplication.eventBus.off("textlayerrendered", textLayerRenderedListener);
        }
      }
    } catch {}
    patchedQueue = null;
    origGetHighestPriority = null;
    patchedPageProto = null;
    origPageRender = null;
    patchedDocProto = null;
    origGetPage = null;
    origGetProcessedData = null;
    origOpen = null;
    docLoadedListener = null;
    pageRenderedListener = null;
    textLayerRenderedListener = null;
    delete window.__zotMuPDFPatched;
    delete window.__zotMuPDFControl;
    delete window.__zotMuPDFBridge;
  }

  window.__zotMuPDFControl = {
    ensureAttached,
    refreshAllPages,
    uninstall,
  };

  ensureAttached();
})();

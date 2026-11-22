# Zotero MuPDF Engine

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D6.svg)](#安装方式zotero-7--10)
[![Zotero](https://img.shields.io/badge/Zotero-7%20--%2010-CC2936.svg)](#安装方式zotero-7--10)

用 SumatraPDF 同款原生 C 渲染引擎（**MuPDF 1.28.0**，进程内无锁原生库）接管 Zotero 7–10 内置阅读器的 PDF 画布光栅化与侧栏缩略图渲染，大幅加速复杂矢量图（LaTeX / matplotlib / CAD 工程图）与高分辨率扫描件的翻页与缩放，同时 **100% 保留 Zotero 原生高亮、批注、选字、阅读模式、暗色主题及第三方阅读插件生态**，且无任何独立常驻后台进程。

---

## 核心特性

- **跨平台进程内原生 MuPDF 1.28.0 库（零残留进程）**：通过 Firefox `ChromeWorker` + `js-ctypes` 直接加载无外部依赖的原生库（支持 **Windows x64 `.dll`**、**macOS Apple Silicon / Intel `.dylib`** 与 **Linux x64 `.so`**），随 Zotero 退出自动卸载，无黑框、无孤儿进程、无本地 HTTP 端口开销。
- **只替换光栅化层，零侵入交互生态**：拦截 `PDFPageProxy.prototype.render`，完整保留 `textLayer`、`annotationLayer`、Zotero 批注与高亮覆盖层、划词翻译、Better Notes、阅读模式等一切原生与第三方功能。
- **无锁多核并行 + 翻页解耦**：
  - 每个前台 Worker 线程持有独立的 `WorkerDocCache`（零文档锁争用），支持同一份 PDF 多页真并行解析与光栅化。
  - 将 `PDFRenderingQueue` 与耗时的 PDF.js 文本/批注层解析解耦，页面位图一完成立即释放队列绘制下一页，大幅减少快速翻页转圈。
  - 提前并发预热 `getPage()`，避免 Zotero 后台 `getProcessedData()` 全文扫描阻塞翻页。
- **方向感知预渲染 & 低内存自动回收**：
  - 最低优先级（`THREAD_PRIORITY_LOWEST`）后台预渲染线程根据滚动方向（`+1 / +2 / -1`）自动预渲染邻近页面，前台活跃时立即让步，切换文档时立刻清空旧队列；前台渲染直写跳过冗余拷贝，将 `pixCache` 专用于即将翻到的预渲染页。
  - **离屏分帧防卡顿绘制**：当前可见页单次直出（0 撕裂），屏幕外预渲染页自动拆为 4 条横带分帧写入（每条 `<8ms`），显著消除滚动过程中的主线程微卡顿。
  - 精简均衡的缓存上限：`fz_display_list`（24 页）+ RGBA 位图 LRU（默认 96 MB，淘汰缓冲区智能复用不滞留旧尺寸）+ Worker 1 槽 `ArrayBuffer` 复用池（空闲 5 秒自动归零）；空闲 20 秒自动收缩原生缓存，关闭 PDF 标签页时立即释放对应缓存与文件句柄，并接入 Firefox/Zotero `memory-pressure` 低内存自动清空信号。
  - 实时支持通过 `fz_cookie` 立即中止已滚出视口或旧缩放倍率的未完成渲染。
- **原生侧栏缩略图加速**：专用无锁 `zot_dll_render_thumb_rgba` 通道，多线程并行生成侧栏缩略图，复用主页面 Display List 缓存且不污染主页面位图缓存；含批注页面的缩略图自动交由 Zotero 原生覆盖层渲染。
- **亚像素级坐标与主题对齐**：
  - 自动换算变换矩阵 $M_{\text{MuPDF}} = T_{\text{total}} \cdot B^{-1}$，精准适配任意缩放、HiDPI `outputScale`、非零 `CropBox`、页面旋转与放大局部瓦片；发现异常边界不一致时自动无感回退 PDF.js。
  - 自动读取 Zotero 阅读器主题；在暗色/护眼主题下开启 `invertImages=false` 时，通过自定义 MuPDF `fz_device` 滤镜仅重映射文字与矢量路径颜色、保留位图插图原色；开启 `invertImages=true` 时采用 **256 项灰度查表（LUT）+ 整字写入**加速反色重映射。
- **可视化原生设置面板 & 工具栏一键对比**：在 Zotero **设置 → MuPDF Engine** 提供原生可视化配置面板（实时状态监控、一键释放缓存、修改线程/缓存后无需重启 Zotero 即可热重载引擎）；阅读器顶部工具栏提供固定宽度防抖动胶囊按钮 **`● MuPDF ⚡XXms`**（悬停查看耗时拆解与 PDF.js 对比，单击实时切换，**Shift + 单击** 清缓存冷启动对比）。

---

## 安装方式（Zotero 7 – 10）

1. 前往 [Releases 页面](https://github.com/HappyAny/zotero-mupdf-engine/releases) 下载最新版本的通用跨平台 `zotero-mupdf-engine-*.xpi`（单个包内置 Windows x64 / macOS arm64 / macOS x64 / Linux x64 原生库，亦可在 Zotero 插件市场搜索安装）。
2. 在 Zotero 中打开 **工具（Tools） → 插件（Plugins / Add-ons）**。
3. 点击右上角齿轮图标 → **Install Plugin From File…（从文件安装插件）**，选择刚下载的 `.xpi` 文件。
4. 打开任意 PDF 标签页，顶部工具栏即可看到 **`● MuPDF`** 状态按钮。

### 工具栏按钮操作

| 操作 | 效果 |
|---|---|
| **悬停** | 查看当前渲染耗时拆解（引擎耗时 / 线程通信 / 绘制）、预渲染命中率、PDF.js 文本层耗时与实测对比均值 |
| **单击** | 实时切换 **MuPDF** 与 **原生 PDF.js**，并重绘当前页面以便直观对比 |
| **Shift + 单击** | 清空 MuPDF 原生缓存并冷启动重绘当前页面 |

---

## 设置面板与高级首选项

安装后可直接打开 **设置（Settings） → MuPDF Engine** 进行可视化配置（也可在 **设置 → 高级 → 配置编辑器** 中直接调整以下首选项）：

| 首选项键 | 默认值 | 说明 |
|---|---|---|
| `extensions.zotero-mupdf-engine.enabled` | `true` | 是否启用 MuPDF 渲染加速 |
| `extensions.zotero-mupdf-engine.renderThumbnails` | `true` | 是否使用 MuPDF 多线程加速左侧缩略图 |
| `extensions.zotero-mupdf-engine.aaLevel` | `8` | 抗锯齿等级（`0`–`8`，`8` 最清晰） |
| `extensions.zotero-mupdf-engine.workers` | `2` | 前台 `ChromeWorker` 渲染线程数（`1`–`4`） |
| `extensions.zotero-mupdf-engine.bgWorkers` | `1` | 最低优先级后台预渲染线程数（`0`–`4`） |
| `extensions.zotero-mupdf-engine.storeMB` | `96` | MuPDF 内部资源存储缓存上限（MB） |
| `extensions.zotero-mupdf-engine.pixCacheMB` | `96` | 后台预渲染 RGBA 位图缓存上限（MB，空闲 20 秒自动收缩） |
| `extensions.zotero-mupdf-engine.prerender` | `true` | 是否开启方向感知后台预渲染 |
| `extensions.zotero-mupdf-engine.softwareCanvas` | `true` | 使用 Skia 软件画布（`willReadFrequently: true`）配合 WebRender 异步上传，显著降低大位图写入主线程阻塞 |
| `extensions.zotero-mupdf-engine.maxOutputScale` | `""` | 可选高分屏画布 DPR 上限（默认空 = 原生满分辨率；填如 `"1.5"` 可在 2K/4K 屏下再降约 40% 绘制耗时与 GPU 显存，不影响标注/选字坐标） |
| `extensions.zotero-mupdf-engine.debugLog` | `false` | 输出详细调试日志到 Zotero Debug Output |

---

## 项目结构

```text
zotero-mupdf-engine/
├── .github/workflows/
│   └── build-release.yml           # 4 平台（Win x64 / macOS arm64 & x64 / Linux x64）自动编译与通用 XPI 发布
├── engine/
│   ├── mupdf_render.h / .c         # MuPDF 1.28.0 渲染核心、跨平台锁、fz_cookie 中止与 LUT 主题重映射
│   └── third_party/mupdf/          # MuPDF 1.28.0 头文件、Windows x64 静态库与上游协议
├── native-dll/
│   ├── zot_dll.h / .c              # 跨平台进程内无锁原生库：WorkerDocCache、DL/RGBA LRU、方向预渲染与缩略图导出
│   └── test_dll.c                  # 跨平台自包含 C 单元测试（4K HiDPI、暗色 LUT、并发、中文路径、缩略图、回收）
├── plugin/
│   ├── manifest.json / bootstrap.js / prefs.js
│   ├── content/
│   │   ├── preferences.xhtml / .js / .css   # Zotero 7–10 原生可视化设置面板
│   │   └── icons/icon.svg
│   └── src/
│       ├── render-worker.js        # ChromeWorker js-ctypes 桥接与空闲自动清空 ArrayBuffer 复用池
│       ├── engine-client.js        # 跨平台原生库自动加载、优先级队列、实时中止、热重载与 memory-pressure 回收
│       ├── reader-hook.js          # 工具栏 UI、零拷贝/离屏分帧绘制、缩略图加速、主题检测与标签零泄漏管理
│       └── page-patch.js           # PDFPageProxy.render Hook、队列解耦与可选 maxOutputScale
├── scripts/
│   ├── build.mjs                   # 跨平台编译原生库、检查纯系统依赖、运行 C 测试并打包 .xpi
│   └── verify-plugin.mjs           # 插件语法、设置面板、4 平台路由、坐标对齐与回归测试
└── updates.json                    # Zotero 插件自动更新清单
```

---

## 从源码构建与测试（Windows / macOS / Linux）

### 自动构建通用 4 平台安装包（推荐）

推送 `v*` 标签（或在 GitHub Actions 手动触发 `Build & Release Universal XPI`）后，CI 会在 **Windows x64**、**macOS Apple Silicon (`macos-latest`)**、**macOS Intel (`macos-15-intel`)** 和 **Linux x64 (`ubuntu-24.04`)** 四个原生环境并行编译并运行 C 单元测试，最终自动打包并发布包含全平台原生库的单一通用 `.xpi`。

### 本地构建与验证

- **Windows x64**：安装 MinGW-w64（`gcc`/`objdump` 在 `PATH` 中，或设 `$env:GCC_DIR`）、Node.js 18+、`pwsh`，运行：

```powershell
# 1. 编译 Windows x64 原生 DLL + 依赖检查 + 自包含 C 测试 + 打包 dist/*.xpi
node scripts/build.mjs

# 2. 运行全套插件校验与回归测试
node scripts/verify-plugin.mjs
```

- **macOS / Linux**：先静态编译 MuPDF 1.28.0（`make build=release HAVE_X11=no HAVE_GLUT=no HAVE_CURL=no HAVE_OBJCOPY=no USE_SYSTEM_LIBS=no XCFLAGS="-fPIC" libs`），然后指定 `MUPDF_INC_DIR` 与 `MUPDF_LIB_DIR` 运行：

```bash
MUPDF_INC_DIR=/path/to/mupdf/include MUPDF_LIB_DIR=/path/to/mupdf/build/release node scripts/build.mjs
node scripts/verify-plugin.mjs
```

---

## 开源协议与致谢

本项目采用 **GNU Affero General Public License v3.0（GNU AGPL-3.0，GPLv3 家族协议）** 开源，完整条款见 [LICENSE](LICENSE)。

- 本项目静态链接并包含 [MuPDF](https://mupdf.com/) 1.28.0（Copyright Artifex Software, Inc.，以 **GNU AGPL-3.0** 协议发布，上游许可证副本保留于 [engine/third_party/mupdf/LICENSE-MUPDF.txt](engine/third_party/mupdf/LICENSE-MUPDF.txt)）。为完全兼容 MuPDF 的开源协议要求，本项目及发布的二进制 `.xpi` 均遵循 GNU AGPL-3.0。
- 致谢 [Zotero](https://www.zotero.org/) 与 [SumatraPDF](https://www.sumatrapdfreader.org/) 开源社区的启发。

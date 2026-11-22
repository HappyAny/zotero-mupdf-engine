import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ENGINE_DIR = path.join(ROOT, "engine");
const DLL_SRC_DIR = path.join(ROOT, "native-dll");
const PLUGIN_DIR = path.join(ROOT, "plugin");
const DIST_DIR = path.join(ROOT, "dist");
const BIN_DIR = path.join(PLUGIN_DIR, "bin");

const args = new Set(process.argv.slice(2));
const NATIVE_ONLY = args.has("--native-only");
const PACK_ONLY = args.has("--pack-only");

function buildWindowsX64() {
  const gccDir = process.env.GCC_DIR || "";
  const gccExe = gccDir ? path.join(gccDir, "gcc.exe") : "gcc";
  const objdumpExe = gccDir ? path.join(gccDir, "objdump.exe") : "objdump";

  const dllOut = path.join(BIN_DIR, "zotero-mupdf-native-win-x64.dll");
  const testExe = path.join(DLL_SRC_DIR, "test_dll.exe");

  // Clean legacy single-platform binary names so XPI never ships duplicate 8.5MB DLLs
  for (const oldName of ["zotero-mupdf-engine.exe", "zotero-mupdf-native.dll"]) {
    const p = path.join(BIN_DIR, oldName);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  const incDir = process.env.MUPDF_INC_DIR || path.join(ENGINE_DIR, "third_party", "mupdf", "include");
  const libDir = process.env.MUPDF_LIB_DIR || path.join(ENGINE_DIR, "third_party", "mupdf", "libs");

  console.log("[build] Compiling pure C in-process MuPDF DLL (windows/x64)...");
  const t0 = Date.now();
  execFileSync(
    gccExe,
    [
      "-shared",
      "-O2",
      "-s",
      `-I${incDir}`,
      path.join(ENGINE_DIR, "mupdf_render.c"),
      path.join(DLL_SRC_DIR, "zot_dll.c"),
      `-L${libDir}`,
      "-lmupdf_windows_amd64",
      "-lmupdfthird_windows_amd64",
      "-lm",
      "-lcomdlg32",
      "-lgdi32",
      "-static-libgcc",
      "-Wl,--gc-sections",
      "-o",
      dllOut,
    ],
    { stdio: "inherit" }
  );
  const st = fs.statSync(dllOut);
  console.log(`[build] Built ${dllOut} (${(st.size / 1024 / 1024).toFixed(2)} MB) in ${Date.now() - t0} ms`);

  // Verify zero non-system DLL dependencies
  const dump = execFileSync(objdumpExe, ["-p", dllOut], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const imports = [...dump.matchAll(/DLL Name:\s+(\S+)/g)].map(m => m[1]);
  const badImports = imports.filter(n => !/^(KERNEL32\.dll|api-ms-win-crt-.*\.dll|GDI32\.dll|COMDLG32\.dll)$/i.test(n));
  if (badImports.length > 0) {
    throw new Error("Unexpected non-system DLL dependencies: " + badImports.join(", "));
  }
  console.log(`[verify] DLL imports clean (${imports.length} Windows system DLLs only)`);

  // Compile and run native C DLL test
  execFileSync(gccExe, ["-O2", path.join(DLL_SRC_DIR, "test_dll.c"), dllOut, "-o", testExe], {
    stdio: "inherit",
  });
  console.log("[verify] Running native DLL test_dll.exe...");
  execFileSync(testExe, [], {
    stdio: "inherit",
    env: { ...process.env, PATH: `${BIN_DIR};${process.env.PATH || ""}` },
  });
}

function buildMacOS() {
  const arch = (process.env.TARGET_ARCH || process.arch) === "arm64" ? "arm64" : "x64";
  const clangArch = arch === "arm64" ? "arm64" : "x86_64";
  const cc = process.env.CC || "clang";
  const libName = `zotero-mupdf-native-darwin-${arch}.dylib`;
  const dylibOut = path.join(BIN_DIR, libName);
  const testBin = path.join(DLL_SRC_DIR, "test_dll");

  const incDir = process.env.MUPDF_INC_DIR || path.join(ENGINE_DIR, "third_party", "mupdf", "include");
  const libDir = process.env.MUPDF_LIB_DIR;
  if (!libDir) {
    throw new Error("MUPDF_LIB_DIR must point to directory containing libmupdf.a and libmupdf-third.a on macOS");
  }

  console.log(`[build] Compiling pure C in-process MuPDF dylib (darwin/${arch})...`);
  const t0 = Date.now();
  execFileSync(
    cc,
    [
      "-dynamiclib",
      "-O2",
      "-fPIC",
      "-fvisibility=hidden",
      "-arch",
      clangArch,
      `-I${incDir}`,
      path.join(ENGINE_DIR, "mupdf_render.c"),
      path.join(DLL_SRC_DIR, "zot_dll.c"),
      path.join(libDir, "libmupdf.a"),
      path.join(libDir, "libmupdf-third.a"),
      "-lm",
      "-lpthread",
      "-Wl,-dead_strip",
      "-Wl,-exported_symbol,_zot_dll_*",
      "-install_name",
      `@rpath/${libName}`,
      "-o",
      dylibOut,
    ],
    { stdio: "inherit" }
  );
  execFileSync("strip", ["-x", dylibOut], { stdio: "inherit" });
  const st = fs.statSync(dylibOut);
  console.log(`[build] Built ${dylibOut} (${(st.size / 1024 / 1024).toFixed(2)} MB) in ${Date.now() - t0} ms`);

  const otool = execFileSync("otool", ["-L", dylibOut], { encoding: "utf8" });
  const deps = otool
    .split(/\r?\n/)
    .slice(1)
    .map(l => l.trim().split(/\s+/)[0])
    .filter(Boolean);
  const badDeps = deps.filter(
    d => !d.startsWith("@rpath/") && !d.startsWith("/usr/lib/") && !d.startsWith("/System/Library/")
  );
  if (badDeps.length > 0) {
    throw new Error("Unexpected non-system macOS dylib dependencies: " + badDeps.join(", "));
  }
  console.log(`[verify] macOS dylib dependencies clean (${deps.length} entries, system libs only)`);

  if (process.env.SKIP_NATIVE_TEST !== "1") {
    execFileSync(
      cc,
      ["-O2", "-arch", clangArch, path.join(DLL_SRC_DIR, "test_dll.c"), dylibOut, "-Wl,-rpath," + BIN_DIR, "-lpthread", "-o", testBin],
      { stdio: "inherit" }
    );
    console.log("[verify] Running native test_dll...");
    execFileSync(testBin, [], { stdio: "inherit" });
  }
}

function buildLinuxX64() {
  const cc = process.env.CC || "gcc";
  const soName = "zotero-mupdf-native-linux-x64.so";
  const soOut = path.join(BIN_DIR, soName);
  const testBin = path.join(DLL_SRC_DIR, "test_dll");

  const incDir = process.env.MUPDF_INC_DIR || path.join(ENGINE_DIR, "third_party", "mupdf", "include");
  const libDir = process.env.MUPDF_LIB_DIR;
  if (!libDir) {
    throw new Error("MUPDF_LIB_DIR must point to directory containing libmupdf.a and libmupdf-third.a on Linux");
  }

  console.log("[build] Compiling pure C in-process MuPDF shared library (linux/x64)...");
  const t0 = Date.now();
  execFileSync(
    cc,
    [
      "-shared",
      "-O2",
      "-s",
      "-fPIC",
      "-fvisibility=hidden",
      `-I${incDir}`,
      path.join(ENGINE_DIR, "mupdf_render.c"),
      path.join(DLL_SRC_DIR, "zot_dll.c"),
      "-Wl,--start-group",
      path.join(libDir, "libmupdf.a"),
      path.join(libDir, "libmupdf-third.a"),
      "-Wl,--end-group",
      "-lm",
      "-lpthread",
      "-Wl,--gc-sections",
      "-Wl,--exclude-libs,ALL",
      "-o",
      soOut,
    ],
    { stdio: "inherit" }
  );
  const st = fs.statSync(soOut);
  console.log(`[build] Built ${soOut} (${(st.size / 1024 / 1024).toFixed(2)} MB) in ${Date.now() - t0} ms`);

  const ldd = execFileSync("ldd", [soOut], { encoding: "utf8" });
  const deps = [...ldd.matchAll(/^\s*([^\s=>]+)\s*=>/gm)].map(m => m[1]);
  const badDeps = deps.filter(
    d => !/^(linux-vdso\.so|libc\.so|libm\.so|libpthread\.so|libdl\.so|librt\.so|libgcc_s\.so|ld-linux)/i.test(d)
  );
  if (badDeps.length > 0) {
    throw new Error("Unexpected non-system Linux shared library dependencies: " + badDeps.join(", "));
  }
  console.log(`[verify] Linux .so dependencies clean (${deps.join(", ")})`);

  execFileSync(
    cc,
    ["-O2", path.join(DLL_SRC_DIR, "test_dll.c"), soOut, `-Wl,-rpath,${BIN_DIR}`, "-lpthread", "-o", testBin],
    { stdio: "inherit" }
  );
  console.log("[verify] Running native test_dll...");
  execFileSync(testBin, [], { stdio: "inherit" });
}

function buildNativeLibrary() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  if (process.platform === "win32") {
    buildWindowsX64();
  } else if (process.platform === "darwin") {
    buildMacOS();
  } else if (process.platform === "linux") {
    buildLinuxX64();
  } else {
    throw new Error(`Unsupported build host platform: ${process.platform}`);
  }
}

function packXpi() {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "manifest.json"), "utf8"));
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const xpiPath = path.join(DIST_DIR, `zotero-mupdf-engine-${manifest.version}.xpi`);
  if (fs.existsSync(xpiPath)) fs.unlinkSync(xpiPath);

  const bins = fs.existsSync(BIN_DIR) ? fs.readdirSync(BIN_DIR).filter(f => /\.(dll|dylib|so)$/i.test(f)) : [];
  console.log(`[build] Packing ${xpiPath} (bundled native libs: ${bins.join(", ") || "none"})...`);

  if (process.platform === "win32") {
    const psScript = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = '${PLUGIN_DIR.replace(/'/g, "''")}'
$dst = '${xpiPath.replace(/'/g, "''")}'
$zip = [System.IO.Compression.ZipFile]::Open($dst, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -Path $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length + 1).Replace('\\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally {
  $zip.Dispose()
}
`;
    execFileSync("pwsh", ["-NoProfile", "-Command", psScript], { stdio: "inherit" });
  } else {
    execFileSync("zip", ["-9", "-r", xpiPath, "."], { cwd: PLUGIN_DIR, stdio: "inherit" });
  }

  const st = fs.statSync(xpiPath);
  console.log(`[build] Packed ${xpiPath} (${(st.size / 1024 / 1024).toFixed(2)} MB)`);
  return xpiPath;
}

function main() {
  if (!PACK_ONLY) {
    buildNativeLibrary();
  }
  if (!NATIVE_ONLY) {
    packXpi();
  }
}

main();

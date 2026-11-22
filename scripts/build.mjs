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
const DLL_OUT = path.join(BIN_DIR, "zotero-mupdf-native.dll");
const TEST_EXE = path.join(DLL_SRC_DIR, "test_dll.exe");

const GCC_DIR = process.env.GCC_DIR || "";
const GCC_EXE = GCC_DIR ? path.join(GCC_DIR, "gcc.exe") : "gcc";
const OBJDUMP_EXE = GCC_DIR ? path.join(GCC_DIR, "objdump.exe") : "objdump";

function buildNativeDLL() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  // Remove legacy .exe daemon if present so XPI stays lean and purely in-process DLL
  const legacyExe = path.join(BIN_DIR, "zotero-mupdf-engine.exe");
  if (fs.existsSync(legacyExe)) fs.unlinkSync(legacyExe);

  const incDir = path.join(ENGINE_DIR, "third_party", "mupdf", "include");
  const libDir = path.join(ENGINE_DIR, "third_party", "mupdf", "libs");

  console.log("[build] Compiling pure C in-process MuPDF DLL (windows/amd64)...");
  const t0 = Date.now();
  execFileSync(
    GCC_EXE,
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
      DLL_OUT,
    ],
    { stdio: "inherit" }
  );
  const st = fs.statSync(DLL_OUT);
  console.log(`[build] Built ${DLL_OUT} (${(st.size / 1024 / 1024).toFixed(2)} MB) in ${Date.now() - t0} ms`);

  // Verify zero non-system DLL dependencies
  const dump = execFileSync(OBJDUMP_EXE, ["-p", DLL_OUT], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const imports = [...dump.matchAll(/DLL Name:\s+(\S+)/g)].map(m => m[1]);
  const badImports = imports.filter(n => !/^(KERNEL32\.dll|api-ms-win-crt-.*\.dll|GDI32\.dll|COMDLG32\.dll)$/i.test(n));
  if (badImports.length > 0) {
    throw new Error("Unexpected non-system DLL dependencies: " + badImports.join(", "));
  }
  console.log(`[verify] DLL imports clean (${imports.length} Windows system DLLs only)`);

  // Compile and run native C DLL test (4K HiDPI cold, warm pix cache, background pre-render, Chinese UTF-8 path)
  execFileSync(GCC_EXE, ["-O2", path.join(DLL_SRC_DIR, "test_dll.c"), DLL_OUT, "-o", TEST_EXE], {
    stdio: "inherit",
  });
  console.log("[verify] Running native DLL test_dll.exe...");
  execFileSync(TEST_EXE, [], {
    stdio: "inherit",
    env: { ...process.env, PATH: `${BIN_DIR};${process.env.PATH || ""}` },
  });
}

function packXpi() {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "manifest.json"), "utf8"));
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const xpiPath = path.join(DIST_DIR, `zotero-mupdf-engine-${manifest.version}.xpi`);
  if (fs.existsSync(xpiPath)) fs.unlinkSync(xpiPath);

  console.log(`[build] Packing ${xpiPath}...`);
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
  const st = fs.statSync(xpiPath);
  console.log(`[build] Packed ${xpiPath} (${(st.size / 1024 / 1024).toFixed(2)} MB)`);
  return xpiPath;
}

function main() {
  buildNativeDLL();
  packXpi();
}

main();

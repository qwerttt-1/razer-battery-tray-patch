"use strict";

const fs = require(process.versions.electron ? "original-fs" : "node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const vm = require("node:vm");
const PATCH_VERSION = "1.7.0";
const MARKER = "razer-battery-patch.json";
const MAIN = "electron/main.js";
const sha = data => crypto.createHash("sha256").update(data).digest("hex");

function archive(data) {
  if (data.length < 16) throw new Error("Unsupported ASAR input");
  if (data.readUInt32LE(0) !== 4) throw new Error("Invalid ASAR header");
  const headerSize = data.readUInt32LE(4);
  const header = JSON.parse(data.subarray(16, 16 + data.readUInt32LE(12)).toString("utf8"));
  const base = 8 + headerSize;
  function entry(name) {
    let node = header;
    for (const part of name.split("/")) node = node?.files?.[part];
    return node;
  }
  function read(name) {
    const node = entry(name);
    if (!node || node.unpacked || node.link) throw new Error(`Missing packed file: ${name}`);
    const begin = base + Number(node.offset);
    if (!Number.isSafeInteger(begin) || begin < base || begin + node.size > data.length) throw new Error(`Invalid range: ${name}`);
    return data.subarray(begin, begin + node.size);
  }
  return { header, base, entry, read };
}

function versionOf(source) {
  const version = JSON.parse(source.read("package.json")).version;
  if (typeof version !== "string" || !/^4\.\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/.test(version)) throw new Error(`Expected Synapse 4.X; found ${version}`);
  return version;
}

function transformMain(main) {
  const id = "[A-Za-z_$][\\w$]*";
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function binding(property, moduleName) {
    const groups = [...main.matchAll(/\{([^{}]+)\}\s*=\s*require\(\s*(["'])([^"']+)\2\s*\)/g)].filter(match => match[3] === moduleName);
    const matches = groups.flatMap(group => [...group[1].matchAll(new RegExp(`(?:^|,)\\s*${property}\\s*(?::\\s*(${id}))?\\s*(?=,|$)`, "g"))]);
    if (matches.length !== 1) throw new Error(`Unsupported program structure: ${moduleName}.${property} binding is not unique`);
    return matches[0][1] || property;
  }
  const Tray = binding("Tray", "electron");
  const app = binding("app", "electron");
  const nativeImage = binding("nativeImage", "electron");
  const globalVar = binding("globalNodeVar", "./lib/globalNodeVar");
  const creations = [...main.matchAll(new RegExp(`(${id})\\s*=\\s*new\\s+${escape(Tray)}\\(\\s*(${id})\\s*\\)`, "g"))];
  if (creations.length !== 1) throw new Error("Unsupported program structure: tray creation is not unique");
  const [creation, tray, image] = creations[0];
  const tooltips = [...main.matchAll(new RegExp(`${escape(tray)}\\.setToolTip\\(\\s*(["'])Razer\\1\\s*\\)`, "g"))];
  if (tooltips.length !== 1 || !main.includes(`${globalVar}.windowStorage`)) throw new Error("Unsupported program structure: tray tooltip or device storage missing");
  const tooltipInsert = `${tray}.setToolTip(require("./lib/batteryTrayPatch").selectState(${globalVar}.windowStorage,${globalVar}.lang).tooltip||"Razer")`;
  const insert = `${creation},(()=>{try{require("./lib/batteryTrayPatch").attach({tray:${tray},storage:${globalVar}.windowStorage,nativeImage:${nativeImage},originalImage:${image},app:${app}})}catch(error){console.warn("[RazerBatteryTrayPatch] Initialization failed:",error.message)}})()`;
  return { main: main.replace(creation, insert).replace(tooltips[0][0], tooltipInsert), tooltipAnchor: tooltips[0][0], tooltipInsert };
}

function build(original, packageDir = __dirname) {
  const source = archive(original);
  const version = versionOf(source);
  if (source.entry(MARKER)) throw new Error("Build requires an unpatched original archive");
  const main = source.read(MAIN).toString("utf8");
  const transformed = transformMain(main);
  new vm.Script(transformed.main, { filename: MAIN });
  const storagePath = source.entry("electron/modules/window_storage.js") ? "electron/modules/window_storage.js" : "electron/modules/window_storage/index.js";
  const storage = source.read(storagePath).toString("utf8");
  if (!["windowStorageMap", "callFunction", "setWindowStorageItem", "removeWindowStorageItem"].every(key => storage.includes(key))) throw new Error("Unsupported program structure: device storage API changed");
  const additions = new Map([
    [MAIN, Buffer.from(transformed.main)],
    ["electron/lib/batteryTrayPatch.js", fs.readFileSync(path.join(packageDir, "batteryTrayPatch.js"))],
    [MARKER, Buffer.from(JSON.stringify({ version: PATCH_VERSION, synapse: version, step: 5, iconCount: 21, originalSha256: sha(original) }))],
  ]);
  for (let percent = 0; percent <= 100; percent += 5) {
    const filename = `battery_${String(percent).padStart(3, "0")}.ico`;
    const icon = fs.readFileSync(path.join(packageDir, "icons", filename));
    if (icon.readUInt16LE(0) !== 0 || icon.readUInt16LE(2) !== 1 || !icon.readUInt16LE(4)) throw new Error(`Invalid ICO: ${filename}`);
    additions.set(`electron/resources/images/battery-tray/${filename}`, icon);
  }
  let offset = original.length - source.base;
  for (const [name, bytes] of additions) {
    const parts = name.split("/");
    let directory = source.header;
    for (const part of parts.slice(0, -1)) {
      directory.files ||= {};
      directory.files[part] ||= { files: {} };
      directory = directory.files[part];
    }
    const blockSize = 4 * 1024 * 1024;
    const blocks = [];
    for (let i = 0; i < bytes.length; i += blockSize) blocks.push(sha(bytes.subarray(i, i + blockSize)));
    directory.files[parts.at(-1)] = {
      size: bytes.length, offset: String(offset),
      integrity: { algorithm: "SHA256", hash: sha(bytes), blockSize, blocks },
    };
    offset += bytes.length;
  }
  const json = Buffer.from(JSON.stringify(source.header));
  const headerPickle = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4);
  headerPickle.writeUInt32LE(headerPickle.length - 4, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  json.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  const result = Buffer.concat([sizePickle, headerPickle, original.subarray(source.base), ...additions.values()]);
  const check = archive(result);
  for (const [name, bytes] of additions) if (!check.read(name).equals(bytes)) throw new Error(`Repack verification failed: ${name}`);
  return result;
}

function normalEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.NODE_INSPECT_RESUME_ON_START;
  return env;
}

function running(exe) {
  const command = 'Get-CimInstance Win32_Process -Filter "Name=\'RazerAppEngine.exe\'" | Where-Object { $_.ExecutablePath -eq $env:RAZER_PATCH_TARGET -and $_.ProcessId -ne [int]$env:RAZER_PATCH_PID -and (-not $_.CommandLine -or $_.CommandLine.IndexOf($env:RAZER_PATCH_SCRIPT,[StringComparison]::OrdinalIgnoreCase) -lt 0) } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
  const text = cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true, encoding: "utf8", env: { ...normalEnv(), RAZER_PATCH_TARGET: exe, RAZER_PATCH_PID: String(process.pid), RAZER_PATCH_SCRIPT: __filename },
  }).trim();
  if (!text) return [];
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : [value];
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function stop(exe) {
  if (!running(exe).length) return;
  console.log("Closing Synapse through its existing exit command...");
  const child = cp.spawn(exe, ["--exit-application"], { env: normalEnv(), detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await delay(1000);
    if (!running(exe).length) return;
  }
  throw new Error("Synapse did not exit normally. Original installed file has not been overwritten. Close Synapse and retry.");
}

async function start(exe) {
  const child = cp.spawn(exe, ["--url-params=apps=synapse", "--launch-force-hidden=synapse"], {
    env: normalEnv(), detached: true, stdio: "ignore", windowsHide: true,
  });
  child.unref();
  await delay(8000);
  if (!running(exe).some(p => !/\s--type=/.test(p.CommandLine || ""))) throw new Error("Synapse did not stay running after restart");
}

async function restart() {
  try {
    await start(process.execPath);
    console.log("Synapse restarted and its main process stayed running.");
  } catch (error) {
    console.error("Startup check failed; requesting restoration of the original resource file.");
    if (!process.env.RAZER_PATCH_INSTALLER) throw new Error(`Startup failed. Use the installer to restore this installation. ${error.message}`);
    cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", 'try { $argsLine = \'--worker restore "\' + $env:RAZER_PATCH_TARGET + \'"\'; $p = Start-Process -FilePath $env:RAZER_PATCH_INSTALLER -ArgumentList $argsLine -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { Write-Host $_.Exception.Message; exit 1 }'], {
      windowsHide: true, env: { ...normalEnv(), RAZER_PATCH_TARGET: process.execPath },
    });
    await start(process.execPath);
    throw new Error(`Original resource file restored after failed startup. ${error.message}`);
  }
}

async function install(mode, { exe = process.execPath, stopApp = stop } = {}) {
  const appDir = path.dirname(exe);
  const installedPath = path.join(appDir, "resources", "app.asar");
  const backupDir = path.join(appDir, "resources", "razer-battery-backup");
  const backupPath = path.join(backupDir, "original-app.asar");
  const receiptPath = path.join(backupDir, "install.json");
  const current = fs.readFileSync(installedPath);
  const currentHash = sha(current);
  const parsed = archive(current);
  const version = versionOf(parsed);
  const marker = parsed.entry(MARKER) ? JSON.parse(parsed.read(MARKER)) : null;
  if (mode === "status") {
    console.log(JSON.stringify({ executable: exe, version, sha256: currentHash, patched: !!marker, patchInfo: marker, backupExists: fs.existsSync(backupPath) }, null, 2));
    return;
  }
  let target;
  const previousReceipt = fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath) : null;
  function originalBackup() {
    if (!previousReceipt) throw new Error("Patch installation receipt is missing");
    const recorded = JSON.parse(previousReceipt);
    if (recorded.installedSha256 !== currentHash) throw new Error("Installed patch has changed; refusing to overwrite it");
    const original = fs.readFileSync(backupPath);
    if (!marker?.originalSha256 || recorded.originalSha256 !== marker.originalSha256 || sha(original) !== recorded.originalSha256) throw new Error("Backup hash mismatch");
    if (versionOf(archive(original)) !== version) throw new Error("Backup belongs to a different Synapse version");
    return original;
  }
  if (mode === "apply") {
    if (marker) {
      const original = originalBackup();
      target = build(original);
      if (sha(target) === currentHash) {
        console.log("This patch version is already installed. Nothing changed.");
        return;
      }
      console.log(`Updating installed patch to ${PATCH_VERSION} (21 icons, 5% steps).`);
    } else {
      target = build(current);
      fs.mkdirSync(backupDir, { recursive: true });
      if (!fs.existsSync(backupPath)) fs.copyFileSync(installedPath, backupPath, fs.constants.COPYFILE_EXCL);
      if (sha(fs.readFileSync(backupPath)) !== currentHash) throw new Error("Existing backup differs from this installation; keep it and check the installation folder");
    }
  } else if (mode === "restore") {
    if (!marker) { console.log("Original version is already installed. Nothing changed."); return; }
    target = originalBackup();
  } else throw new Error("Use apply, restore, status, or build");

  const targetHash = sha(target);
  console.log(`Verified ${mode} payload. Backup: ${backupPath}`);
  await stopApp(exe);
  try {
    fs.writeFileSync(installedPath, target);
    if (sha(fs.readFileSync(installedPath)) !== targetHash) throw new Error("Installed file hash mismatch");
    if (mode === "apply") fs.writeFileSync(receiptPath, JSON.stringify({ version: PATCH_VERSION, synapse: version, originalSha256: JSON.parse(archive(target).read(MARKER)).originalSha256, installedSha256: targetHash, installedAt: new Date().toISOString() }, null, 2));
  } catch (error) {
    console.error("Installation failed. Restoring the previous file:", error.message);
    await stopApp(exe);
    fs.writeFileSync(installedPath, current);
    if (previousReceipt) fs.writeFileSync(receiptPath, previousReceipt);
    if (sha(fs.readFileSync(installedPath)) !== currentHash) throw new Error("Rollback verification failed. Original backup remains available.");
    throw new Error(`Previous file restored. ${error.message}`);
  }
  console.log(`SUCCESS: ${mode}; resource file verified. SHA256 ${targetHash}`);
}

if (require.main === module) {
  (async () => {
    const mode = process.argv[2];
    if (mode === "build") {
      const [, , , input, output] = process.argv;
      if (!input || !output || path.resolve(input) === path.resolve(output)) throw new Error("build requires distinct input/output paths");
      const result = build(fs.readFileSync(input));
      fs.writeFileSync(output, result, { flag: "wx" });
      console.log(`Built and verified: ${output}\nSHA256 ${sha(result)}`);
    } else {
      if (path.basename(process.execPath).toLowerCase() !== "razerappengine.exe") throw new Error("Run operations through the installer, using the selected Razer runtime.");
      if (mode === "restart") await restart();
      else await install(mode);
    }
  })().catch(error => { console.error("ERROR:", error.message); process.exitCode = 1; });
}

module.exports = { archive, build, sha, transformMain, install };

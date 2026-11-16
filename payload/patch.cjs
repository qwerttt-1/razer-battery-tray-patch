"use strict";

const fs = require(process.versions.electron ? "original-fs" : "node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const VERSION = "4.0.896";
const PATCH_VERSION = "1.4";
const ORIGINAL_SHA256 = "e7a524aca1771251ca4f851441a97cac1c33929891b291ed34deb7adfc1831ec";
const MARKER = "razer-battery-patch.json";
const MAIN = "electron/main.js";
const ANCHOR = 'hn=new t(Ao),hn.on("click",Jn)';
const INSERT = 'hn=new t(Ao),(()=>{try{require("./lib/batteryTrayPatch").attach({tray:hn,storage:b.windowStorage,nativeImage:r,originalImage:Ao,app:e})}catch(error){console.warn("[RazerBatteryTrayPatch] Initialization failed:",error.message)}})(),hn.on("click",Jn)';
const TOOLTIP_ANCHOR = 'hn.setToolTip("Razer")';
const TOOLTIP_INSERT = 'hn.setToolTip(require("./lib/batteryTrayPatch").selectState(b.windowStorage,b.lang).tooltip||"Razer")';
const sha = data => crypto.createHash("sha256").update(data).digest("hex");

function archive(data) {
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

function build(original, packageDir = __dirname) {
  if (sha(original) !== ORIGINAL_SHA256) throw new Error("Unsupported or modified app.asar. Supported original: Synapse 4.0.896 only.");
  const source = archive(original);
  if (JSON.parse(source.read("package.json")).version !== VERSION) throw new Error("Version mismatch");
  const main = source.read(MAIN).toString("utf8");
  if (main.split(ANCHOR).length !== 2) throw new Error("Tray creation anchor is not unique");
  if (main.split(TOOLTIP_ANCHOR).length !== 2) throw new Error("Menu tooltip reset anchor is not unique");
  const additions = new Map([
    [MAIN, Buffer.from(main.replace(ANCHOR, INSERT).replace(TOOLTIP_ANCHOR, TOOLTIP_INSERT))],
    ["electron/lib/batteryTrayPatch.js", fs.readFileSync(path.join(packageDir, "batteryTrayPatch.js"))],
    [MARKER, Buffer.from(JSON.stringify({ version: PATCH_VERSION, synapse: VERSION, step: 5, iconCount: 21, originalSha256: ORIGINAL_SHA256 }))],
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
    cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", 'try { $p = Start-Process -FilePath $env:RAZER_PATCH_LAUNCHER -ArgumentList @("restore","elevated") -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { Write-Host $_.Exception.Message; exit 1 }'], {
      windowsHide: true, env: { ...normalEnv(), RAZER_PATCH_LAUNCHER: path.join(__dirname, "run.cmd") },
    });
    await start(process.execPath);
    throw new Error(`Original resource file restored after failed startup. ${error.message}`);
  }
}

async function install(mode) {
  if (path.basename(process.execPath).toLowerCase() !== "razerappengine.exe") throw new Error("Use the supplied CMD launcher, which uses the installed Razer runtime.");
  const exe = process.execPath;
  const appDir = path.dirname(exe);
  const installedPath = path.join(appDir, "resources", "app.asar");
  const backupDir = path.join(appDir, "resources", "razer-battery-backup");
  const backupPath = path.join(backupDir, "original-app.asar");
  const receiptPath = path.join(backupDir, "install.json");
  const current = fs.readFileSync(installedPath);
  const currentHash = sha(current);
  const parsed = archive(current);
  if (JSON.parse(parsed.read("package.json")).version !== VERSION) throw new Error("Unsupported Synapse version");
  if (mode === "status") {
    console.log(JSON.stringify({ executable: exe, version: VERSION, sha256: currentHash, patched: !!parsed.entry(MARKER), patchInfo: parsed.entry(MARKER) ? JSON.parse(parsed.read(MARKER)) : null, backupExists: fs.existsSync(backupPath) }, null, 2));
    return;
  }
  let target;
  const previousReceipt = fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath) : null;
  if (mode === "apply") {
    if (parsed.entry(MARKER)) {
      const recorded = JSON.parse(previousReceipt);
      if (recorded.installedSha256 !== currentHash) throw new Error("Installed patch has changed; refusing to overwrite it");
      const original = fs.readFileSync(backupPath);
      if (sha(original) !== ORIGINAL_SHA256) throw new Error("Backup hash mismatch");
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
      if (sha(fs.readFileSync(backupPath)) !== ORIGINAL_SHA256) throw new Error("Backup hash mismatch");
    }
  } else if (mode === "restore") {
    if (currentHash === ORIGINAL_SHA256) { console.log("Original version is already installed. Nothing changed."); return; }
    if (!parsed.entry(MARKER)) throw new Error("This is not our patch. Refusing to overwrite changed application files.");
    const recorded = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (recorded.installedSha256 !== currentHash) throw new Error("Installed patch has changed; refusing to overwrite it");
    target = fs.readFileSync(backupPath);
    if (sha(target) !== ORIGINAL_SHA256) throw new Error("Backup hash mismatch");
  } else throw new Error("Use apply, restore, status, or build");

  const targetHash = sha(target);
  console.log(`Verified ${mode} payload. Backup: ${backupPath}`);
  await stop(exe);
  try {
    fs.writeFileSync(installedPath, target);
    if (sha(fs.readFileSync(installedPath)) !== targetHash) throw new Error("Installed file hash mismatch");
    if (mode === "apply") fs.writeFileSync(receiptPath, JSON.stringify({ version: PATCH_VERSION, synapse: VERSION, originalSha256: ORIGINAL_SHA256, installedSha256: targetHash, installedAt: new Date().toISOString() }, null, 2));
  } catch (error) {
    console.error("Installation failed. Restoring the previous file:", error.message);
    await stop(exe);
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
    } else if (mode === "restart") await restart();
    else await install(mode);
  })().catch(error => { console.error("ERROR:", error.message); process.exitCode = 1; });
}

module.exports = { archive, build, sha, ORIGINAL_SHA256, TOOLTIP_ANCHOR, TOOLTIP_INSERT };

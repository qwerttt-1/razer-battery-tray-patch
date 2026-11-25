"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const helper = require("../payload/batteryTrayPatch.js");
const { archive, transformMain, install, sha, build } = require("../payload/patch.cjs");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function mainFixture({ tray = "hn", Tray = "t", app = "e", image = "Ao", nativeImage = "r", globalVar = "b" } = {}) {
  return `const {app:${app},Tray:${Tray},nativeImage:${nativeImage}}=require("electron"),{globalNodeVar:${globalVar}}=require("./lib/globalNodeVar");let ${tray};const ${image}="icon";${tray}=new ${Tray}(${image}),${tray}.on("click",()=>{});${tray}.setToolTip("Razer");void ${globalVar}.windowStorage;`;
}
const { tooltipAnchor: TOOLTIP_ANCHOR, tooltipInsert: TOOLTIP_INSERT } = transformMain(mainFixture());

// Minimal invented fixtures exercise the archive format without shipping vendor files.
function pack(files) {
  const header = { files: {} }, bodies = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.from(value);
    const parts = name.split("/"); let node = header;
    for (const part of parts.slice(0,-1)) node = (node.files[part] ||= { files: {} });
    node.files[parts.at(-1)] = { size: bytes.length, offset: String(offset) };
    offset += bytes.length; bodies.push(bytes);
  }
  const json = Buffer.from(JSON.stringify(header));
  const hp = Buffer.alloc(8 + Math.ceil(json.length/4)*4); hp.writeUInt32LE(hp.length-4); hp.writeUInt32LE(json.length,4); json.copy(hp,8);
  const sp = Buffer.alloc(8); sp.writeUInt32LE(4); sp.writeUInt32LE(hp.length,4);
  return Buffer.concat([sp,hp,...bodies]);
}
function fixture(version = "4.2.1200", aliases) {
  return pack({ "package.json": JSON.stringify({ version }), "electron/main.js": mainFixture(aliases), "electron/modules/window_storage/index.js": "windowStorageMap callFunction setWindowStorageItem removeWindowStorageItem" });
}

function state(level, chargingStatus = "NoCharge_BatteryFull") {
  return { hasBattery: true, name: { en: "Razer Mouse" }, powerStatus: { level, chargingStatus } };
}
function storageFor(...devices) {
  return { windowStorageMap: new Map(devices.map((device, index) => [String(index), new Map([["connectedDevices", JSON.stringify(device)]])])) };
}

test("all 101 integer percentages follow the documented ranges", () => {
  const ranges = [[0,4,0],[5,9,5],[10,14,10],[15,19,15],[20,24,20],[25,29,25],[30,34,30],[35,39,35],[40,44,40],[45,48,45],[49,51,50],[52,55,55],[56,60,60],[61,65,65],[66,70,70],[71,75,75],[76,80,80],[81,85,85],[86,90,90],[91,95,95],[96,100,100]];
  let count = 0;
  for (const [from,to,bucket] of ranges) for (let value=from;value<=to;value++) {
    const result = helper.selectState(storageFor(state(value)));
    assert.equal(result.bucket,bucket,`${value}%`);
    assert.match(result.tooltip,new RegExp(`${value}%`));
    count++;
  }
  assert.equal(count,101);
});

test("lowest valid connected battery is selected", () => {
  const result = helper.selectState(storageFor(state(79),state(22),state(null,"off"),state(null),state(101)));
  assert.equal(result.bucket,20);
  assert.equal(result.devices.length,2);
  assert.equal(helper.selectState(storageFor()).bucket,null);
});

test("charging text reflects exact battery rather than the icon bucket", () => {
  const result = helper.selectState(storageFor(state(78,"Charging")));
  assert.equal(result.bucket,80);
  assert.match(result.tooltip,/78% \(Charging\)/);
});

test("charging animates every 500 ms from the current bucket and stops when charging ends", () => {
  const modulePath = require.resolve("../payload/batteryTrayPatch.js");
  const module = { exports: {} };
  const timers = new Map();
  let nextTimer = 0;
  vm.runInNewContext(fs.readFileSync(modulePath, "utf8"), {
    module, require, __dirname: path.dirname(modulePath), console,
    setInterval(callback, delay) {
      assert.equal(delay, 500);
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearInterval: timer => timers.delete(timer),
  });
  const storage = storageFor(state(78, "Charging"));
  const app = new EventEmitter();
  app.getLocale = () => "en";
  const frames = [], loaded = [];
  let tooltip;
  const tray = {
    isDestroyed: () => false,
    setImage: image => frames.push(image.name ?? image),
    setToolTip: value => { tooltip = value; },
  };
  const nativeImage = {
    createFromPath(file) {
      const name = path.basename(file);
      loaded.push(name);
      return { name, isEmpty: () => false };
    },
  };
  const hooks = module.exports.attach({ tray, storage, nativeImage, originalImage: "original", app });
  function update(...devices) {
    storage.windowStorageMap = storageFor(...devices).windowStorageMap;
    hooks.refresh();
  }
  function tick() {
    assert.equal(timers.size, 1);
    timers.values().next().value();
  }
  try {
    assert.equal(frames.at(-1), "battery_080.ico");
    tick();
    update(state(79, "Charging"));
    assert.equal(frames.at(-1), "battery_085.ico");
    for (let step = 0; step < 4; step++) tick();
    assert.deepEqual(frames, [80, 85, 90, 95, 100, 80].map(level => `battery_${String(level).padStart(3, "0")}.ico`));
    assert.equal(loaded.length, 5);
    assert.match(tooltip, /79% \(Charging\)/);
    update(state(86, "Charging"));
    assert.equal(frames.at(-1), "battery_090.ico");
    tick();
    update(state(86));
    assert.equal(timers.size, 0);
    assert.equal(frames.at(-1), "battery_090.ico");
    update(state(99, "Charging"));
    assert.equal(timers.size, 0);
    assert.equal(frames.at(-1), "battery_100.ico");
    update(state(60), state(70, "Charging"));
    assert.equal(timers.size, 0);
    assert.equal(frames.at(-1), "battery_060.ico");
    update(state(86, "Charging"));
    tick();
    update(state(0, "off"));
    assert.equal(timers.size, 0);
    assert.equal(frames.at(-1), "battery_090.ico");
    assert.match(tooltip, /86% \(Last reported\)/);
    update(state(86, "Charging"));
    tick();
    update();
    assert.equal(timers.size, 0);
    assert.equal(frames.at(-1), "original");
    update(state(86, "Charging"));
  } finally {
    app.emit("before-quit");
  }
  assert.equal(timers.size, 0);
  assert.equal(storage.callFunction, undefined);
  hooks.dispose();
});

test("menu rebuild tooltip expression fixes the original overwrite", () => {
  const storage = storageFor(state(79));
  const app = new EventEmitter(); app.getLocale=()=>"en";
  const tray = new EventEmitter();
  let tip="";
  tray.isDestroyed=()=>false; tray.setImage=()=>{}; tray.setToolTip=value=>{tip=value;};
  storage.callFunction=()=>Promise.resolve();
  const hooks=helper.attach({tray,storage,app,originalImage:"original",nativeImage:{createFromPath:()=>({isEmpty:()=>false})}});
  const context={hn:tray,b:{windowStorage:storage,lang:"en"},require:name=>{assert.equal(name,"./lib/batteryTrayPatch");return helper;}};
  vm.runInNewContext(TOOLTIP_ANCHOR,context);
  hooks.refresh();
  assert.equal(tip,"Razer","Reproduce the old unchanged-state cache failure");
  for(let i=0;i<3;i++) { vm.runInNewContext(TOOLTIP_INSERT,context); hooks.refresh(); assert.match(tip,/Razer Mouse: 79%/); }
  storage.windowStorageMap=storageFor(state(78,"Charging")).windowStorageMap;
  hooks.refresh(); vm.runInNewContext(TOOLTIP_INSERT,context);
  assert.match(tip,/78% \(Charging\)/);
  storage.windowStorageMap.clear(); hooks.refresh(); vm.runInNewContext(TOOLTIP_INSERT,context);
  assert.equal(tip,"Razer");
  hooks.dispose();
});

test("sleep preserves the last reported battery until a new reading or device removal", async () => {
  const storage = storageFor(state(0, "off"));
  storage.callFunction = (_event, { action, payload }) => {
    if (action === "removeWindowStorageItem") storage.windowStorageMap.get("0").delete(payload.key);
    else storage.windowStorageMap.get("0").set(payload.key, payload.value);
  };
  const images = [];
  let tooltip;
  const tray = {
    isDestroyed: () => false,
    setImage: value => images.push(value),
    setToolTip: value => { tooltip = value; },
  };
  const app = new EventEmitter();
  app.getLocale = () => "en";
  const nativeImage = { createFromPath: file => ({ file, isEmpty: () => false }) };
  const originalImage = "original";
  const hooks = helper.attach({ tray, storage, app, nativeImage, originalImage });
  const update = async (device) => {
    const action = device ? "setWindowStorageItem" : "removeWindowStorageItem";
    await storage.callFunction(null, { action, payload: { key: "connectedDevices", value: JSON.stringify(device) } });
  };
  try {
    assert.deepEqual(images, [originalImage]);
    assert.equal(tooltip, "");
    await update(state(69));
    assert.match(images.at(-1).file, /battery_070\.ico$/);
    await update(state(0, "off"));
    assert.equal(images.length, 2);
    assert.match(tooltip, /69% \(Last reported\)/);
    const context = { hn: tray, b: { windowStorage: storage, lang: "en" }, require: () => helper };
    vm.runInNewContext(TOOLTIP_INSERT, context);
    assert.match(tooltip, /69% \(Last reported\)/);
    await update(state(64));
    assert.match(images.at(-1).file, /battery_065\.ico$/);
    assert.match(tooltip, /64%$/);
    await update();
    assert.equal(images.at(-1), originalImage);
    assert.equal(tooltip, "");
    await update(state(69, "off"));
    assert.equal(images.at(-1), originalImage);
    assert.equal(tooltip, "");
  } finally {
    hooks.dispose();
  }
});

test("wake keeps the last reading through a transient 100% and accepts a sustained 100%", () => {
  const modulePath = require.resolve("../payload/batteryTrayPatch.js");
  const module = { exports: {} };
  const timers = new Map();
  let now = 10000;
  let nextTimer = 0;
  vm.runInNewContext(fs.readFileSync(modulePath, "utf8"), {
    module, require, __dirname: path.dirname(modulePath), console,
    Date: { now: () => now },
    setTimeout(callback, delay) {
      timers.set(++nextTimer, { callback, deadline: now + delay });
      return nextTimer;
    },
    clearTimeout: timer => timers.delete(timer),
    clearInterval,
  });
  const storage = storageFor(state(76));
  const app = new EventEmitter();
  app.getLocale = () => "en";
  const frames = [];
  let tooltip;
  const tray = {
    isDestroyed: () => false,
    setImage: image => frames.push(image.name),
    setToolTip: value => { tooltip = value; },
  };
  const nativeImage = { createFromPath: file => ({ name: path.basename(file), isEmpty: () => false }) };
  const hooks = module.exports.attach({ tray, storage, nativeImage, originalImage: {}, app });
  function update(device) {
    storage.windowStorageMap = storageFor(device).windowStorageMap;
    hooks.refresh();
  }
  try {
    update(state(76, "off"));
    update(state(100));
    const context = { hn: tray, b: { windowStorage: storage, lang: "en" }, require: () => module.exports };
    now += 1900;
    vm.runInNewContext(TOOLTIP_INSERT, context);
    hooks.refresh();
    assert.deepEqual(frames, ["battery_080.ico"]);
    assert.match(tooltip, /76% \(Last reported\)/);
    assert.equal(timers.size, 1);
    assert.equal(timers.values().next().value.deadline, 13000);
    update(state(75));
    assert.deepEqual(frames, ["battery_080.ico", "battery_075.ico"]);
    assert.match(tooltip, /75%$/);
    assert.equal(timers.size, 0);
    update(state(75, "off"));
    update(state(100));
    const [id, { callback, deadline }] = timers.entries().next().value;
    now = deadline;
    timers.delete(id);
    callback();
    assert.equal(frames.at(-1), "battery_100.ico");
    assert.match(tooltip, /100%$/);
    assert.equal(timers.size, 0);
  } finally {
    hooks.dispose();
  }
});

test("unknown archive inputs are rejected before any installation",()=>{
  assert.throws(()=>build(Buffer.from("unsupported")),/Unsupported/);
});

test("4.X versions and renamed minified bindings are patched without fixed hashes", () => {
  for (const version of ["4.0.896", "4.2.1200", "4.99.1"]) {
    const original = fixture(version, {tray:"$tray",Tray:"TT",app:"application",image:"logo",nativeImage:"ni",globalVar:"gv"});
    const result = archive(build(original));
    assert.equal(JSON.parse(result.read("razer-battery-patch.json")).synapse,version);
    assert.equal(JSON.parse(result.read("razer-battery-patch.json")).originalSha256,sha(original));
    let attached;
    class Tray extends EventEmitter { setToolTip() {} }
    vm.runInNewContext(result.read("electron/main.js").toString(), { require: name => {
      if (name === "electron") return {Tray,app:{},nativeImage:{}};
      if (name === "./lib/globalNodeVar") return {globalNodeVar:{windowStorage:{}}};
      return {attach:value=>{attached=value;},selectState:()=>({tooltip:"79%"})};
    }});
    assert.equal(attached.originalImage,"icon"); assert.ok(attached.tray instanceof Tray);
  }
});

test("changed architecture, ambiguous anchors and other major versions stop before patching", () => {
  assert.throws(()=>build(fixture("5.0.1")),/Expected Synapse 4/);
  assert.throws(()=>transformMain(mainFixture()+'hn=new t(Ao);'),/not unique/);
  assert.throws(()=>transformMain(mainFixture().replace('hn.setToolTip("Razer")','hn.setToolTip("Changed")')),/structure/);
  assert.throws(()=>build(pack({"package.json":'{"version":"4.1.1"}',"electron/main.js":mainFixture(),"electron/modules/window_storage/index.js":"different API"})),/storage API/);
});

test("apply, repeat, legacy upgrade and restore keep each installation's own backup", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(),"Razer 补丁测试 "));
  const exe = path.join(folder,"RazerAppEngine.exe"), resources = path.join(folder,"resources");
  fs.mkdirSync(resources);
  const installed = path.join(resources,"app.asar");
  const original = fixture("4.7.123"); fs.writeFileSync(installed,original);
  let stops = 0; const options = {exe,stopApp:async()=>{stops++;}};
  await install("apply", options);
  const patched = fs.readFileSync(installed);
  await install("apply", options); assert.equal(stops,1); assert.deepEqual(fs.readFileSync(installed),patched);
  const backupDir = path.join(resources,"razer-battery-backup");
  const receiptPath = path.join(backupDir,"install.json");
  // A 1.4 receipt and marker used the same original/installed hash contract.
  const parsed = archive(patched), marker = JSON.parse(parsed.read("razer-battery-patch.json")); marker.version="1.4";
  const legacy = pack({"package.json":parsed.read("package.json"),"electron/main.js":parsed.read("electron/main.js"),"razer-battery-patch.json":JSON.stringify(marker)});
  fs.writeFileSync(installed,legacy);
  const receipt = JSON.parse(fs.readFileSync(receiptPath)); receipt.version="1.4";receipt.installedSha256=sha(legacy);fs.writeFileSync(receiptPath,JSON.stringify(receipt));
  await install("apply",options); assert.deepEqual(fs.readFileSync(installed),patched);
  fs.appendFileSync(path.join(backupDir,"original-app.asar"),"tampered");
  await assert.rejects(install("restore",options),/Backup hash mismatch/);assert.equal(stops,2);
  fs.writeFileSync(path.join(backupDir,"original-app.asar"),original);
  await install("restore",options);assert.deepEqual(fs.readFileSync(installed),original);
  await install("restore",options);assert.equal(stops,3);
  // Retain test files for inspection; tests never remove user files.
});

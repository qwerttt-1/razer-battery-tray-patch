"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const helper = require("../payload/batteryTrayPatch.js");
const { TOOLTIP_ANCHOR, TOOLTIP_INSERT, build } = require("../payload/patch.cjs");

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
  const result = helper.selectState(storageFor(state(79),state(22),state(1,"off"),state(null),state(101)));
  assert.equal(result.bucket,20);
  assert.equal(result.devices.length,2);
  assert.equal(helper.selectState(storageFor()).bucket,null);
});

test("charging text reflects exact battery rather than the icon bucket", () => {
  const result = helper.selectState(storageFor(state(78,"Charging")));
  assert.equal(result.bucket,80);
  assert.match(result.tooltip,/78% \(Charging\)/);
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

test("unknown archive inputs are rejected before any installation",()=>{
  assert.throws(()=>build(Buffer.from("unsupported")),/Unsupported/);
});

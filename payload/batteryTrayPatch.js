"use strict";

const path = require("node:path");
const PREFIX = "[RazerBatteryTrayPatch]";
const batteryReadings = new WeakMap();

function localizedName(device, locale) {
  for (const field of [device.productName, device.editionName, device.name]) {
    if (typeof field === "string" && field) return field;
    if (field && typeof field === "object") {
      const value = field[locale] || field[locale?.split("-")[0]] || field.en || Object.values(field).find(v => typeof v === "string" && v);
      if (value) return value;
    }
  }
  return "Razer";
}

function selectState(storage, locale = "en") {
  const previousReadings = batteryReadings.get(storage);
  const readings = new Map();
  const devices = [];
  for (const [key, values] of storage.windowStorageMap) {
    const raw = values.get("connectedDevices");
    if (raw === undefined) continue;
    let device;
    try { device = typeof raw === "string" ? JSON.parse(raw) : raw; }
    catch { continue; }
    if (!device || device.hasBattery === false || !device.powerStatus) continue;
    const { level, chargingStatus } = device.powerStatus;
    const lastReported = chargingStatus === "off";
    const productId = device.realProductId ?? device.productId;
    const previous = previousReadings?.get(key);
    if (lastReported && (!previous || previous.productId !== productId)) continue;
    const percent = lastReported ? previous.percent : level;
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) continue;
    readings.set(key, { productId, percent });
    devices.push({
      name: localizedName(device, locale),
      percent,
      charging: chargingStatus === "Charging",
      lastReported,
    });
  }
  batteryReadings.set(storage, readings);
  if (!devices.length) return { bucket: null, tooltip: "", devices: [] };
  devices.sort((a, b) => a.percent - b.percent || a.name.localeCompare(b.name));
  const percent = devices[0].percent;
  let bucket = 50;
  if (percent < 49) bucket = Math.floor(percent / 5) * 5;
  else if (percent > 51) bucket = Math.ceil(percent / 5) * 5;
  return {
    bucket,
    tooltip: ("Razer Synapse\n" + devices.map(d => {
      const status = d.lastReported ? " (Last reported)" : d.charging ? " (Charging)" : "";
      return `${d.name}: ${d.percent}%${status}`;
    }).join("\n")).slice(0, 127),
    devices,
  };
}

function attach({ tray, storage, nativeImage, originalImage, app }) {
  const originalCall = storage.callFunction;
  let stopped = false;
  let queued = false;
  let baseBucket;
  let displayedBucket;
  let tooltip;
  let animation;
  const images = new Map();
  const locale = app.getLocale();

  function showBucket(bucket) {
    if (bucket === displayedBucket) return;
    let image = originalImage;
    if (bucket !== null) {
      image = images.get(bucket);
      if (!image) {
        const filename = `battery_${String(bucket).padStart(3, "0")}.ico`;
        image = nativeImage.createFromPath(path.join(__dirname, "../resources/images/battery-tray", filename));
        if (image.isEmpty()) throw new Error(`Cannot load ${filename}`);
        images.set(bucket, image);
      }
    }
    tray.setImage(image);
    displayedBucket = bucket;
  }

  function stopAnimation() {
    clearInterval(animation);
    animation = undefined;
  }

  function advanceFrame() {
    if (stopped || tray.isDestroyed()) {
      stopAnimation();
      return;
    }
    try {
      showBucket(displayedBucket === 100 ? baseBucket : displayedBucket + 5);
    } catch (error) {
      stopAnimation();
      console.warn(PREFIX, "Charging animation failed:", error.message);
    }
  }

  function refresh() {
    if (stopped || tray.isDestroyed()) {
      stopAnimation();
      return;
    }
    try {
      const state = selectState(storage, locale);
      const animate = state.devices[0]?.charging && state.bucket < 100;
      if (animation && (state.bucket !== baseBucket || !animate)) stopAnimation();
      if (!animation) {
        showBucket(state.bucket);
        baseBucket = state.bucket;
        if (animate) animation = setInterval(advanceFrame, 500);
      }
      if (state.tooltip !== tooltip) {
        tray.setToolTip(state.tooltip);
        tooltip = state.tooltip;
        console.log(PREFIX, JSON.stringify({ state: state.bucket === null ? "no-device" : "active", bucket: state.bucket, devices: state.devices }));
      }
    } catch (error) {
      console.warn(PREFIX, "Update failed:", error.message);
    }
  }

  function schedule() {
    if (stopped || queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; refresh(); });
  }

  function wrapped(event, arg) {
    const result = originalCall.call(storage, event, arg);
    if ((arg?.action === "setWindowStorageItem" || arg?.action === "removeWindowStorageItem") && arg?.payload?.key === "connectedDevices" || arg?.action === "clearWindowStorage" || arg?.action === "resetWindowStorage") schedule();
    return result;
  }

  function dispose() {
    stopped = true;
    stopAnimation();
    if (storage.callFunction === wrapped) storage.callFunction = originalCall;
    app.removeListener("before-quit", dispose);
    images.clear();
  }

  storage.callFunction = wrapped;
  app.once("before-quit", dispose);
  console.log(PREFIX, "Installed 1.7.0 (21 icons, charging animation, last reported battery when off)");
  refresh();
  return { refresh, dispose };
}

module.exports = { attach, selectState };

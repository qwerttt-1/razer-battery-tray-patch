"use strict";

const path = require("node:path");
const PREFIX = "[RazerBatteryTrayPatch]";

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
  const devices = [];
  for (const values of storage.windowStorageMap.values()) {
    const raw = values.get("connectedDevices");
    if (raw === undefined) continue;
    let device;
    try { device = typeof raw === "string" ? JSON.parse(raw) : raw; }
    catch { continue; }
    if (!device || device.hasBattery === false || !device.powerStatus) continue;
    const { level, chargingStatus } = device.powerStatus;
    if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 100 || chargingStatus === "off") continue;
    devices.push({ name: localizedName(device, locale), percent: level, charging: chargingStatus === "Charging" });
  }
  if (!devices.length) return { bucket: null, tooltip: "", devices: [] };
  devices.sort((a, b) => a.percent - b.percent || a.name.localeCompare(b.name));
  const percent = devices[0].percent;
  let bucket = 50;
  if (percent < 49) bucket = Math.floor(percent / 5) * 5;
  else if (percent > 51) bucket = Math.ceil(percent / 5) * 5;
  return {
    bucket,
    tooltip: ("Razer Synapse\n" + devices.map(d => `${d.name}: ${d.percent}%${d.charging ? " (Charging)" : ""}`).join("\n")).slice(0, 127),
    devices,
  };
}

function attach({ tray, storage, nativeImage, originalImage, app }) {
  const originalCall = storage.callFunction;
  let stopped = false;
  let queued = false;
  let bucket;
  let tooltip;
  let image = null;
  const locale = app.getLocale();

  function refresh() {
    if (stopped || tray.isDestroyed()) return;
    try {
      const state = selectState(storage, locale);
      if (state.bucket !== bucket) {
        if (state.bucket === null) {
          tray.setImage(originalImage);
          image = null;
        } else {
          const filename = `battery_${String(state.bucket).padStart(3, "0")}.ico`;
          const next = nativeImage.createFromPath(path.join(__dirname, "../resources/images/battery-tray", filename));
          if (next.isEmpty()) throw new Error(`Cannot load ${filename}`);
          tray.setImage(next);
          image = next;
        }
        bucket = state.bucket;
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
    if (storage.callFunction === wrapped) storage.callFunction = originalCall;
    app.removeListener("before-quit", dispose);
    image = null;
  }

  storage.callFunction = wrapped;
  app.once("before-quit", dispose);
  console.log(PREFIX, "Installed 1.5 (21 icons, 49-51%=50%; above ceil/below floor, storage events, no polling)");
  refresh();
  return { refresh, dispose };
}

module.exports = { attach, selectState };

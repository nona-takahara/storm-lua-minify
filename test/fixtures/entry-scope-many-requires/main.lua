local nTracsObject = require("n_tracs_object")
local nTracsCore = require("ntracs")
local area = require("area")
local trackBridge = require("track_bridge")
local track = require("track")
local signal = require("signal")
local switchBridge = require("switch_bridge")
local routeDirection = require("route_direction")
local switchDef = require("switch_def")
local vehicleInfo = require("vehicle_info")
local autoSignal = require("auto_signal")

print(
  nTracsObject,
  nTracsCore,
  area,
  trackBridge,
  track,
  signal,
  switchBridge,
  routeDirection,
  switchDef,
  vehicleInfo,
  autoSignal
)

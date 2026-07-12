function require(m,r)package=package or{loaded={}};if package.loaded[m]then return package.loaded[m]end
if m=="auto_signal"then r=(function() local F="auto_signal"return{id=F} end)()end
if m=="vehicle_info"then r=(function() local D="vehicle_info"return{id=D} end)()end
if m=="switch_def"then r=(function() local B="switch_def"return{id=B} end)()end
if m=="route_direction"then r=(function() local z="route_direction"return{id=z} end)()end
if m=="switch_bridge"then r=(function() local x="switch_bridge"return{id=x} end)()end
if m=="signal"then r=(function() local v="signal"return{id=v} end)()end
if m=="track"then r=(function() local t="track"return{id=t} end)()end
if m=="track_bridge"then r=(function() local r="track_bridge"return{id=r} end)()end
if m=="area"then r=(function() local p="area"return{id=p} end)()end
if m=="ntracs"then r=(function() local n="ntracs"return{id=n} end)()end
if m=="n_tracs_object"then r=(function() local l="n_tracs_object"return{id=l} end)()end
package.loaded[m]=package.loaded[m]or r or true;return package.loaded[m]end
local k=require("n_tracs_object")local m=require("ntracs")local o=require("area")local q=require("track_bridge")local s=require("track")local u=require("signal")local w=require("switch_bridge")local y=require("route_direction")local A=require("switch_def")local C=require("vehicle_info")local E=require("auto_signal")print(k,m,o,q,s,u,w,y,A,C,E)
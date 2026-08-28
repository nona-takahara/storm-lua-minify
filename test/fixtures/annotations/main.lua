--# file header
--@storm export
function onTick()
  print("tick")
end

configuredGlobal = 4
print(configuredGlobal)

--@storm keep
local retained = 1

--@storm keep-name
local descriptive = 2
print(descriptive)

--# before call
print(retained) --# after call

do
  print("nested") --# nested trailing
end

local unused = 3

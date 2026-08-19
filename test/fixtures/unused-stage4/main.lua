--# before effects
local unusedModule, unusedResult = require("dep"), sideEffect() --# after effects

--@storm keep-name
local removableName = 1

local retained, removable = produce(), 2
print(retained)

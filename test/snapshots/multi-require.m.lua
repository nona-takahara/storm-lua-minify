function require(m,r)package=package or{loaded={}};if package.loaded[m]then return package.loaded[m]end
if m=="common"then r=(function() return{value=42} end)()end
package.loaded[m]=package.loaded[m]or r or true;return package.loaded[m]end
local i=require("common")local j=require("common")print(i.value,j.value)
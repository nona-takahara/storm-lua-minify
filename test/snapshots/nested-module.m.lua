function require(m,r)package=package or{loaded={}};if package.loaded[m]then return package.loaded[m]end
if m=="sub.deep"then r=(function() return{value=1} end)()end
package.loaded[m]=package.loaded[m]or r or true;return package.loaded[m]end
local a=require("sub.deep")print(a.value)
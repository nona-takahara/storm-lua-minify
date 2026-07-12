function require(m,r)package=package or{loaded={}};if package.loaded[m]then return package.loaded[m]end
if m=="mod"then r=(function() local function h()return"hello"end
return{hello=h} end)()end
package.loaded[m]=package.loaded[m]or r or true;return package.loaded[m]end
local g=require("mod")print(g.hello())
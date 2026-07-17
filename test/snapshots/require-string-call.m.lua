function require(m,r)package=package or{loaded={}};if package.loaded[m]then return package.loaded[m]end
if m=="mod"then r=(function() local function a()return"hello"end
return{hello=a} end)()end
package.loaded[m]=package.loaded[m]or r or true;return package.loaded[m]end
local b=require"mod"print(b.hello())
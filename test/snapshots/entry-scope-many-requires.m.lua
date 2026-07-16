function require(m,r)package=package or{loaded={}};if package.loaded[m]then return package.loaded[m]end
if m=="dep_alpha"then r=(function() local a="dep_alpha"return{id=a} end)()end
if m=="dep_bravo"then r=(function() local b="dep_bravo"return{id=b} end)()end
if m=="dep_charlie"then r=(function() local c="dep_charlie"return{id=c} end)()end
if m=="dep_delta"then r=(function() local d="dep_delta"return{id=d} end)()end
if m=="dep_echo"then r=(function() local e="dep_echo"return{id=e} end)()end
if m=="dep_foxtrot"then r=(function() local f="dep_foxtrot"return{id=f} end)()end
if m=="dep_golf"then r=(function() local g="dep_golf"return{id=g} end)()end
if m=="dep_hotel"then r=(function() local h="dep_hotel"return{id=h} end)()end
if m=="dep_india"then r=(function() local i="dep_india"return{id=i} end)()end
if m=="dep_juliet"then r=(function() local j="dep_juliet"return{id=j} end)()end
if m=="dep_kilo"then r=(function() local k="dep_kilo"return{id=k} end)()end
package.loaded[m]=package.loaded[m]or r or true;return package.loaded[m]end
local l=require("dep_alpha")local m=require("dep_bravo")local n=require("dep_charlie")local o=require("dep_delta")local p=require("dep_echo")local q=require("dep_foxtrot")local r=require("dep_golf")local s=require("dep_hotel")local t=require("dep_india")local u=require("dep_juliet")local v=require("dep_kilo")print(l,m,n,o,p,q,r,s,t,u,v)
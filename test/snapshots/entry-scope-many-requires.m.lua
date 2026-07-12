function require(m,r)package=package or{loaded={}};if package.loaded[m]then return package.loaded[m]end
if m=="dep_kilo"then r=(function() local F="dep_kilo"return{id=F} end)()end
if m=="dep_juliet"then r=(function() local D="dep_juliet"return{id=D} end)()end
if m=="dep_india"then r=(function() local B="dep_india"return{id=B} end)()end
if m=="dep_hotel"then r=(function() local z="dep_hotel"return{id=z} end)()end
if m=="dep_golf"then r=(function() local x="dep_golf"return{id=x} end)()end
if m=="dep_foxtrot"then r=(function() local v="dep_foxtrot"return{id=v} end)()end
if m=="dep_echo"then r=(function() local t="dep_echo"return{id=t} end)()end
if m=="dep_delta"then r=(function() local r="dep_delta"return{id=r} end)()end
if m=="dep_charlie"then r=(function() local p="dep_charlie"return{id=p} end)()end
if m=="dep_bravo"then r=(function() local n="dep_bravo"return{id=n} end)()end
if m=="dep_alpha"then r=(function() local l="dep_alpha"return{id=l} end)()end
package.loaded[m]=package.loaded[m]or r or true;return package.loaded[m]end
local k=require("dep_alpha")local m=require("dep_bravo")local o=require("dep_charlie")local q=require("dep_delta")local s=require("dep_echo")local u=require("dep_foxtrot")local w=require("dep_golf")local y=require("dep_hotel")local A=require("dep_india")local C=require("dep_juliet")local E=require("dep_kilo")print(k,m,o,q,s,u,w,y,A,C,E)
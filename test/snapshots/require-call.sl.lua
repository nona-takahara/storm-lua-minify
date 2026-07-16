local a=(function() local function b()return"hello"end
return{hello=b} end)()
local c=a
print(c.hello())
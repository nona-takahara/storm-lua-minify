local a=(function() local function b()return"hello"end
return{hello=b} end)()print(a.hello())
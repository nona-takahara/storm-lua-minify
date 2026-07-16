local a=(function() return{value=42} end)()
local b=a
local c=a
print(b.value,c.value)
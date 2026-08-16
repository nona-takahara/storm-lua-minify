local x = 1
if x == 1 then
  print("one")
elseif x == 2 then
  print("two")
else
  print("other")
end

local i = 0
while i < 10 do
  i = i + 1
end

do
  print("scoped")
end

local j = 0
repeat
  j = j + 1
until j >= 5

for k, v in pairs({ 1, 2, 3 }) do
  print(k, v)
end

for n = 1, 10 do
  print(n)
end

local function add(a, b)
  return a + b
end

local mul = function(a, b)
  return a * b
end

local function add(first, second)
  return first + second
end

local total = 0
for index = 1, 10 do
  total = add(total, index)
end

local i = 0
while i < 3 do
  i = i + 1
end

print(total, i)

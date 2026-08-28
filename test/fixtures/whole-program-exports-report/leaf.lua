local exports = { prefix = "value:", unused_constant = 99 }

local function unused_private_helper()
  return "unused"
end

function exports.format(value)
  return exports.prefix .. value
end

function exports.unused_function()
  return unused_private_helper()
end

return exports

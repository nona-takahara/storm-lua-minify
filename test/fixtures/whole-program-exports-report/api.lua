local Leaf = require("leaf")
local exports = {}

function exports.run(value)
  return Leaf.format(value)
end

function exports.unused_wrapper(value)
  return Leaf.format(value)
end

exports.unused_effect = mark("initialized")
return exports

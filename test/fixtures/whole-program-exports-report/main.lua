local initialization_log = {}

function mark(value)
  initialization_log[#initialization_log + 1] = value
  return value
end

local Api = require("api")
print(Api.run("ok"), table.concat(initialization_log, ","))

local Object = require("object")
local Base = {}

function Base.new()
  local instance = Object.create_instance({}, Base)
  return instance
end

function Base:base_method_name()
  return self.base_field_name
end

return Base

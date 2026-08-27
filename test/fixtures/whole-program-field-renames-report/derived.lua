local Object = require("object")
local Base = require("base")
local Derived = {}

function Derived.new()
  local instance = Object.create_instance(Base.new(), Derived)
  return instance
end

function Derived:derived_method_name()
  return self.derived_field_name
end

return Derived

local Derived = require("derived")
local first = Derived.new()
local second = Derived.new()
first.base_field_name = 10
first.derived_field_name = 20
second.base_field_name = 30
second.derived_field_name = 40
print(
  first:base_method_name(),
  first:derived_method_name(),
  second:base_method_name(),
  second:derived_method_name()
)

local Object = {}

function Object.create_instance(target, prototype)
  for key, value in pairs(prototype) do
    if key ~= "new" and type(value) == "function" then
      target[key] = value
    end
  end
  return target
end

return Object

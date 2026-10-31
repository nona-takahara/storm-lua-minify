-- Runs one minified Stormworks Lua node under a stub environment and prints every call that
-- leaves the script. verify-closed-field-names.cjs runs it on two builds and compares the output.
--
-- usage: lua stormworks-node-trace.lua <script.lua> [ticks] [seed]
--
-- Inputs are a deterministic pseudo-random stream, so both builds see the same values in the
-- same order. Everything the script sends to input/output/screen/map/async/server is recorded.
local script_path = arg[1]
local ticks = tonumber(arg[2]) or 600
local seed = tonumber(arg[3]) or 1

local lines = {}
local function serialize(value)
    local t = type(value)
    if t == "number" then
        if value ~= value then return "nan" end
        return string.format("%.6g", value)
    elseif t == "table" then
        local keys = {}
        for k in next, value do keys[#keys + 1] = k end
        table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
        local parts = {}
        for _, k in ipairs(keys) do parts[#parts + 1] = tostring(k) .. "=" .. serialize(value[k]) end
        return "{" .. table.concat(parts, ",") .. "}"
    elseif t == "function" then
        return "<function>"
    end
    return tostring(value)
end
local function record(name, ...)
    local args = table.pack(...)
    local parts = {}
    for i = 1, args.n do parts[i] = serialize(args[i]) end
    lines[#lines + 1] = name .. "(" .. table.concat(parts, ", ") .. ")"
end

-- Lua 5.3 changes the order of string keys between runs. Fix the order of pairs so that a script
-- whose result depends on it behaves the same in both builds.
do
    local raw_next = next
    pairs = function(t)
        local keys, rest = {}, {}
        for k in raw_next, t do
            local kt = type(k)
            if kt == "number" or kt == "string" then keys[#keys + 1] = k else rest[#rest + 1] = k end
        end
        table.sort(keys, function(a, b)
            local ta, tb = type(a), type(b)
            if ta ~= tb then return ta < tb end
            return a < b
        end)
        for _, k in ipairs(rest) do keys[#keys + 1] = k end
        local i = 0
        return function()
            while true do
                i = i + 1
                local k = keys[i]
                if k == nil then return nil end
                local v = t[k]
                if v ~= nil then return k, v end
            end
        end, t, nil
    end
end

local state = seed
local function random()
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
end

local tick = 0
local sticky = {}
local function number_input(channel)
    -- a mix of integers, small fractions, large values, and values that stay put for a while
    local r = random()
    if r < 0.4 then return math.floor(random() * 8) end
    if r < 0.6 then return random() * 2 - 1 end
    if r < 0.75 then return math.floor(random() * 100000) end
    if r < 0.9 and sticky[channel] then return sticky[channel] end
    sticky[channel] = math.floor(random() * 1000) / 10
    return sticky[channel]
end
local bool_state = {}
local function bool_input(channel)
    if random() < 0.15 or bool_state[channel] == nil then bool_state[channel] = random() < 0.5 end
    return bool_state[channel]
end

local function recorder(prefix, overrides)
    return setmetatable({}, { __index = function(_, name)
        return function(...)
            record(prefix .. "." .. name, ...)
            local f = overrides and overrides[name]
            if f then return f(...) end
            return nil
        end
    end })
end

input = {
    getNumber = function(channel) local v = number_input(channel); record("input.getNumber", channel, v); return v end,
    getBool = function(channel) local v = bool_input(channel); record("input.getBool", channel, v); return v end,
}
output = recorder("output")
screen = recorder("screen", {
    getWidth = function() return 288 end,
    getHeight = function() return 160 end,
})
map = recorder("map", { screenToMap = function(x, y) return x, y end, mapToScreen = function(x, y) return x, y end })
async = recorder("async")
server = recorder("server")
matrix = recorder("matrix")
property = {
    getNumber = function(name) record("property.getNumber", name); return (#name % 7) + 0.5 end,
    getBool = function(name) record("property.getBool", name); return #name % 2 == 0 end,
    getText = function(name) record("property.getText", name); return name end,
}
debug = debug or {}
debug.log = function(...) record("debug.log", ...) end

assert(loadfile(script_path))()

-- A script that stops with an error under these inputs is still comparable: both builds must stop
-- at the same tick. The message is not compared, because it names minified locals.
for i = 1, ticks do
    tick = i
    record("-- tick", i)
    local ok = pcall(function()
        if onTick then onTick() end
        if onDraw then onDraw() end
        if httpReply and i % 97 == 0 then httpReply(8080, "/", '{"value":' .. i .. "}") end
    end)
    if not ok then
        record("-- error at tick", i)
        break
    end
end

for _, line in ipairs(lines) do print(line) end

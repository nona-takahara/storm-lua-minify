# storm-lua-minify

このプログラムは [mathiasbynens/luamin](https://github.com/mathiasbynens/luamin) をベースにした Stormworks: Build and Rescue 向けのLua minifierです。

Stormworks: Build and Rescue 以外の用途にも使用可能です。

# 使い方

```
npm i storm-lua-minify

npx storm-lua-minify script.lua
```

- `-m`オプションを付加すると、モジュールの挙動をLuaの実際の挙動に近づけます

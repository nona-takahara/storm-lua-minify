# storm-lua-minify

このプログラムは [mathiasbynens/luamin](https://github.com/mathiasbynens/luamin) をベースにした Stormworks: Build and Rescue 向けのLua minifierです。

Stormworks: Build and Rescue 以外の用途にも使用可能です。

# 使い方

```
npm i storm-lua-minify

npx storm-lua-minify script.lua
```

- `-m`オプションを付加すると、モジュールの挙動をLuaの実際の挙動に近づけます

# テスト

```
npm ci
npm run build
npm test
```

# Lint / Format

```
npm run lint          # ESLint
npm run format:check  # Prettierのフォーマットチェック
npm run format        # Prettierでフォーマット
```

`test/` 以下にスナップショット・ラウンドトリップパース・識別子衝突検知のテストがあります。
既知バグ（#11, #12 など）の再現ケースは `test.todo` として登録されており、`npm test` は成功しますが、
修正が入るまではそのテスト自体は失敗した状態のまま todo 扱いになります。

スナップショットを更新する場合は `UPDATE_SNAPSHOTS=1 npm test` を実行してください。

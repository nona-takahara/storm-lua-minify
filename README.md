# storm-lua-minify

このプログラムは [mathiasbynens/luamin](https://github.com/mathiasbynens/luamin) をベースにした Stormworks: Build and Rescue 向けのLua minifierです。

Stormworks: Build and Rescue 以外の用途にも使用可能です。

# 使い方

```
npm i storm-lua-minify

npx storm-lua-minify script.lua
```

## `require`の展開モード

- オプションを設定しないと `require` / `dofile` 先を呼び出し位置へ直接展開する、Stormworks向けLuaを外部で作成する場合に馴染みのある方式となります。
  - ただし、実装上の制約により、文中で `require` を使用するとfunctionで包んで展開されることがあるので注意してください。
- `-m` / `--require-wrapper`は、`require`の挙動を通常のLuaに近づけます。
  - 冒頭に`require`関数を定義し、モジュールはそこに展開されます。

## コンパイル進捗

対話環境で起動すると、現在のファイル、ステップ番号、処理段階を示す表示が出ます。内部処理の分岐によってステップ数の最大値が途中で増減することがあります。

- `--no-progress`で進捗表示を無効化できます。
  - パイプやCIなどの非対話環境では既定で無効です。
- 非対話環境でも`--progress`を指定するとステップの開始と完了を通常のログ行として標準エラーへ出力します。

## 最適化アノテーション

### EmmyLuaアノテーション

EmmyLuaの`class`／継承、`field`、`param`／`return`／`type`、`alias`／`enum`を最適化解析のヒントとして使用します。

### 保護アノテーション（独自）

宣言の直前（空行を挟まない位置）に、次のアノテーションを指定できます。

- `--@storm export`: Luaコード外から名前で参照される宣言として、未使用削除と名前短縮の双方から保護します
- `--@storm keep`: 未使用削除から保護しますが、名前短縮は許可します
- `--@storm keep-name`: 名前短縮から保護しますが、未使用なら削除を許可します

未知の`--@storm`指示や引数付きの指示は、エラーになります。

## 最適化オプション

最適化オプションは、**個別スイッチ**と**機能グループ**の階層構造を持ち、すべての最適化オプションのスイッチに肯定形と否定形があります。

また、最適化オプションとは別に、Luaの動作に仮定を置くことで圧縮強度を高める設定（**仮定モード**）があります。仮定モードは最適化オプションとは別のレイヤーの設定です。

```console
storm-lua-minify --function-optimizations --no-function-inlining script.lua
storm-lua-minify --no-optimizations --local-renaming script.lua
```

設定ファイルはコマンドと同じキーを使い、平坦に書きます。設定ファイルを使用する際は明示的に`--config`オプションで指定してください。

各オプションの優先度は、コマンド指定値(個別スイッチ) > コマンド指定値(機能グループ) > 設定ファイル指定値(個別スイッチ) > 設定ファイル指定値(機能グループ) > 既定値の順です。

```json
{
  "runtime-profile": "stormworks",
  "function-optimizations": false,
  "function-inlining": true,
  "global-renaming": true,
  "never-rename-globals": ["onTick", "onDraw"]
}
```

```console
storm-lua-minify --config storm-lua-minify.json --no-function-inlining script.lua
```

### 仮定モード

`runtime-profile`の影響を受けます。`runtime-profile`は、コマンドでは`stormworks`が既定です。ライブラリAPIで省略した場合は`lua53`として扱います。

これらの機能は実際のコードに対して、圧縮が強まる仮定を置く機能です。仮定が誤っているとコードの結果が変化することがあるため、注意してください。

| 仮定                                  | 既定                             | 説明                                                                                                                                                                         |
| ------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow-introspection-changes`         | `lua53`: OFF<br>`stormworks`: ON | local名・生存期間、parameter、stack frameなどdebug APIから観測できる変更を許可します。<br>**現時点では`stormworks`プロファイルではOFFできません**                            |
| `assume-annotations`                  | OFF                              | EmmyLuaアノテーションを最適化の変換根拠として信頼します                                                                                                                      |
| `allow-observable-table-read-changes` | OFF                              | テーブルから読み取ってlocal変数を初期化する処理について、テーブルへの書き込み前へ移動する候補を許可します。local変数の値がテーブルへの書き込み前の値に変わる可能性があります |

### 個別スイッチ

| スイッチ                               | 既定    | 説明                                                                        |
| -------------------------------------- | ------- | --------------------------------------------------------------------------- |
| `local-renaming`                       | ON      | local名を短くします                                                         |
| `local-name-reuse`                     | ON      | 生存期間が重ならないlocalで同じ名前を再利用します                           |
| `global-renaming`                      | **OFF** | 内部で使うglobal名を短くします（※1）                                        |
| `field-renaming`                       | ON      | 安全に変更できるfield名を短くします                                         |
| `global-aliasing`                      | ON      | プログラム内で代入されず、繰り返し参照するglobalへ短いlocal名を割り当てます |
| `local-declaration-merging`            | ON      | 連続するlocal宣言をまとめます                                               |
| `local-declaration-hoisting`           | ON      | local宣言を移動してまとめやすくします                                       |
| `table-read-merging`                   | ON      | tableを読み取るlocal宣言をまとめます                                        |
| `field-sensitive-table-effects`        | ON      | tableへの書き込みの影響をfield単位で判定します                              |
| `constant-expression-evaluation`       | **OFF** | 定数だけからなる式を事前に計算します                                        |
| `local-constant-propagation`           | **OFF** | 再代入されないlocalの定数を参照先へ伝えます                                 |
| `interprocedural-constant-propagation` | **OFF** | 関数の呼び出しを越えて定数を伝えます                                        |
| `parameter-pruning`                    | ON      | 使われない関数parameterを取り除きます                                       |
| `function-inlining`                    | ON      | 関数呼び出しを関数本体で置き換えます                                        |
| `function-specialization`              | ON      | 呼び出し方に合わせて関数を特殊化します                                      |
| `field-value-propagation`              | ON      | 安定したfieldの値を参照先へ伝えます                                         |
| `unused-local-removal`                 | ON      | 未使用のlocalを取り除きます                                                 |
| `unused-function-removal`              | ON      | 未使用のlocal関数を取り除きます                                             |
| `unused-field-initializer-removal`     | ON      | 読み取られないfieldの初期化を取り除きます                                   |
| `unused-export-removal`                | ON      | entryから到達できないmodule exportを取り除きます                            |

安全性の条件を満たさない候補は、スイッチが有効でも実行されません。

#### `--global-renaming` から短縮を保護する（※1）

`--global-renaming`を有効にすると、このツールは「プログラム中のどこかで代入されているグローバル名」を内部専用とみなしてリネームします。
これは通常のスクリプト内部の状態変数には安全ですが、**実行環境が直接呼び出す関数名・変数名をうまく検出できません**。

短縮から保護する必要がある名前を`never-rename-globals`へ列挙するか、前述の`--@storm export`によって保護してください。
コマンドでは`--name-rename-globals <保護名>`を繰り返し記述します。設定ファイルでは`never-rename-globals`に保護する名前の配列を与えます。

### 機能グループ

機能グループのスイッチを設定すると、個別スイッチをまとめてオンオフします。

| 機能グループ               | 個別スイッチ                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `optimizations`            | 以下の全機能グループ（他の機能グループ設定の方が優先されます）                                                   |
| `identifier-optimizations` | `local-renaming`, `local-name-reuse`, `global-renaming`, `field-renaming`, `global-aliasing`                     |
| `statement-optimizations`  | `local-declaration-merging`, `local-declaration-hoisting`, `table-read-merging`, `field-sensitive-table-effects` |
| `constant-optimizations`   | `constant-expression-evaluation`, `local-constant-propagation`, `interprocedural-constant-propagation`           |
| `function-optimizations`   | `parameter-pruning`, `function-inlining`, `function-specialization`                                              |
| `object-optimizations`     | `field-value-propagation`                                                                                        |
| `dead-code-optimizations`  | `unused-code-removal`, `unused-export-removal`                                                                   |
| `unused-code-removal`      | `unused-local-removal`, `unused-function-removal`, `unused-field-initializer-removal`                            |

## Source Map

このツールは、圧縮後のコードと合わせて [Source Map](https://tc39.es/source-map/) (`.lua.map`) を出力します。

`.lua.map` の `sourcesContent` には、エントリファイルおよび `require`/`dofile` で参照される全モジュールの元テキストがそのまま埋め込まれますので、Source Mapファイル単体で元コードを参照できます。

### sourceMappingURLアノテーションの出力形式

出力される `.min.lua` の末尾に付く `sourceMappingURL` アノテーションの書式は、3種類から選べます。

[本ツール作者による紹介記事](https://nonasaba.net/blog/entry16.html)で紹介したツールでは、Luaコードとしての有効性を保ちながら認識させるには`legacy`を使う必要があるため、非標準動作を既定としています。

| `--source-mapping-url-style` | 書式                                   | 特徴                                              |
| ---------------------------- | -------------------------------------- | ------------------------------------------------- |
| `legacy`（既定）             | 複数行の `--[[`〜`]]` ブロックコメント | 従来形式                                          |
| `line`                       | 単一行の `--` ラインコメント           | 有効なLuaのままSource Map仕様の最終行規則を満たす |
| `strict`                     | Luaコメントで包まないマーカー文字列    | 最終行は有効なLua文ではなくなる                   |

# 開発者向けガイド

開発環境の構築、テスト構成、最適化を追加するときの判断基準、`scripts/`の調査・検証コマンドについては[開発者向けガイド](DEVELOPMENT.md)を参照してください。

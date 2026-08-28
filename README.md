# storm-lua-minify

このプログラムは [mathiasbynens/luamin](https://github.com/mathiasbynens/luamin) をベースにした Stormworks: Build and Rescue 向けのLua minifierです。

Stormworks: Build and Rescue 以外の用途にも使用可能です。

# 使い方

```
npm i storm-lua-minify

npx storm-lua-minify script.lua
```

- 既定では`require`/`dofile`先を呼び出し位置へ直接展開します。`-m` / `--require-wrapper`は、`require`を生成したfunction経由で展開する方式へ切り替えます。

## コンパイル進捗

対話端末では、現在のファイル、ステップ番号、処理段階を示す進捗表示が自動的に有効になります。スピナーは、コンパイラ内の作業が進み、前回の描画から一定時間が経過した場合にだけ`|/-\`の次のコマへ進みます。baseline / trialの分岐は実行中に判明するため、総ステップ数が途中で増えることがあります。

`--no-progress`で表示を無効化できます。パイプやCIなどの非対話環境では既定で無効ですが、`--progress`を指定するとステップの開始と完了を通常のログ行として標準エラーへ出力します。

## v1オプション体系

最適化オプションは、個別スイッチ、機能グループ、最上位の`optimizations`という階層を持ちます。すべてのboolean CLIスイッチに肯定形と否定形があります。

```console
storm-lua-minify --function-optimizations --no-function-inlining script.lua
storm-lua-minify --no-optimizations --local-renaming script.lua
```

末端の明示値は同じ設定元の親より優先されます。設定元の優先順位はCLI、`--config`で指定したJSON、runtime・製品既定の順です。したがって、CLIの包括指定は設定ファイルの個別指定を上書きし、同じCLIに個別指定があれば個別指定が勝ちます。

```text
CLI末端 → CLI直近の親 → CLI最上位
→ config末端 → config直近の親 → config最上位
→ 既定値
```

設定ファイルはCLIと同じケバブケースの平坦なキーを使います。

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

### 最適化階層

| 包括スイッチ               | 個別スイッチ                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `optimizations`            | 以下の全機能グループ                                                                                             |
| `identifier-optimizations` | `local-renaming`, `local-name-reuse`, `global-renaming`, `field-renaming`, `global-aliasing`                     |
| `statement-optimizations`  | `local-declaration-merging`, `local-declaration-hoisting`, `table-read-merging`, `field-sensitive-table-effects` |
| `constant-optimizations`   | `constant-expression-evaluation`, `local-constant-propagation`, `interprocedural-constant-propagation`           |
| `function-optimizations`   | `parameter-pruning`, `function-inlining`, `function-specialization`                                              |
| `object-optimizations`     | `field-value-propagation`                                                                                        |
| `dead-code-optimizations`  | `unused-code-removal`, `unused-export-removal`                                                                   |
| `unused-code-removal`      | `unused-local-removal`, `unused-function-removal`, `unused-field-initializer-removal`                            |

`global-renaming`と三つの定数最適化は既定で無効です。それ以外の実装済み末端最適化は既定で有効ですが、安全性の条件を満たさない候補は実行されません。

### 実行環境と仮定

CLIの`runtime-profile`は`stormworks`が既定です。ライブラリAPIで省略した場合は`lua53`として扱います。

- `--allow-introspection-changes`: local名・生存期間、parameter、stack frameなどdebug APIから観測できる変更を許可します。
- `--allow-observable-table-read-changes`: writeを越えるtable read移動によって値が変わり得る候補を許可します。
- `--assume-annotations`: 対応するEmmyLua annotationをoptimizer factの根拠として信頼します。

これらは最適化階層の外にあります。`--optimizations`を指定しても暗黙には有効になりません。localの生存期間・再利用やstack frameを変える変換のうち安全性条件にこの仮定を使うものは、`lua53` profileでは`--allow-introspection-changes`を指定した場合だけ実行されます。

`require-wrapper`も最適化階層とは別枠です。これは最適化の強弱ではなく、モジュールの展開方式を選びます。既定では呼び出し位置へ直接展開し、`-m`または`--require-wrapper`では生成したrequire functionを経由して展開します。`--no-optimizations`はこの方式を変更しません。短縮名`-m`とその挙動は維持しますが、旧長名`--module-like-lua`を含む旧オプションには互換別名を設けません。

関数inlineでは実引数の評価順と回数、複数戻り値、binding identityを保存します。再帰、escape、vararg、未知のcall target、証明できないclosureは拒否され、最終Rename・Print後に短くなるtrialだけが採用されます。

# Source Map

このツールは、ミニファイ後のコードと合わせて [Source Map](https://tc39.es/source-map/) (`.lua.map`) を出力します。

## sourceMappingURLアノテーションの出力形式

出力される `.min.lua` の末尾に付く `sourceMappingURL` アノテーションの書式は、3種類から選べます。

| `--source-mapping-url-style` | 書式                                   | 特徴                                              |
| ---------------------------- | -------------------------------------- | ------------------------------------------------- |
| `legacy`（既定）             | 複数行の `--[[`〜`]]` ブロックコメント | 従来形式                                          |
| `line`                       | 単一行の `--` ラインコメント           | 有効なLuaのままSource Map仕様の最終行規則を満たす |
| `strict`                     | Luaコメントで包まないマーカー文字列    | 最終行は有効なLua文ではなくなる                   |

「最終行に置く」規則を前提とするツールと組み合わせる場合は、`--source-mapping-url-style line`を指定してください。

## sourcesContent

`.lua.map` の `sourcesContent` には、エントリファイルおよび `require`/`dofile` で参照される全モジュールの元テキストがそのまま埋め込まれます。ビューア側で元の `.lua` ファイルに個別にアクセスできなくても、Source Mapファイル単体で元コードを参照できます。

## キーワードトークンのマッピング

識別子・リテラル・式などASTノードに対応する出力は、それぞれ元ソース上の対応する位置に正確にマッピングされます。加えて、`then`/`elseif`/`else`/`end`/`do`/`until` といった、AST上では文・式の境界としてしか位置を持たないキーワードについても、それぞれが実際に出現する位置に個別にマッピングされます（例: `if`〜`then`〜`end` の `then` と `end` は、`if` とは別の、それぞれ自身の出現位置を持ちます）。トークン単位で対応関係を表示するビューアと組み合わせる際は、この粒度でのマッピングが利用されます。

## 識別子短縮

local名短縮と、生存期間が重ならないlocalへの名前再利用は別スイッチです。後者は`lua53` profileでは`--allow-introspection-changes`も必要です。グローバル名短縮はLuaコード外からの参照を静的に判定できないため、既定では無効です。保護名は設定ファイルの`never-rename-globals`、またはCLIの`--never-rename-global <name...>`で指定します。

## 定数の事前計算と定数伝搬（opt-in）

`--constant-expression-evaluation`は`1+2`のような閉じた定数式を評価します。`--local-constant-propagation`は再代入されない定数localを参照先へ伝搬し、`--interprocedural-constant-propagation`は純粋な関数summaryからcall結果を伝搬します。いずれも既定では無効で、`--constant-optimizations`によりまとめて有効化できます。

対象は、算術・比較・連結・論理演算（`and`／`or`／`not`）・ビット演算・長さ演算子（`#`）です。畳み込んでもプログラムの意味は変わりません。整数と浮動小数点数の区別も保たれ、`3/1`は`3`ではなく`3.0`になります（Luaの`/`は常に浮動小数点数を返すため）。

文字列はLua 5.3のquoted escape、decimal／hex byte、`\z`、改行escape、Unicode escape、長括弧を共有byte decoderで復元します。連結、比較、`#`はJavaScriptの文字数ではなくLua byte列に対して評価し、生成literalは再decode可能な表記へ戻します。不正または判定不能なliteralは畳み込みません。

次の式は畳み込みません。いずれも、畳み込むとプログラムの意味が変わるためです。

- 整数のゼロ除算・ゼロ剰余（`1//0`、`1%0`）と、結果が非有限になる浮動小数点演算: これらは値を持つ式ではなく、実行時エラーや特殊値を生む式です。畳み込むとエラーが消えます
- 型の混ざった大小比較（`1 < "a"`）: Luaでは実行時エラーになります
- 文字列を数値として使う算術（`"10" + 1`）と、数値を含む連結（`1 .. "x"`）: Luaは暗黙に変換しますが、変換後の表記（`1`と`1.0`で異なる）まで再現する必要があり、その表記規則をこのツールへ持ち込んでいません
- 64bit整数の最小値になる計算: この値は10進の整数リテラルとして書けません（絶対値がint64の範囲外になり、Luaが浮動小数点数として読み直します）
- 大きすぎて64bit整数に収まらない10進整数リテラル: Luaではこの場合そもそも浮動小数点数として扱われます

## 最適化アノテーション

宣言の直前（空行を挟まない位置）に、次のアノテーションを指定できます。

- `--@storm export`: Luaコード外から名前で参照される宣言として、未使用削除と名前短縮の双方から保護します
- `--@storm keep`: 未使用削除から保護しますが、名前短縮は許可します
- `--@storm keep-name`: 名前短縮から保護しますが、未使用なら削除を許可します

未知の`--@storm`指示や引数付きの指示は、指定ミスを見逃さないためエラーになります。

EmmyLuaの`class`／継承、`field`、`param`／`return`／`type`、`alias`／`enum`は`SourceMetadata`へ関連付けられ、constructor field解析の候補になります。通常は候補の発見とdiagnosticsにだけ使われ、変換の根拠にはなりません。`--assume-annotations`（APIでは`assumeAnnotations: true`）を明示した場合だけ、対応subsetのliteral factがコード由来factと同じ失効規則の下で変換へ参加します。再代入、未知call、alias escape、動的key、metatable変更、またはコードとannotationの矛盾が見つかったfieldはunknownへ戻ります。`---@diagnostic`など他のdirectiveは通常のsource metadataとして保持され、optimizer factにはなりません。

### ⚠️ `--global-renaming` について（重要）

`--global-renaming`を有効にすると、このツールは「プログラム中のどこかで代入されているグローバル名」を内部専用とみなしてリネームします。これは通常のスクリプト内部の状態変数には安全ですが、**実行環境が特定名のグローバルを探す場合、その名前を誤って変更すると静かに呼び出されなくなります**。

そのような規約がある場合は`global-renaming`を無効にするか、保護する名前を`never-rename-globals`へ列挙してください。

# 開発に参加する

開発環境の構築、テスト構成、最適化を追加するときの判断基準、`scripts/`の調査・検証コマンドについては[開発者向けガイド](DEVELOPMENT.md)を参照してください。

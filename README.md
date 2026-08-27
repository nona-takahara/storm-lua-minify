# storm-lua-minify

このプログラムは [mathiasbynens/luamin](https://github.com/mathiasbynens/luamin) をベースにした Stormworks: Build and Rescue 向けのLua minifierです。

Stormworks: Build and Rescue 以外の用途にも使用可能です。

# 使い方

```
npm i storm-lua-minify

npx storm-lua-minify script.lua
```

- 既定では`require`/`dofile`先を呼び出し位置へ直接展開します。`-m` / `--require-wrapper`は、`require`を生成したfunction経由で展開する方式へ切り替えます。

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

### 切り離しの判断基準

個別スイッチは、実装上の関数の数ではなく、利用者が別々に許可・拒否したい意味変化を境界にします。同じ解析や変換パスを共有していても、次のいずれかが異なるなら別スイッチにします。

- 式や文の評価順・評価回数を変えるか
- metatable、debug API、外部から保持されたtableやglobal名を通じて変化を観測できるか
- 一つのファイル内の事実だけで判断できるか、リンクされた全モジュールの仮定が必要か
- 変換そのものを選ぶ設定か、変換を安全とみなすための仮定か

現在の末端スイッチは、この基準で次のように分けています。

| 変換単位                                                            | 主な境界                                                                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `local-renaming`, `global-renaming`, `field-renaming`               | local、global、fieldでは名前を外部から観測する経路が異なる。globalとfieldはリンクされた全モジュールを調べる                              |
| `local-name-reuse`                                                  | 名前を短くすることとは別に、異なる生存期間で同じ名前を再利用する。debug introspectionからの観測条件を持つ                                |
| `global-aliasing`                                                   | global名自体の変更ではなく、localへの読取りを追加する。alias宣言を後続の文結合より先に実行する                                           |
| `local-declaration-merging`                                         | 隣接宣言を一つの並列代入へ変える。初期化式の評価順と束縛前参照を保存できる候補に限る                                                     |
| `local-declaration-hoisting`                                        | 離れた宣言を移動するため、localの生存期間と文の実行順を変え得る                                                                          |
| `table-read-merging`                                                | table readをwriteの前後で移動し得る。値の観測可能性は`allow-observable-table-read-changes`で別に許可する                                 |
| `field-sensitive-table-effects`                                     | 変換の有無ではなく、table全体かstatic field単位かというwrite影響範囲の精度を選ぶ                                                         |
| `constant-expression-evaluation`                                    | リテラルだけの演算を先に計算する。metamethodや暗黙の文字列数値変換を伴う式は対象にせず、実行順を変えても新しい効果が生じない範囲に閉じる |
| `local-constant-propagation`                                        | 定数式の計算とは別に、local宣言を参照先へ伝搬する。宣言の削除やdebugからの観測が異なる                                                   |
| `interprocedural-constant-propagation`                              | 関数要約を介してモジュール内外へ定数を伝えるため、局所伝搬と分ける                                                                       |
| `parameter-pruning`, `function-inlining`, `function-specialization` | 引数評価を残してparameterだけ減らす、呼出しを本体へ置換する、複数呼出しを集約して専用化する、という実行構造の違いで分ける                |
| `field-value-propagation`                                           | 全モジュールのconstructorとescapeを解析し、安定したfield readを値へ置換する                                                              |
| `unused-local-removal`, `unused-function-removal`                   | 同じ未使用解析を使っても、値宣言とfunction宣言では削除対象・観測経路が異なる                                                             |
| `unused-field-initializer-removal`, `unused-export-removal`         | 前者はconstructor field、後者はentryから到達不能なexportを全プログラム解析で削除する。initializerの効果は残す                            |

新しい変換を追加するときは、まず既存の末端スイッチと上記の境界が一致するかを確認します。一致する場合はその変換単位へ挿入し、異なる仮定や観測経路を持つ場合は新しい末端スイッチを作ります。単に同じファイルへ実装されていることは、スイッチをまとめる理由にしません。

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

# 開発・テスト

開発はpnpmに変更になっています（v0.3.0リリース時点より）

```
pnpm ci
pnpm run build
pnpm test
pnpm run verify:lua-budget       # Windowsのluac53で49/50/51境界を確認
pnpm run verify:effect-semantics # Windowsのlua53で変換前後を差分実行
pnpm run report:optimizer        # 候補・拒否理由・最終byte比較をJSON出力
pnpm run report:whole-program-exports -- <entry.lua> # module export到達性と最終byte比較
```

optimizerの文移動とlocal宣言packingは、共通のCFG・liveness・文間依存DAGを使います。通常のminifyでもschedulerなしのbaselineとschedulerありのtrialを別々の`Minifier`で最終Rename／Printまで評価し、trialがUTF-8 byte数で厳密に短い場合だけ採用します。同長・増加・trial失敗時は、AST、Resolve、SourceMetadata、Source Mapを共有していないbaselineへ戻ります。

ライブラリAPIで`collectOptimizationDiagnostics: true`を指定すると、`Minifier.optimizationDiagnostics`からruntime／module／pass別の候補採否、依存DAG上の拒否理由、最終cost gateの判断を取得できます。既定はoffで、on/offによって生成コードとSource Mapは変化しません。`selectTransactionalMinifierVariant`は任意のmode同士を同じ条件で比較する調査用APIとして引き続き利用できます。

# Lint / Format

```
pnpm run lint          # ESLint
pnpm run format:check  # Prettierのフォーマットチェック
pnpm run format        # Prettierでフォーマット
```

`test/` 以下にスナップショット・ラウンドトリップパース・識別子衝突検知のテストがあります。
既知バグ（#11, #12 など）の再現ケースは `test.todo` として登録されており、`npm test` は成功しますが、
修正が入るまではそのテスト自体は失敗した状態のまま todo 扱いになります。

スナップショットを更新する場合は `UPDATE_SNAPSHOTS=1 npm test` を実行してください。

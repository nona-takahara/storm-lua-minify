# storm-lua-minify

このプログラムは [mathiasbynens/luamin](https://github.com/mathiasbynens/luamin) をベースにした Stormworks: Build and Rescue 向けのLua minifierです。

Stormworks: Build and Rescue 以外の用途にも使用可能です。

# 使い方

```
npm i storm-lua-minify

npx storm-lua-minify script.lua
```

- `-m`オプションを付加すると、モジュールの挙動をLuaの実際の挙動に近づけます

## 実行環境と効果解析最適化

CLIはStormworks向けツールとして、`--runtime-profile stormworks`を既定にします。このprofileでは、非連続な`local`宣言やfresh tableの安定したreadを効果解析でまとめる、意味保存の最適化が既定で有効です。ライブラリAPIで`runtimeProfile`を省略した場合だけは、既存利用との互換性のため`lua53`として扱います。

| 実行環境          | 効果解析最適化の既定 | 変更方法                                                                 |
| ----------------- | -------------------- | ------------------------------------------------------------------------ |
| CLI / Stormworks  | 有効                 | 個別の`--no-*`、または`--no-effect-aware-transforms`で無効化             |
| CLI / Lua 5.3     | 無効                 | `--runtime-profile lua53 --allow-local-lifetime-changes`で明示的に有効化 |
| API / profile省略 | 無効                 | `runtimeProfile: "stormworks"`、またはLua用opt-inを指定                  |

純Luaでは`debug.getlocal`やdebug hookから`local`の生存期間を観測できるため、通常の計算結果が同じでも宣言位置の変更が観測され得ます。この差を許可する`--allow-local-lifetime-changes`はopt-inです。未知のcall、alias、escape、動的table key、変更可能なmetatableを安全だと仮定する最適化は、このオプションでは有効になりません。

- `--runtime-profile <stormworks|lua53>`: 効果解析が前提とする実行環境を選びます。CLI既定は`stormworks`です
- `--no-effect-aware-transforms`: 効果解析による最適化をすべて無効にします
- `--no-effect-aware-local-hoist`: 非連続`local`宣言のまとめ上げだけを無効にします
- `--no-effect-aware-table-reads`: fresh・nonescape tableの安定したreadのまとめ上げだけを無効にします
- `--no-field-sensitive-table-effects`: tableの変更追跡をstatic key単位からtable全体へ戻します
- `--allow-local-lifetime-changes`: Lua 5.3 profileで、debug APIから観測可能な`local`生存期間の変更を許可します
- `--aggressive-table-read-merges`: tableへの変更を越えるreadも積極的なまとめ上げの対象にします（既定は無効）

`-m` / `--module-like-lua`は`require`・`dofile`の出力方式を選ぶオプションであり、runtime profileとは独立です。

### local宣言まとめ上げの安全性境界

| 分類                   | API / CLIオプション                                            | 既定                                | 変換例                                  |
| ---------------------- | -------------------------------------------------------------- | ----------------------------------- | --------------------------------------- |
| 純Luaで意味保存        | `mergeLocals` / `--no-merge-locals`                            | 有効（opt-out）                     | 独立した連続localを1文へ結合            |
| Stormworksで意味保存   | `effectAwareLocalHoist` / `--no-effect-aware-local-hoist`      | Stormworks profileで有効（opt-out） | 依存するinitializerを元位置の代入へ分離 |
| Stormworksでも意味変更 | `aggressiveTableReadMerges` / `--aggressive-table-read-merges` | 無効（opt-in）                      | dirtyなtable readを変更より前へ移動     |

2段目はlocalの生存期間を早めるため、`debug.getlocal`等を持つ純Luaでは既定で無効です。3段目は実際に読む値が変わり得ます。出力サイズを優先し、その違いを受け入れられるコードでだけ指定してください。

# Source Map

このツールは、ミニファイ後のコードと合わせて [Source Map](https://tc39.es/source-map/) (`.lua.map`) を出力します。

## sourceMappingURLアノテーションの出力形式

出力される `.min.lua` の末尾に付く `sourceMappingURL` アノテーションの書式は、3種類から選べます。

| オプション                         | 書式                                        | 特徴                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| （既定）                           | 複数行の `--[[`〜`]]` ブロックコメント      | 過去のバージョンと同じ出力。既存ツールとの互換性を優先する場合はこのまま使う                                                                               |
| `--single-line-source-mapping-url` | 単一行の `--` ラインコメント                | 有効なLuaのまま、Source Map仕様が定める「アノテーションは生成コードの最終行に置く」という規則を満たす                                                      |
| `--strict-source-mapping-url`      | Luaコメントで包まないマーカー文字列そのまま | 規則を厳密に満たすが、出力ファイルの最終行は有効なLua文ではなくなる（Lua文法上、`//`から始まる行をコメント化なしに構文解析可能にする方法は存在しないため） |

「最終行に置く」規則を厳密な前提とするツール（生成コードの末尾だけを見て `sourceMappingURL` を解決する実装など）と組み合わせる場合は、`--single-line-source-mapping-url` を試してください。

## sourcesContent

`.lua.map` の `sourcesContent` には、エントリファイルおよび `require`/`dofile` で参照される全モジュールの元テキストがそのまま埋め込まれます。ビューア側で元の `.lua` ファイルに個別にアクセスできなくても、Source Mapファイル単体で元コードを参照できます。

## キーワードトークンのマッピング

識別子・リテラル・式などASTノードに対応する出力は、それぞれ元ソース上の対応する位置に正確にマッピングされます。加えて、`then`/`elseif`/`else`/`end`/`do`/`until` といった、AST上では文・式の境界としてしか位置を持たないキーワードについても、それぞれが実際に出現する位置に個別にマッピングされます（例: `if`〜`then`〜`end` の `then` と `end` は、`if` とは別の、それぞれ自身の出現位置を持ちます）。トークン単位で対応関係を表示するビューアと組み合わせる際は、この粒度でのマッピングが利用されます。

## 識別子短縮関連のオプション

Luaコード内で完結し、意味論を変更しない最適化は既定で有効です。グローバル識別子の短縮だけは、Luaコード外からの名前による参照を静的に判定できないため、明示的に有効化した場合だけ行います。

- `--no-rename`: すべての識別子短縮を無効にします
- `--no-merge-locals`: 連続する`local`変数宣言のまとめ上げを無効にします
- `--global-rename`: 代入されているグローバル識別子をスクリプト内部用とみなし、短縮を有効にします
- `--no-global-alias`: 短縮できない外部グローバル識別子（`screen`など、代入されず参照のみされるもの）を、頻出する場合にローカル変数へ代入して短縮する最適化を無効にします
- `--no-remove-unused`: 未使用ローカル宣言の安全な範囲での削除を無効にします
- `--no-remove-unused-globals`: 将来追加する未使用グローバル削除だけを無効にします（ローカル削除は続けます）
- `--reserved-globals-config <path>`: `{"neverRenameGlobals": ["name", ...]}`形式のJSONファイルを指定し、**代入されていても常にリネームしないグローバル名**を列挙します

ローカル識別子は、CFGのlivenessから作る干渉グラフを重み付きでcoloringし、同時に生きないlocal・parameter・for変数へ同じ短名を再利用します。branch join、loop back-edge、upvalue capture、字句shadowingを考慮し、割当後には全参照を再Resolveして元と同じ宣言へ結び付くことを検証します。`stormworks` profileではdebug APIによるlocal lifetime観測がないため同一scope内でも再利用します。`lua53` profileでは既定で同一scope内の再利用を抑止し、`--allow-local-lifetime-changes`を明示した場合だけ有効にします。`--@storm keep-name`、予約global、module splice、Source Map上の元identifier名は従来どおり維持されます。

## 定数の事前計算と定数伝搬（opt-in）

`--fold-constants`を指定すると、定数式の事前計算（例: `1+2`を`3`に）と、再代入されない定数ローカル変数の伝搬（例: `local x=1 print(x)`を`print(1)`に）を行います。上記の識別子短縮関連のオプションと違い、**このオプションは既定では無効**です（指定しない限り、このパスは一切実行されません）。

- `--fold-constants`: 定数式の事前計算と、定数ローカル変数の伝搬を有効にします（既定では無効）

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

### ⚠️ `--reserved-globals-config` について（重要）

`--global-rename`を有効にすると、このツールは「プログラム中のどこかで代入されているグローバル名」を内部専用とみなしてリネームします。これは通常のスクリプト内部の状態変数には安全ですが、**実行環境（エンジンなど）が特定の名前のグローバル関数・変数を探して呼び出す規約がある場合、その名前を誤ってリネームしてしまうと、静かに（エラーなく）呼び出されなくなるバグになります**。

そのような規約（例: Stormworksのマイクロコントローラーでエンジン側が呼び出す特定名のコールバック関数など）が対象のスクリプトにある場合は、`--global-rename`を指定しないか、`--reserved-globals-config`でその名前を保護対象として指定してください。

# 開発・テスト

開発はpnpmに変更になっています（v0.3.0リリース時点より）

```
pnpm ci
pnpm run build
pnpm test
pnpm run verify:lua-budget       # Windowsのluac53で49/50/51境界を確認
pnpm run verify:effect-semantics # Windowsのlua53で変換前後を差分実行
pnpm run report:optimizer        # 候補・拒否理由・最終byte比較をJSON出力
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

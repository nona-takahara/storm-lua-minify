# 開発者向けガイド

この文書では、storm-lua-minifyの開発環境、テスト、最適化実装の原則、`scripts/`にある調査・検証用スクリプトを説明します。ツールの利用方法とオプションについては[README](README.md)を参照してください。

## 開発環境

パッケージマネージャーにはpnpmを使用します。対応するNode.jsとpnpmのバージョンは`package.json`の`engines`と`packageManager`を参照してください。

```console
pnpm install --frozen-lockfile
pnpm run build
```

## テスト

```console
pnpm run test:smoke
pnpm test
```

テストは次の三層に分けています。

- ホワイトボックステスト: 内部の解析・変換境界を直接観測する
- 契約テスト: 公開された入力と出力を仕様として記述する
- スモークテスト: 配布CLIが起動し、LuaとSource Mapを生成できることを5秒のタイムアウトで確認する

通常の`pnpm test`はホワイトボックステストと契約テストを実行します。`pnpm run test:smoke`はビルド後にスモークテストだけを実行します。CIではスモークテストが成功した場合に限り、lint、format、全テストへ進みます。

`test/`以下には、スナップショット、ラウンドトリップパース、識別子衝突検知のテストがあります。既知バグの再現ケースは`test.todo`として登録され、修正されるまではtodoとして扱われます。

スナップショットを更新する場合は、環境変数`UPDATE_SNAPSHOTS`を設定します。

```console
UPDATE_SNAPSHOTS=1 pnpm test
```

PowerShellでは次のように実行します。

```powershell
$env:UPDATE_SNAPSHOTS = "1"
pnpm test
```

## Lintとformat

```console
pnpm run lint
pnpm run format:check
pnpm run format
```

`format`はファイルを書き換えます。変更内容を確認するだけなら`format:check`を使用してください。

## 最適化実装の原則

### baselineとtrial

最終cost gateの対象となる変換は、個別のbaseline／trialを直積にせず、一つの共同trialとして最終Rename／Printまで評価します。その後、最終出力に近い変換から順に一つずつ無効化し、UTF-8 byte数が厳密に短くなる無効化だけを採用します。単独では効果が見えない変換も共同trialには含まれるため、function specializationとfield cleanupのような相乗効果を評価できます。

対象gateがN個なら、評価する`Minifier`はall-off baseline、共同trial、各gateを一度ずつ外す候補の最大N+2個です。任意の変換間相互作用を認めながら全組合せの厳密な最小を求めるには2^N評価が必要になるため、ここでは最終出力側からの決定論的な単調削除経路上で最小の候補を選びます。最後にall-off baselineと比較し、厳密に短い候補だけを採用します。同長、増加、共同trial失敗の場合は、AST、Resolve、SourceMetadata、Source Mapを共有していないbaselineへ戻ります。

ライブラリAPIで`collectOptimizationDiagnostics: true`を指定すると、`Minifier.optimizationDiagnostics`からruntime、module、pass別の候補採否、依存DAG上の拒否理由、gate別の最終採否、共同trial全体の`optimizer-final-cost`判断を取得できます。候補発見の診断は共同trialから、公開されるASTと解析stateは実際に選んだ候補から取得します。共同trial全体のbyte差は`optimizer-final-cost`だけに記録し、gateごとに重複計上しません。診断は既定offで、on／offによって生成コードとSource Mapは変化しません。`selectTransactionalMinifierVariant`は、任意のmode同士を同じ条件で比較する調査用APIです。

### オプションを切り離す判断基準

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

### コンパイル進捗の調整

対話端末に表示するスピナーの最短更新間隔は、`src/cliProgress.ts`の`CLI_PROGRESS_INTERVAL_MS`を変更して再ビルドすることで調整できます。

## 調査・検証スクリプト

`scripts/`のスクリプトは、公開パッケージの機能ではなく、最適化の効果を観測し、意味論やLua処理系の制約を検証する開発用ツールです。すべてリポジトリのルートから実行してください。

### 共通事項

`report:*`と`verify:effect-semantics`は、`package.json`のコマンドを経由すると先にTypeScriptをビルドし、生成された`dist/`を読み込みます。`verify:lua-budget`はminifierを使わないため、ビルドせずに実行します。

entry fileを受け取るreportコマンドでは、pnpmの引数とスクリプトの引数を`--`で区切ります。

```console
pnpm run report:whole-program-objects -- path/to/main.lua
```

reportコマンドはJSONを標準出力へ書きます。共通する主なフィールドは次の通りです。

- `baselineBytes`／`trialBytes`／`byteDifference`: 最適化なし、最適化あり、その差のUTF-8 byte数
- `adoptedByStrictCostGate`: trialがbaselineより厳密に短く、採用条件を満たしたか
- `measuredMilliseconds`／`medianMilliseconds`: warm-up後に3回測定したtrialの所要時間と中央値
- `outputParsesAsLua53`: trialの出力をLua 5.3として再度parseできたか
- 拒否理由の集計: 安全性や解析上の理由により変換しなかった候補。スクリプトにより`refusalReasons`または`retentionReasons`として出力する

時間は簡易測定値であり、厳密なbenchmarkではありません。また、`adoptedByStrictCostGate`は実行結果の同値性を示すものではありません。意味論の確認には`verify:effect-semantics`を使用します。

### optimizer diagnostics

```console
pnpm run report:optimizer
```

引数はありません。スクリプト内で用意した5個の短いfixtureをminifyし、最適化候補の採否とtransactionalなbaseline／trial比較をJSONで出力します。動的キー、callへのescape、制御フロー、cost gateなど、診断の代表的な経路をまとめて確認するために使用します。

### whole-program object解析

```console
pnpm run report:whole-program-objects -- path/to/main.lua
```

指定したentry fileから辿れるモジュールについて、object identityとメソッド呼出しを解析します。object数、`:`呼出しの候補数、解決できたmethod数、削除できた未使用method parameter、拒否理由とそのソース例をJSONで出力します。entry fileは必須で、`requireWrapper: true`と`stormworks` runtimeを使用します。

### whole-program field解析

```console
pnpm run report:whole-program-fields -- path/to/main.lua
```

指定したentry fileについて、constructor fieldの値と失効条件を解析します。annotation由来のfact、安定しているfield fact、値に置換したfield read、削除したfield write、副作用を残したwrite、後続のdead-code elimination件数をJSONで出力します。entry fileは必須です。

### aggregate function specialization

```console
pnpm run report:aggregate-specialization -- path/to/main.lua
```

指定したentry fileについて、aggregateを扱う関数の呼出し箇所別特殊化を調べます。候補となったcallable、特殊化したcall site、特殊化後に削除できたfield write、拒否理由をJSONで出力します。entry fileは必須です。

### whole-program export解析

```console
pnpm run report:whole-program-exports -- path/to/main.lua
```

指定したentry fileから到達できるmodule exportを解析します。候補、到達可能・到達不能なfield、削除したexport、削除したprivate helper、副作用を残したinitializer、保持理由をJSONで出力します。baselineとtrialで代入対象のglobal名も比較し、外部とのglobal contractが保たれたかを`assignedGlobalContractPreserved`で示します。entry fileは必須です。

### whole-program field rename

```console
pnpm run report:whole-program-field-renames
pnpm run report:whole-program-field-renames -- path/to/main.lua
```

プログラム全体で安全に短縮できるfield名を解析します。候補field、同じ短縮名を共有できる同値類、短縮数、key transfer、短縮名の再利用、保持理由、未知のcallにより解決できなかったaccessをJSONで出力します。entry fileは任意で、省略すると`test/fixtures/whole-program-field-renames-report/main.lua`を使用します。

### Luaのresource budget

```console
pnpm run verify:lua-budget
```

Lua compilerが、一つの関数内に150個の有効なlocalがある状態で、並列代入による49個と50個の追加localを受理し、51個を拒否することを確認します。これは、変換がLua 5.3のlocal／register制限を越えないための境界条件を検証するものです。

既定では`luac53`を実行します。別の実行ファイルを使う場合は、環境変数`LUAC53`で指定します。

```console
LUAC53=/path/to/luac pnpm run verify:lua-budget
```

### 副作用を含む意味論

```console
pnpm run verify:effect-semantics
```

元のLuaコードとminify後のコードをLua 5.3処理系で実行し、終了status、標準出力、標準エラーが一致することを確認します。評価順、複数戻り値、method parameter pruning、whole-program field／export最適化、field renameを含むfixtureを対象にします。不一致があれば、両方の実行結果とminify後のコードを含むerrorを出します。

既定では`lua53`を実行します。別の実行ファイルを使う場合は、環境変数`LUA53`で指定します。

```console
LUA53=/path/to/lua pnpm run verify:effect-semantics
```

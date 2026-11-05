# 開発者向けガイド

この文書では、storm-lua-minifyの開発環境、テスト、最適化実装の原則、`scripts/`にある調査・検証用スクリプトを説明します。ツールの利用方法とオプションについては[README](README.md)を参照してください。

## 開発環境

パッケージマネージャーにはpnpmを使用します。対応するNode.jsとpnpmのバージョンは`package.json`の`engines`と`packageManager`を参照してください。

```console
pnpm install --frozen-lockfile
pnpm run build
```

## テスト

テストにはLua 5.3の実行環境が必要です。既定では`lua5.3`を使用します。別の名前やパスでインストールされている場合は、環境変数`LUA53`にLua 5.3の実行ファイルを指定してください。未導入や実行失敗をスキップせず、テスト失敗として扱います。CIでは両方のジョブにLua 5.3を導入しています。

```console
pnpm run test:smoke
pnpm test
```

テストは次の三層に分けています。

- ホワイトボックステスト: 内部の解析・変換境界を直接観測する
- 契約テスト: 公開された入力と出力を仕様として記述する
- スモークテスト: ビルド済みCLIの代表入力について、LuaとSource Mapの生成、Luaの構文と実行結果を確認する。さらにAPIのtrial失敗からの回復を確認する。各テストのタイムアウトは5秒

通常の`pnpm test`はホワイトボックステストと契約テストを実行します。`pnpm run test:smoke`はビルド後にスモークテストだけを実行します。CIではスモークテストが成功した場合に限り、lint、format、全テストへ進みます。

前段smokeの基準は、出力の機能が保たれていることです。圧縮をあきらめてbaselineへ戻っても、期待する値・副作用を保つ有効なLuaなら成功とします。圧縮率や最適化の採用、fallback理由そのものを前段の合否条件にしません。後段では最適化ごとの採用・拒否理由、内部解析、Source Mapなどを詳しく検証し、失敗箇所を切り分けます。

意味保存のテストは、元入力と出力の両方を、明示した期待結果と独立に比較します。単に両者が一致するだけでは、両方が失敗するケースを見逃すためです。Lua子プロセスは2秒で打ち切り、終了状態・標準出力・標準エラーを確認します。文字列やbyte数のassertionは、変換の適用や圧縮効果を保証する別のテストとして残します。

関数書換えの実行ケースは`test/cases/functionRewriteSemantics.json`を通常テストと`verify:effect-semantics`で共有しています。前段CLI smokeはそのうち2ケースと小さな算術ケースに絞り、全ケースを前段へ重複配置しません。後段では関数の戻り値個数・省略引数・副作用・エラー伝播、table read移動、property呼出しの評価を確認します。fallback診断は段階と例外種別ごとの名前付きケースで確認します。

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

## CIとリリース

CIは`main`と`develop`へのプルリクエストで動きます。詳細は`.github/workflows/ci.yml`を確認してください。

Dependabotは、npmの依存とGitHub Actionsの更新を、`develop`向けのプルリクエストとして週に一度提案します。公開から7日経過していないバージョンは提案されません。設定は`.github/dependabot.yml`にあります。

npmへの公開は、`.github/workflows/publish.yml`が行います。以下のリリース手順に従ってください。

1. `package.json`の`version`を更新したプルリクエストを`main`へマージする
2. `main`のマージコミットに`v<version>`のタグを付けてpushする
3. GitHubのActionsで公開ジョブの完了を確認する

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

`assume-closed-field-names`は変換単位ではなく仮定です。`field-renaming`が実行する短縮は同じで、どのfieldを短縮してよいかの判断を、tableの同一性の証明（`wholeProgramFieldRenames.ts`）から「プログラムが定義する名前は外部から名前で参照されない」という仮定に基づく名前単位の判断（`wholeProgramFieldNames.ts`）へ替えます。証明できない参照を仮定へ移すので、仮定モードの層に置き、既定では有効にしません。名前単位の判断が拒否した理由は、証明版と同じ`whole-program-field-rename`診断に出ます。

新しい変換を追加するときは、まず既存の末端スイッチと上記の境界が一致するかを確認します。一致する場合はその変換単位へ挿入し、異なる仮定や観測経路を持つ場合は新しい末端スイッチを作ります。単に同じファイルへ実装されていることは、スイッチをまとめる理由にしません。

### コンパイル進捗の調整

対話端末に表示するスピナーの最短更新間隔は、`src/cliProgress.ts`の`CLI_PROGRESS_INTERVAL_MS`を変更して再ビルドすることで調整できます。

## 調査・検証スクリプト

`scripts/`のスクリプトは、公開パッケージの機能ではなく、最適化の効果を観測し、意味論やLua処理系の制約を検証する開発用ツールです。すべてリポジトリのルートから実行してください。

### 共通事項

`report:*`、`verify:effect-semantics`、`verify:transform-reentry`、`verify:discardable-local-reads`、`verify:specialization-budget`は、`package.json`のコマンドを経由すると先にTypeScriptをビルドし、生成された`dist/`を読み込みます。`verify:lua-budget`はminifierを使わないため、ビルドせずに実行します。

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

`collectOptimizationDiagnostics: true`の診断名は、元関数ごとの1024 signature生成上限が`specialization-variant-limit`、Luaのlocal/register等の実行資源制限が`runtime-resource-limit`です。2048 candidate sitesによる全体の打ち切りは廃止し、`specialization-site-limit`は発行しません。旧名`resource-budget`は廃止済みです。Luaの実行資源制限は維持します。

探索予算はコンパイル中の再訪と派生variantで共有します。同一signatureのvariantは、既存の束縛が生存し、挿入先で字句的に参照できる場合に再利用します。候補順は呼び出し箇所数の降順、仮引数位置の昇順、literalキーのUTF-16コード単位の辞書順です。各group内はAST順のcall-site idで並べ、代表literalと挿入位置を固定します。単純なreturn列へのboolean／nil複製が明らかに増加する場合だけ、楽観的な局所サイズ評価で生成を省きます。foldやfield削除などの可能性がある式はこの判定で除外せず、最終出力のcost gateへ渡します。

cost gateが捕捉した例外は、`pass: "optimizer-cost-failure"`、`reason: "trial-failed"`の追加レコードに残します。任意の`failure`には`stage`（`full-trial`／`ablation`）、ablationで無効化した`gate`、`kind`（`analysis-nonconvergence`／`unexpected-error`／`non-error-thrown`）、取得可能なら例外の`name`と`message`を記録します。解析未収束は専用の`AnalysisConvergenceError`で識別し、他のErrorを実装不具合とは断定しません。パイプライン内部の失敗位置は記録しません。共同trial失敗時のbaseline採用、ablation失敗時の継続、baseline例外の伝播は従来どおりです。既存の最終採否レコードも維持します。

`summarizeOptimizationDiagnostics`の既存bucket形式は維持します。失敗レコードも拒否1件として集計されますが、詳細は元の`optimizationDiagnostics`を参照してください。`report:optimizer`は集計に加えて`failures`配列を出力します。`report:aggregate-specialization`の`refusalReasons`は新しい診断名をそのままキーにします。

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

### 関数変換の再訪と固定点

```console
pnpm run verify:transform-reentry
```

延期したinline、定数畳み込み・未使用削除後の関数変換、specializationを対象に、1回目と2回目の圧縮結果の一致、および元コードと圧縮後の戻り値・エラー・副作用の一致をLua 5.3で確認します。既定の実行ファイルは`lua5.3`です。別の実行ファイルを使う場合は`LUA53`で指定します。

### 特殊化探索予算の局所化

```console
pnpm run verify:specialization-budget
```

2050 callsを含む合成入力で特殊化の採用と縮小、Lua 5.3の実行結果、不利な小入力の出力不変を検証します。Lua実行ファイルは`LUA53`（既定`lua5.3`）で指定できます。

変更前のソースを別のディレクトリにビルドした場合は、次のコマンドで変更前後を比較できます。baselineのビルドにも同じ依存を使用してください。

```console
node scripts/verify-specialization-budget.cjs --baseline-dist path/to/baseline/dist
```

既存fixtureをlua53／stormworks設定で処理し、コード・Source Map・診断の完全一致を確認します。合成入力では旧site上限による拒否と現在の縮小を確認します。その後、同じNodeプロセスでwarm-upし、変更前後の実行順を対ごとに反転させて5対を測定します。JSONの各測定値・中央値・比率は性能保証ではありません。

### 多数のsignatureを持つ入力の測定

既定の1024は、測定で完走した1000 signatureまでを覆う有限の予算です。1024自体の最適性や、大きな本体と多数の仮定を組み合わせた場合の資源使用量を保証する値ではありません。公開オプションは追加しません。

```console
pnpm run measure:specialization-budget -- --baseline-dist path/to/baseline/dist
```

共通関数を1000／1025種類の長い文字列で呼ぶ合成moduleを生成します。1000では同じNodeプロセスでwarm-up後に実行順を対ごとに反転して5対、1025では補足の1対を測定します。`--expose-gc`が有効なら各計測前にGCし、その時間は計測に含めません。別のNodeプロセスで両ビルドのピークRSSも測り、Lua 5.3で元入力と両出力の全戻り値・型を比較します。1025では1024 variantsと探索上限の拒否診断を確認し、Lua実行資源の拒否がないことを検証します。Luaは`LUA53`（既定`lua5.3`）で指定できます。比較元には探索予算局所化前のdevelop（`2b7b2c480204ea73b909fdbe56cc700ec594e4a5`）をビルドしたdistを指定してください。

### `assume-closed-field-names`の動作確認

```console
pnpm run verify:closed-field-names -- path/to/node.lua [more.lua ...] [--config reserved-globals.json] [--ticks 600]
```

指定したLuaを、field名を変えない設定（`--no-field-renaming`）と`--assume-closed-field-names`の2通りでminifyし、Stormworksのスタブ環境（`input`、`output`、`screen`、`map`、`async`、`server`、`property`）で`onTick`と`onDraw`を回して、外へ出した呼び出しの記録を比べます。入力は決まった擬似乱数列で、2つのビルドは同じ値を同じ順で受け取ります。入力は「混合」（整数・小数・大きな値）と「小さな整数（0〜3）」の2通りで、後者はビット列を復号するノードが想定する形です。どちらも実行し、止まったtickも出力に含めます。`pairs`の並びはLua 5.3が実行ごとに変えるため、スタブ側でキー順に固定しています。

記録が違うか、呼び出しが1つもなければ失敗します。乱数の入力が通る経路だけを比べるので、動作が同じことの証明ではありません。スクリプトが入力の途中でerrorになる場合は、両方が同じtickで止まることを確認します。`dofile`・`require`で読むファイルは、指定したLuaと同じディレクトリに置いてください。既定では`lua`を実行します。

### local読み取りの破棄

```console
pnpm run verify:discardable-local-reads
```

Lua 5.3（既定は`lua5.3`、`LUA53`で指定可能）で、local・仮引数・upvalueの未使用コピー削除について戻り値・エラー・副作用を入力と出力で比較します。削除対象では出力の縮小も確認し、globalのmetatable経由の読み取り、束縛前参照、debugによるlocal・upvalueの観測が残ることを検証します。標準出力・標準エラーは一時ファイル経由で取得します。

### 遅延optimizer解析の比較

```console
pnpm run verify:lazy-optimizer -- /absolute/path/to/baseline/dist [path/to/external/main.lua]
```

比較元と現在のリビジョンを別々にビルドし、比較元の`dist`を指定します。両方のビルドから依存パッケージを解決できる環境で実行してください。fixtureを3設定で比較し、出力・Source Map・診断全体の一致を検証します。100 localの合成入力と、任意指定の実入力について、同じNodeプロセス内で両ビルドをwarm upした後、実行順を交互に変えて3対測定します。解析の呼び出し回数も記録し、各対での決定性とvalue flow・statement dataflowの減少をassertします。時間は合否判定に使いません。

optimizerのread snapshotは、モジュールごとの`PassOrchestrator`が管理します。変換は必要な遅延解析を最初のAST書き換え前にすべて取得し、書き換え中に別の解析を初めて要求してはいけません。変更結果を返した時点でsnapshotが失効します。全体変換の結果も`moduleChanged`へ通知します。独立して`analyzeOptimizer`を呼ぶ利用側は、AST変更時に`invalidate()`する責任を持ちます。失効後のgetterは計算済みでも例外になります。取得済みの解析オブジェクトの寿命も同じで、変換をまたいで保持してはいけません。

`optimizerAnalysis(policy)`のpolicy objectは、runtime・仮定・関数summaryの解析方針を含む不変のcache identityです。同じpolicyを共有する利用側は同じobjectを使い、方針を変える場合は新しいobjectを作ります。内部のMapも変更してはいけません。世代はownerがcache keyへ加えます。既定の言語仕様のみのpolicyはfoldとfactsを共有し、runtimeや仮定を持つpolicyとは分離します。未使用削除はMinifierのruntime・introspection方針を使うため、専用のfacts cache keyを使います。

### 最終cost候補のsnapshot再利用

`Minifier`のcost gateは、従来と同じbaseline・共同trial・consumerからproducerへの削除順、同点の扱い、最終UTF-8 byte比較を使います。候補数や探索範囲は変更しません。キャッシュは1回の候補選択だけで生存し、runtime・仮定・解析policyを含む同じ解決済み設定と入力を使います。

再利用境界は次のとおりです。

| 境界                                                     | キー・所有権                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| link完了                                                 | 入力が同じため一度だけ構築します。変換前に全moduleのAST・コメント所有情報を複製し、Resolveを作り直します。                                                                     |
| 関数変換・field・fold・export DCE・local DCE・再訪の完了 | function rewrite・specialization・field fact・export DCEの4設定をキーにします。後続のproducerが候補を作る可能性があるため、この段階の途中で「候補なし」を確定しません。        |
| global名計画・alias・scheduler・最終全体解析の完了       | 上記4設定とscheduler設定をキーにします。変換前には全moduleを複製します。以降はASTを変更せず、同じsnapshot上のResolve・Rename結果・全体解析をfield rename候補間で読み取ります。 |
| 最終出力                                                 | 最終field rename計画が空なら同じsnapshotの出力を再利用します。すべてのproducerとschedulerが終了した後で判定します。非空の計画は通常どおり最終出力を生成・比較します。          |

複製先へ解析を流用しません。`SourceMetadata.fork`は変換で移動したコメント・annotation・削除済み宣言と識別子の所有対応も複製します。位置からの再付着ではありません。specialization履歴とfunction originの対応は複製しません。複製境界は、全producerの開始前と固定点完了後に限るためです。後者の境界より先へ関数変換を追加する場合は、この前提も変更する必要があります。失敗した段階はキャッシュへ公開しません。

module単位のcopy-on-writeは今回は扱いません。whole-programの変換が複数moduleを直接変更するため、書き込み境界の改修が必要です。関数やmoduleごとの独立したbyte見積もりも導入しません。

変更前を別途ビルドした`BASELINE_DIST`と比較するには、次を実行します。実入力のentryは任意です。依存関係はそれぞれのビルドから解決できる状態にしてください。

```sh
pnpm run verify:cost-snapshots -- "$BASELINE_DIST" "$EXTERNAL_ENTRY"
```

スクリプトは既存fixtureを3設定・診断on/offで比較し、選択されたコード・Source Map・診断と、選択過程で評価した全候補のmask・byte数・失敗有無の一致を検証します。合成100 local入力と任意の実入力では、同じNodeプロセスで旧→新、新→旧を交互に5対測定し、解析等の呼び出し回数が決定論的に減ることも確認します。経過時間は保証値ではありません。依存をinstallせず実行する場合は、ビルド後に`node scripts/verify-cost-snapshots.cjs "$BASELINE_DIST" "$EXTERNAL_ENTRY"`を使えます。

### 干渉グラフの同値性と性能

```console
pnpm exec vitest run test/interference.test.ts
pnpm run verify:interference -- path/to/baseline/dist [path/to/main.lua ...]
```

単体テストでは、既存の全Lua fixtureと合成入力について、生存点由来の辺集合と完成した干渉グラフを従来のclique方式・bitset方式・自動選択で比較します。local名の再利用の有無と、一部symbolを短縮対象から除く場合も検証します。

比較スクリプトには、変更前のリビジョンを別ディレクトリでビルドした`dist`を渡します。そのビルドからも依存を解決できる必要があります。通常の候補選択でfixtureのコード・Source Map・診断の一致を確認し、小さいfixture・合成入力・任意の追加entryを同じNodeプロセスでウォームアップ後に5対測定します。各対で先に実行するリビジョンを交互に変え、各対の平均時間とその中央値をJSONで表示します。小さいfixtureは各対10回ずつ実行し、その他は各対1回です。合成入力は1候補固定で測り、100 localでは通常の候補選択も測ります。400同時生存localはLuaの200 local制限を超えるストレス入力であり、実用入力の性能保証には使用しません。測定値は環境に依存するため、自動テストに時間の合否条件は設けていません。

### 文依存の遅延照会の比較

```console
pnpm run verify:sparse-statement-dependencies -- /absolute/path/to/baseline/dist [path/to/external/main.lua]
```

比較元を別途ビルドして指定します。fixtureを3設定で比較し、出力・Source Map・診断の一致を確認します。外部callが600文ある合成入力、小さいfixture、代表fixture、任意指定の実入力について、同じNodeプロセスでwarm-up後に実行順を交互に変えて5対測定します。時間は合否に使いません。

文依存解析は各文の要約とblock内の位置だけを保持し、`dependenciesBetween`は要求された順方向のペアを従来と同じ規則で判定します。照会結果は蓄積しません。`canMoveBefore`も移動区間のペアだけを照会します。全辺を列挙する互換APIの`dependencies`は、明示的に取得した場合だけ二次サイズになり得る配列を生成・保持します。通常のschedulerはこのAPIを使いません。任意の全ペア照会そのものを線形時間にする変更ではありません。

`test/helpers/pairwiseStatementDataflow.ts`は変更前の全ペア実装を固定したテスト用参照です。`statementDataflow.test.ts`で既存Lua fixtureと合成入力の全文ペアについて、依存辺（種類・location・順序）と移動可否・拒否理由を、全辺列挙の前後とも比較します。参照実装は製品側の判定関数を共有しません。

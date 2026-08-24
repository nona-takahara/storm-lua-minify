# Issue #47 効果解析と非連続 local／table 圧縮

この文書は Issue #47 の長期実装で、会話履歴に依存せず設計判断と次の作業を復元するための仕様書である。実装が判断を具体化したときは更新する。

## 目的

連続していない local 宣言と table access を、read／write、escape、未知の副作用を解析して短縮する。候補は次をすべて満たす場合だけ変換する。

1. 選択した実行環境と安全性レベルで許される。
2. 評価順、字句束縛、複数戻り値、制御フローの制約を満たす。
3. 最終出力が厳密に短くなる。

Issue #44 の定数伝搬・畳み込みは実装済みである。Issue #47 では、後続の Issue #42 が連続・非連続候補を同じ局所plannerで扱える効果・コスト基盤を先に作った。Issue #42 はこの基盤へ依存付きの連続local runを統合済みである。全面的な SSA、CFG、汎用 alias 解析は実測で必要になるまで導入しない。

## 意味論とオプション

`moduleLikeLua` は require の出力方式であり、実行環境の意味論ではない。公開名は実装時に確定するが、次の三軸を混ぜない。

| 軸                            | 役割                                         | 既定                                                              |
| ----------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| runtime profile               | `stormworks` / `lua53` の能力を選ぶ          | CLI は `stormworks`。API の省略時だけ従来互換の `lua53`           |
| safe effect transforms        | 選択環境で通常の観測可能な意味を保存する変換 | Stormworks では有効・opt-out。Lua では lifetime 許可を個別 opt-in |
| semantic-changing assumptions | 未知の call や alias が変更しない等の仮定    | 無効・opt-in                                                      |

Issue 本文の一律 opt-in より、今回指定された条件を優先する。Stormworks で意味が変わらない変換は opt-out、変わり得る変換は opt-in とする。純 Lua と Stormworks で安全範囲が異なる機能も単一の `aggressive` フラグへ混ぜない。意味を変える仮定は、圧縮率が高くても safe 層へ混入させない。

safe は、結果だけでなくエラーの有無と順序、call 順、metamethod、字句束縛、複数戻り値、goto の可否を保存する。ただし純 Lua の `debug.getlocal` 等による local の生存期間・名前の観測は宣言 hoist と両立しない。safe が通常のプログラム意味論を対象とし、debug/introspection を保証しないことを API 文書に明記し、必要なら変換全体を opt-out できるようにする。

Stormworks profile では、実行中に metatable を編集できず、組み込み metatable が固定されるという条件を将来の候補拡張で使ってよい。#47 の実装候補は両 profile 共通の fresh・nonescape table に限定され、この差をまだ適用範囲拡大には使わない。将来使う場合も解析へ直接埋め込まず、profile の capability として参照する。

公開オプション名は `runtimeProfile`、`effectAwareTransforms`、`effectAwareLocalHoist`、`effectAwareTableReads`、`fieldSensitiveTableEffects`、`allowLocalLifetimeChanges` とする。最後の一つだけが純 Lua で local lifetime の観測差を許可する opt-in であり、未知の副作用を無視する許可ではない。現段階では、実測上の必要性がないため、それ以外の semantic-changing transform は実装しない。

## パス順と invalidation

```text
Link / Resolve
→ #44 foldConstants → Resolve when changed
→ removeUnused fixed point → Resolve when changed
→ global rename classification / global alias → Resolve when changed
→ #47 table read merge → Resolve when changed
→ #47 non-adjacent local hoist → Resolve when changed
→ existing adjacent local merge (#9)
→ Rename
→ Print
```

各変換パスは少なくとも `changed` と `invalidatesResolve` を返す。Identifier の生成、宣言位置の変更、宣言から代入への分離は Resolve を無効化する。古い `ResolveResult` を後続へ渡してはならない。

## 解析モデル

`ControlFlowAnalysis` は chunk と各 function を execution unit に分け、同じ `Statement[]` 内で移動可能性を証明した直線区間を `certified LinearRegion` として公開する。if／loop／function の境界、label、goto、break、return、未対応 AST は region 境界とし、越えられない場合は `undefined` を返す。未構築の完全 CFG を装わず `complete: false` と明示する。

Resolver の `symbolOf(identifier)` を使い、名前ではなく Symbol 単位で次を記録する。

- local の declaration / read / write
- global read / write
- heap location の read / write
- call と未知の効果
- table value の alias / capture / escape
- control-flow barrier

heap location は Symbol ではなく table constructor ごとの allocation identity と static key で表す。直線 region の reaching-definition は `local t={}`、`local alias=t`、再代入、nil、unknown を区別する。`t.x`、`t["x"]`、escaped literal、long bracket literal は Lua byte 列として同じ key へ正規化する。動的 key は table 全体を dirty にする。

table constructor から直接作られた値を fresh とする。同一 execution unit で追跡できる `local alias=t` は同じ allocation としてdirtyを共有し、escapeにはしない。call 引数、return、global／外部 table への格納、代入による公開、nested function の capture、未対応操作では nonescape 性を失う。解析不能な join と execution unit 入口は unknown とし、「影響なし」と解釈しない。純 Luaでは `setmetatable`、未知のcall、escape後のaccessの副作用を否定せず、Stormworksでもaliasやcallによる値の変更までは無視しない。

## 変換

最初の変換は宣言だけを earlier local declaration にまとめ、初期化を元位置に残す。

```lua
local a = f()
side_effect()
local b = g()
```

```lua
local a,b
a = f()
side_effect()
b = g()
```

RHS を動かさないため評価順を保てるが、宣言を早めて介在コードの同名 outer local/global を shadow する場合、goto が新しい local scope へ飛び込む場合は拒否する。

初期段階は 1 variable / 1 initializer だけを対象にする。`local a,b=f()`、末尾式の複数戻り値、vararg、nil 補完は専用の同値変換が入るまで拒否する。closure capture、local 上限、repeat-until scope も検査する。式の移動は effect-free、介在 write なし、エラー順不変を証明できる場合だけ後段で追加する。

table は fresh・nonescape を table 全体で dirty 管理し、次に static key 単位へ精密化する。純 Lua で metamethod を否定できない access の移動・削除は safe 層で行わない。Stormworks 固定 metatable で追加的に安全になるものは Stormworks safe 層、未知 call 等を無視するものは semantic-changing 層に置く。

## コスト

適用する各変換は、出力構文の byte 差を保守的に計算し、厳密に短いと判断できる場合だけ適用する。判定不能なら拒否する。統合テストでは変換有効時の UTF-8 byte length が無効時より長くならないことを確認する。

非連続 local は Rename と同じ予約名・module 順で provisional name を割り当て、その名前長を追加代入の上界に使う。変換で候補 Symbol の参照重みだけが増える限り、最終 Rename は旧割当を維持する案より悪くならない。Issue #42 では、先頭initializerを結合後のlocal文に残し、依存する後続initializerだけを元位置の代入へ分離することで、連続local mergeとの境界を同じplannerへ統合した。依存のない隣接runは従来のmergeへ委譲する。

table read merge は `local` と `=` の重複が消える固定構文差を使う。runtime semantics と compiler resource policy は別の capability とし、planner は中央の判定結果だけを参照する。字句block／functionごとのactive local数を文位置で数え、local上限、register上限、保守policyの最小headroomからarityを導出する。Windowsの`luac53`では、既存150 localsに対する49／50受理と51拒否を`pnpm run verify:lua-budget`で再現する。Stormworks compilerの詳細を導出できない場合は、このLua 5.3上限以下へfail-closedにfallbackする。

#47 の二変換は、Symbol数・scope・利用可能な短縮名集合を変えない範囲で局所的なサイズ上界を証明している。加えて、baselineとtrialを別Minifierへ隔離し、全moduleを同じRename／Print条件で比較するtransaction基盤を実装した。厳密に短いtrialだけを選び、同長、増加、trial失敗ではbaselineのAST、Resolve、SourceMetadata、annotation、rename cacheへ触れない。現行#47の局所証明を必須transactionへ置き換えず、将来の競合plannerが利用する。

## Source Map

- hoist 後の宣言文: 最初に統合した元 local 文
- 各宣言 Identifier: 対応する元宣言 Identifier
- 元位置の assignment 文: 対応する元 local 文
- assignment 左辺: 対応する元宣言 Identifier
- RHS: 元ノードを再利用して元位置を維持
- 合成 nil 等: 対応する元宣言か RHS。対応がなければ unmapped

同じ Identifier ノードを宣言と代入左辺へ再利用しない。合成 Identifier は元 location/range と Source Map name の由来を持つ。保存コメントと annotation は `SourceMetadata` の所有関係を使い、意味上対応する後継文へ一度だけ移す。

## 段階とコミット

各段階を一つ以上の独立コミットにし、必要ならさらに細分化する。各コミットで Windows の `cmd.exe` から Windows 版 pnpm を呼び、対象テストと全テストを通す。

1. 本仕様書と基準検証。
2. 共通 AST walker と effect fact 型。変換はしない。
3. Symbol 単位の read/write と region/barrier 解析。
4. 1 variable / 1 initializer の非連続 planner と cost gate。
5. 宣言 hoist／初期化分離、再 Resolve、Source Map provenance。
6. #44、remove-unused、merge、global alias の組合せ固定。
7. fresh・nonescape table の table 全体 dirty。
8. static key 正規化と field-sensitive dirty。
9. Lua／Stormworks profile、safe の既定と opt-out を公開。
10. 実測で有効な semantic-changing assumption だけを個別 opt-in で追加。
11. fixture、差分実行、Source Map、roundtrip、出力長、CLI/API 文書、全 CI 検証。

段階 10 は unsafe 機能を必ず作るという意味ではない。意味変更で初めて得られる有効な候補を計測し、導入するなら safe と別オプション・別コミットにする境界である。

## 実装到達点

#47 では次を実装した。

- 共通 AST walker と、Symbol 単位の declaration／read／write facts
- fresh table allocation、static key、dirty、alias／call／return／store／capture escape の解析
- certified linear region、allocation identity、直線regionのreaching-definition／alias facts
- Lua 5.3 lexical ruleに従い、table effectとconstant foldが共用するbyte string decoder／encoder
- active localとregister headroomを含むruntime resource判定、実`luac53`境界harness
- `changed`／`invalidatesResolve`とResolve世代を集中管理し、#44、remove-unused、global alias、#47、#9を通すpass orchestrator
- runtime／module／pass別の候補採否理由・件数・推定削減量と、再現可能なfixture report
- 最終Rename／Print済みartifactを隔離比較するtransactional variant selector
- 先頭RHSを宣言に残し、後続RHSを元位置に残す、連続・非連続 local 宣言の hoist
- fresh・nonescape tableの安定したstatic-key readを一つのlocal文へまとめる変換
- table全体／static-key単位dirtyの個別切替、master／変換別opt-out
- CLIのStormworks既定、APIのLua 5.3互換既定、純Lua lifetime変更の個別opt-in
- 構造変更後の再Resolve、合成Identifierのprovenance、table統合を含むSource Mapテスト
- moduleLikeLuaの両方式、複数module、#44、remove-unused、global alias、既存local mergeとの組合せテスト
- local alias経由のread/write、fresh table再代入前後の部分最適化、closureによるalias公開の拒否

未知のcallやaliasが変更しないと仮定するsemantic-changing transformは、実測上の必要性を確認できなかったため追加していない。意味変更を許可する包括的な`aggressive`オプションも設けていない。純Luaの`allowLocalLifetimeChanges`はdebug APIからのlocal lifetime観測差だけを許可し、heap効果やmetatableの仮定を緩めない。

## テスト行列

- identifier: intervening read/write、outer/global 同名、shadow、capture、nested block、label/goto、local 上限
- value/order: pure literal、call、error、short circuit、multiple return、nil padding、vararg、LHS base/index/RHS 順
- table: `.x` / `["x"]`、same/different/dynamic key、alias、call、return、global/outer table escape、capture、metatable
- runtime: lua53 safe、Stormworks safe、semantic-changing opt-in、各 opt-out
- pipeline: #44、remove-unused、merge、global alias の on/off と再 Resolve
- linking: module-like Lua と SL require splice
- output: Source Map origin/name、roundtrip、identifier collision、byte length

Lua 5.3 safe ケースは可能な範囲で実行結果を差分検証する。Stormworks 固有 capability は、metatable を使う反例が Lua では拒否され、Stormworks profile だけで許可される解析テストで示す。

## #47 の変換対象外

- 全関数の SSA／CFG
- branch／loop をまたぐ一般的 code motion
- 分岐joinを含む汎用SSA／points-to解析
- debug API による local 観測の保存
- 未知の C API やホスト環境の効果推論

これらは#47の未完ではない。#47で必要な解析境界、allocation追跡、測定手段は実装済みであり、以下は別の観測保証または対象領域を増やす独立機能である。

## 独立した後続 Issue

この節は、#47の実装結果を前提にした独立拡張だけを残す。#47候補の採否理由はdiagnosticsで測定でき、基準値は[optimizer計測レポート](./issue-47-optimizer-report.md)に残す。再代入、同一unitのlocal alias、byte string decoder、resource導出、pass invalidation、候補計測、最終出力transaction基盤は#47へ吸収済みであり、後続Issueには残さない。

### #63 branch／loop／goto を扱う CFG

- **問題と保留理由:** #47 は同じ `Statement[]` の直線 region に限定し、分岐、loop、label、goto を barrier とする。一般的な code motion には支配関係、到達定義、loop 効果の固定点が必要で、局所的な条件追加では安全性を維持しにくい。
- **起票トリガー:** barrier 越しの候補が実コーパスの削減機会を支配し、直線 region の改善では回収できないと測定されたとき。
- **必要な基盤:** Lua の goto／local scope 制約を表す CFG、dominance、block 単位の effect summary、解析不能 edge の保守的表現。
- **完了条件案:** if、各 loop、break、return、label／goto の代表反例で評価順と scope legality を保存する。未到達、irreducible、解析不能な flow は変換しない。

### #65 競合plannerへのtransactional cost接続

- **問題と保留理由:** 隔離variantの最終出力比較は#47で実装済み。今後、scope／slot集合を変える候補や複数plannerの競合を候補単位で列挙する場合、そのplannerからvariant selectorへ接続する必要がある。
- **起票トリガー:** 多数 Symbol、複数 module、予約名衝突を含む差分テストで、有効時の出力が無効時より長くなる反例が得られたとき。または複数の変換パスが同じ概算ロジックを持ち始めたとき。
- **既存基盤:** `selectTransactionalMinifierVariant`が全状態を共有しないbaseline／trialを最終Rename／Printまで評価し、UTF-8 byteで選択する。
- **完了条件案:** #42等が競合候補variantを決定論的に列挙し、selectorへ渡す。候補の組合せ爆発を制御し、現行の局所証明済み#47候補を退行させない。

### #67 debug／introspection 保存モード

- **問題と保留理由:** local 宣言 hoist は通常の実行結果を保存しても、`debug.getlocal`、hook、エラースタックから観測される local の生存期間を変える。完全保存は rename や既存 minify とも衝突し、#47 の safe 定義には含めない。
- **起票トリガー:** debug API を使用する利用者から再現例が提示され、rename を含むどの観測を保証すべきか合意できたとき。
- **必要な基盤:** runtime profile ごとの debug API 能力、観測対象の明文化、debug-sensitive construct の検出。
- **完了条件案:** 保証範囲を API／CLI に明記し、保存モードでは該当変換を拒否する。保証できない観測は診断または文書で明示する。

## 完了条件

- #44 と連続 local merge だけでは生成できない、非連続文または table key を含む圧縮がある。
- safe 層で評価順、字句束縛、複数戻り値、副作用が保存される。
- 未知 call、alias、escape、動的 key、純 Lua の metatable に保守的である。
- 短くなる候補だけを適用する。
- Stormworks safe は opt-out、意味変更は opt-in、純 Lua 差異は別軸である。
- 合成ノードの Source Map 由来が仕様とテストで固定される。
- 関連パスの組合せと再 Resolve がテストされる。
- Windows 版 pnpm で build、lint、format check、test、pack dry-run が成功する。

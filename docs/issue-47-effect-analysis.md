# Issue #47 効果解析と非連続 local／table 圧縮

この文書は Issue #47 の長期実装で、会話履歴に依存せず設計判断と次の作業を復元するための仕様書である。実装が判断を具体化したときは更新する。

## 目的

連続していない local 宣言と table access を、read／write、escape、未知の副作用を解析して短縮する。候補は次をすべて満たす場合だけ変換する。

1. 選択した実行環境と安全性レベルで許される。
2. 評価順、字句束縛、複数戻り値、制御フローの制約を満たす。
3. 最終出力が厳密に短くなる。

Issue #44 の定数伝搬・畳み込みは実装済みである。Issue #42 の local-run planner は未実装だが、#47 をその完了待ちにはしない。両 Issue が使える効果・コスト基盤を先に作り、連続・非連続候補の局所実装を重複させない。全面的な SSA、CFG、汎用 alias 解析は実測で必要になるまで導入しない。

## 意味論とオプション

`moduleLikeLua` は require の出力方式であり、実行環境の意味論ではない。公開名は実装時に確定するが、次の三軸を混ぜない。

| 軸                            | 役割                                         | 既定                                                                |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| runtime profile               | `stormworks` / `lua53` の能力を選ぶ          | 従来互換の `lua53`                                                  |
| safe effect transforms        | 選択環境で通常の観測可能な意味を保存する変換 | Stormworks では有効・opt-out。Lua では保守的な範囲だけ有効・opt-out |
| semantic-changing assumptions | 未知の call や alias が変更しない等の仮定    | 無効・opt-in                                                        |

Issue 本文の一律 opt-in より、今回指定された条件を優先する。Stormworks で意味が変わらない変換は opt-out、変わり得る変換は opt-in とする。純 Lua と Stormworks で安全範囲が異なる機能も単一の `aggressive` フラグへ混ぜない。

safe は、結果だけでなくエラーの有無と順序、call 順、metamethod、字句束縛、複数戻り値、goto の可否を保存する。ただし純 Lua の `debug.getlocal` 等による local の生存期間・名前の観測は宣言 hoist と両立しない。safe が通常のプログラム意味論を対象とし、debug/introspection を保証しないことを API 文書に明記し、必要なら変換全体を opt-out できるようにする。

Stormworks profile では、実行中に metatable を編集できず、組み込み metatable が固定されるという条件を使ってよい。この条件は解析へ埋め込まず、profile の capability として参照する。

## パス順と invalidation

```text
Link / Resolve
→ #44 foldConstants
→ Resolve when changed
→ removeUnused fixed point
→ Resolve when changed
→ shared local/effect planning (#42 slot)
→ #47 effect-aware transforms
→ Resolve when structure or bindings changed
→ existing alias / merge integration
→ Resolve when changed
→ Rename
→ Print
```

各変換パスは少なくとも `changed` と `invalidatesResolve` を返す。Identifier の生成、宣言位置の変更、宣言から代入への分離は Resolve を無効化する。古い `ResolveResult` を後続へ渡してはならない。

## 解析モデル

最初の region は同じ `Statement[]` 内の直線区間とする。if／loop／function の境界、label、goto、break、return、require splice、未対応 AST は region 境界とし、初期段階では越えない。各 nested block は独立に解析する。

Resolver の `symbolOf(identifier)` を使い、名前ではなく Symbol 単位で次を記録する。

- local の declaration / read / write
- global read / write
- heap location の read / write
- call と未知の効果
- table value の alias / capture / escape
- control-flow barrier

heap location は table 全体から始め、次に `(table symbol, static key)` へ精密化する。`t.x` と `t["x"]` は同じ key `"x"` とする。動的 key は table 全体を dirty にする。未知の call、alias、escape は該当 table、判定不能なら追跡中 heap 全体を保守的に invalid とする。

table constructor から直接作られ、追跡 local 以外へ渡っていない値を fresh とする。call 引数、return、global／外部 table への格納、別 local への alias、nested function の capture、未対応操作で nonescape 性を失う。純 Lua では `setmetatable`、未知の call、escape 後の access の副作用を否定しない。Stormworks でも alias や call による値の変更までは無視しない。

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

printer と共有できる syntax byte cost API を用意し、保守的な上下界で変換後が厳密に短いと判断できる場合だけ適用する。判定不能なら拒否する。概算定数を各変換へ散在させない。統合テストでは変換有効時の UTF-8 byte length が無効時より長くならないことを確認する。

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

## テスト行列

- identifier: intervening read/write、outer/global 同名、shadow、capture、nested block、label/goto、local 上限
- value/order: pure literal、call、error、short circuit、multiple return、nil padding、vararg、LHS base/index/RHS 順
- table: `.x` / `["x"]`、same/different/dynamic key、alias、call、return、global/outer table escape、capture、metatable
- runtime: lua53 safe、Stormworks safe、semantic-changing opt-in、各 opt-out
- pipeline: #44、remove-unused、merge、global alias の on/off と再 Resolve
- linking: module-like Lua と SL require splice
- output: Source Map origin/name、roundtrip、identifier collision、byte length

Lua 5.3 safe ケースは可能な範囲で実行結果を差分検証する。Stormworks 固有 capability は、metatable を使う反例が Lua では拒否され、Stormworks profile だけで許可される解析テストで示す。

## 非対象

- 全関数の SSA／CFG
- branch／loop をまたぐ一般的 code motion
- 汎用 points-to／alias 解析
- debug API による local 観測の保存
- 未知の C API やホスト環境の効果推論

安全な候補の大半がこれらだけで拒否され、推定削減量が実装・保守コストを上回ると実コーパスで確認できた場合に再検討する。

## 完了条件

- #44 と連続 local merge だけでは生成できない、非連続文または table key を含む圧縮がある。
- safe 層で評価順、字句束縛、複数戻り値、副作用が保存される。
- 未知 call、alias、escape、動的 key、純 Lua の metatable に保守的である。
- 短くなる候補だけを適用する。
- Stormworks safe は opt-out、意味変更は opt-in、純 Lua 差異は別軸である。
- 合成ノードの Source Map 由来が仕様とテストで固定される。
- 関連パスの組合せと再 Resolve がテストされる。
- Windows 版 pnpm で build、lint、format check、test、pack dry-run が成功する。

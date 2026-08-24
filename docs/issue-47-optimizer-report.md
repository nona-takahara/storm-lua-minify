# Issue #47 optimizer 計測レポート

このレポートは `pnpm run report:optimizer` で再生成できる。5個の固定fixtureを、Windows版pnpm、Stormworks profile、同一Rename／Print条件で計測した2026-08-25時点の基準値である。

## 結果

| pass        | decision | reason                        | candidates |     推定bytes |
| ----------- | -------- | ----------------------------- | ---------: | ------------: |
| table reads | accepted | profitable group              |          2 |         5削減 |
| table reads | rejected | call escape                   |          1 |             0 |
| table reads | rejected | dynamic key                   |          1 |             0 |
| local hoist | rejected | adjacent local owned by merge |          4 |             0 |
| local hoist | rejected | control-flow barrier          |          1 |             0 |
| local hoist | rejected | insufficient group            |          1 |             0 |
| local hoist | rejected | nonpositive cost              |          4 | 4 opportunity |

全体では14候補中2候補を採用し、planner上の推定削減は5 bytesだった。最終出力transactionでは、採用fixtureが55 bytesから49 bytesへ6 bytes短縮された。他の4 fixtureは同長でbaselineが選ばれ、増加するtrialはなかった。

## 後続Issueの判断

- #63: control-flow barrier拒否は1候補あったが、単独候補で推定削減機会は0 bytesだった。CFG基盤を直ちに変換へ接続する根拠にはならず、branch／loop越しという新しい対象領域の独立Issueとして維持する。
- #65: 隔離Minifierによる最終Rename／Print transaction基盤は#47で実装した。現fixtureで局所cost証明の破綻はなく、残る仕事は#42等の競合plannerへ候補選択を接続する独立統合作業である。
- #67: debug／introspectionは通常実行結果の候補計測では判定できない別の観測保証である。Stormworks既定を弱めず、利用者要求が得られた場合だけ扱う。

この小規模fixtureは実利用コーパスの頻度を代表しない。reason分類と再現手段の基準であり、後続Issueの着手判断では対象コーパスを追加して同じcommandで再計測する。

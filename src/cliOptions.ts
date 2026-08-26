import { Command, Option } from "commander";

/**
 * CLIの公開オプション定義。I/Oから分離し、既定値とMinifierModeへの名前変換を
 * 実ファイルを書かずに検証できるようにする。
 */
export function createCliProgram(): Command {
  return new Command()
    .version("0.3.0")
    .description("A Lua minifier also outputs source map")
    .option(
      "-m, --module-like-lua",
      "require・dofileの動作を実際のLuaに近づけます（runtime profileとは独立）",
    )
    .addOption(
      new Option(
        "--runtime-profile <profile>",
        "効果解析が前提とする実行環境（CLI既定: stormworks）",
      )
        .choices(["stormworks", "lua53"])
        .default("stormworks"),
    )
    .option(
      "--no-effect-aware-transforms",
      "効果解析による最適化をすべて無効にします",
    )
    .option(
      "--no-effect-aware-local-hoist",
      "非連続local宣言のまとめ上げだけを無効にします",
    )
    .option(
      "--no-effect-aware-table-reads",
      "fresh tableの安定したreadのまとめ上げだけを無効にします",
    )
    .option(
      "--aggressive-table-read-merges",
      "tableの変更を越えるreadも積極的なまとめ上げの対象にします",
    )
    .option(
      "--no-field-sensitive-table-effects",
      "tableのdirty判定をstatic key単位からtable全体へ戻します",
    )
    .option(
      "--allow-local-lifetime-changes",
      "Lua 5.3 profileでdebug APIから観測可能なlocal生存期間の変更を許可します",
    )
    .option(
      "--assume-annotations",
      "対応するEmmyLua annotationをoptimizerの明示的な仮定として利用します",
    )
    .option(
      "--no-rename",
      "識別子の短縮(リネーム)を無効にします（デバッグ用途）",
    )
    .option(
      "--global-rename",
      "代入されているグローバル識別子を内部用とみなして短縮します（外部から名前で参照されるグローバルがある場合は使用しないでください）",
    )
    .option(
      "--no-merge-locals",
      "連続するローカル変数宣言のまとめ上げを無効にします（デバッグ用途）",
    )
    .option(
      "--no-global-alias",
      "外部グローバル識別子（リネームできないもの）のローカル代入短縮を無効にします（デバッグ用途）",
    )
    .option(
      "--no-remove-unused",
      "未使用ローカル宣言の安全な範囲での削除を無効にします",
    )
    .option(
      "--no-remove-unused-globals",
      "未使用グローバル削除を無効にします（グローバル削除は今後実装予定）",
    )
    .option(
      "--fold-constants",
      "定数式の事前計算と、定数ローカル変数の伝搬を有効にします（既定では無効）",
    )
    .option(
      "--reserved-globals-config <path>",
      '代入されていても短縮しないグローバル名を列挙したJSON設定ファイルのパス（{"neverRenameGlobals":["onTick",...]}形式）。エンジン側のコールバック規約名など、常に元の名前のまま残す必要がある識別子を指定します',
    )
    .option(
      "--single-line-source-mapping-url",
      "sourceMappingURLアノテーションを単一行の--コメントで出力します（Source Map仕様の「最終行」ルールに従いますが、既定の複数行ブロックコメント形式を前提とするツールとは組み合わせられません）",
    )
    .option(
      "--strict-source-mapping-url",
      "sourceMappingURLアノテーションをLuaコメントで一切包まず、Source Map仕様のマーカー文字列(//# sourceMappingURL=...)そのままを出力します。Luaの文法上この形式と有効なLuaコードは両立できないため、出力ファイルの最終行は有効なLua文ではなくなります",
    );
}

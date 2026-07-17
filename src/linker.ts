import { Chunk } from "./ast2lua";

export interface ModuleReference {
  kind: "require" | "dofile";
  moduleName: string;
}

/**
 * Chunk配下を型を問わず再帰的に走査するジェネリックウォーカー。
 * printerとは独立に、AST全体からrequire/dofile呼び出しを見つけ出すために使う（#18）。
 */
function walk(node: unknown, visit: (n: Record<string, unknown>) => void) {
  if (node === null || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => {
      walk(child, visit);
    });
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.type === "string") {
    visit(obj);
  }
  for (const key of Object.keys(obj)) {
    if (key === "loc" || key === "range") {
      continue;
    }
    walk(obj[key], visit);
  }
}

// luaparseはデフォルト設定（encodingMode: "none"）ではStringLiteral.valueを
// 常にnullにする（discardStrings）ため、rawから引用符を取り除いて文字列値を得る。
// require/dofileのモジュール名として使う簡単な文字列リテラルのみを想定しており、
// エスケープシーケンスの解釈までは行わない。
function unquoteRaw(raw: string): string {
  if (raw.length >= 2) {
    const first = raw.charAt(0);
    const last = raw.charAt(raw.length - 1);
    if ((first === '"' || first === "'") && first === last) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

export function staticStringArgument(node: unknown): string | undefined {
  if (
    node !== null &&
    typeof node === "object" &&
    (node as Record<string, unknown>).type === "StringLiteral" &&
    typeof (node as Record<string, unknown>).raw === "string"
  ) {
    return unquoteRaw((node as Record<string, unknown>).raw as string);
  }
  return undefined;
}

function calleeName(node: unknown): string | undefined {
  if (
    node !== null &&
    typeof node === "object" &&
    (node as Record<string, unknown>).type === "Identifier" &&
    typeof (node as Record<string, unknown>).name === "string"
  ) {
    return (node as Record<string, unknown>).name as string;
  }
  return undefined;
}

/**
 * ASTを走査してrequire/dofile呼び出し（CallExpression / StringCallExpression の両構文）を
 * 静的な文字列引数付きのものに限って列挙する。同一モジュールへの参照は重複したまま返す
 * （呼び出し側で重複排除する）。
 */
export function findModuleReferences(ast: Chunk): ModuleReference[] {
  const refs: ModuleReference[] = [];

  walk(ast, (node) => {
    if (node.type === "CallExpression") {
      const name = calleeName(node.base);
      if (name !== "require" && name !== "dofile") {
        return;
      }
      const args = node.arguments;
      if (!Array.isArray(args) || args.length === 0) {
        return;
      }
      const moduleName = staticStringArgument(args[0]);
      if (moduleName !== undefined) {
        refs.push({ kind: name, moduleName });
      }
    } else if (node.type === "StringCallExpression") {
      const name = calleeName(node.base);
      if (name !== "require" && name !== "dofile") {
        return;
      }
      const moduleName = staticStringArgument(node.argument);
      if (moduleName !== undefined) {
        refs.push({ kind: name, moduleName });
      }
    }
  });

  return refs;
}

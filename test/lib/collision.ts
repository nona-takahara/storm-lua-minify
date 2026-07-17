import Parser from "luaparse";
import { RawSourceMap, SourceMapConsumer } from "source-map";

export interface IdentifierCollision {
  scope: string;
  shortName: string;
  originalNames: string[];
}

interface Declaration {
  name: string;
  original: string | null;
}

// 出力（minify後）のLuaコードを対象に、同一スコープ内で同じ短縮名が
// 「別のオリジナル識別子」に割り当てられていないかを検証する（#12の回帰防止）。
//
// 既知の制限（テストハーネスの簡易実装）:
// - 文（Statement）としてのスコープのみを辿る。式中の無名関数
//   （例: `local t = { f = function() ... end }`）の内部は対象外。
export async function findIdentifierCollisions(
  code: string,
  rawMap: RawSourceMap,
): Promise<IdentifierCollision[]> {
  const ast = Parser.parse(code, { luaVersion: "5.3", locations: true });
  const collisions: IdentifierCollision[] = [];

  await SourceMapConsumer.with(rawMap, null, (consumer) => {
    const originalNameFor = (node: {
      loc?: Parser.Node["loc"];
    }): string | null => {
      if (!node.loc) {
        return null;
      }
      const pos = consumer.originalPositionFor({
        line: node.loc.start.line,
        column: node.loc.start.column,
      });
      return pos.name;
    };

    const checkScope = (scopeName: string, declarations: Declaration[]) => {
      const byShortName = new Map<string, Set<string>>();
      for (const decl of declarations) {
        if (decl.original === null) {
          continue;
        }
        if (!byShortName.has(decl.name)) {
          byShortName.set(decl.name, new Set());
        }
        byShortName.get(decl.name)?.add(decl.original);
      }
      for (const [shortName, originalNames] of byShortName) {
        if (originalNames.size > 1) {
          collisions.push({
            scope: scopeName,
            shortName,
            originalNames: [...originalNames],
          });
        }
      }
    };

    let scopeCounter = 0;

    const walkBlock = (scopeLabel: string, body: Parser.Statement[]) => {
      const declarations: Declaration[] = [];
      for (const statement of body) {
        collectFromStatement(statement, declarations);
      }
      checkScope(scopeLabel, declarations);
    };

    const collectFromStatement = (
      statement: Parser.Statement,
      declarations: Declaration[],
    ) => {
      switch (statement.type) {
        case "LocalStatement":
          for (const v of statement.variables) {
            declarations.push({ name: v.name, original: originalNameFor(v) });
          }
          break;
        case "ForNumericStatement":
          declarations.push({
            name: statement.variable.name,
            original: originalNameFor(statement.variable),
          });
          walkBlock(`for#${String(scopeCounter++)}`, statement.body);
          break;
        case "ForGenericStatement":
          for (const v of statement.variables) {
            declarations.push({ name: v.name, original: originalNameFor(v) });
          }
          walkBlock(`for#${String(scopeCounter++)}`, statement.body);
          break;
        case "FunctionDeclaration": {
          const paramDeclarations: Declaration[] = statement.parameters
            .filter((p): p is Parser.Identifier => p.type === "Identifier")
            .map((p) => ({ name: p.name, original: originalNameFor(p) }));
          const bodyDeclarations = [...paramDeclarations];
          for (const inner of statement.body) {
            collectFromStatement(inner, bodyDeclarations);
          }
          checkScope(`function#${String(scopeCounter++)}`, bodyDeclarations);
          break;
        }
        case "DoStatement":
          walkBlock(`do#${String(scopeCounter++)}`, statement.body);
          break;
        case "WhileStatement":
          walkBlock(`while#${String(scopeCounter++)}`, statement.body);
          break;
        case "RepeatStatement":
          walkBlock(`repeat#${String(scopeCounter++)}`, statement.body);
          break;
        case "IfStatement":
          for (const clause of statement.clauses) {
            walkBlock(`if#${String(scopeCounter++)}`, clause.body);
          }
          break;
        default:
          break;
      }
    };

    walkBlock("chunk", ast.body);
  });

  return collisions;
}

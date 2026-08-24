export type RuntimeProfile = "lua53" | "stormworks";

export interface RuntimeSemantics {
  readonly mutableMetatables: boolean;
  readonly debugLocalIntrospection: boolean;
}

export interface RuntimeResourceBudget {
  readonly maxActiveLocalsPerFunction: number;
  readonly maxRegistersPerFunction: number;
  readonly conservativeParallelValueLimit: number;
}

export interface RuntimeEnvironment {
  readonly profile: RuntimeProfile;
  readonly semantics: RuntimeSemantics;
  readonly resources: RuntimeResourceBudget;
}

export type ResourceDecision =
  | {
      readonly allowed: true;
      readonly confidence: "conservative-policy";
      readonly limit: number;
      readonly estimatedPeakRegisters: number;
    }
  | {
      readonly allowed: false;
      readonly reason:
        "parallel-value-limit" | "local-limit" | "register-limit";
      readonly limit: number;
      readonly estimatedPeakRegisters: number;
    };

export interface ParallelEvaluationRequest {
  readonly activeLocalsBefore: number;
  readonly parallelValueCount: number;
}

export interface LocalResourceUsage {
  activeLocalsBefore(statement: Parser.Statement): number | undefined;
}

const COMMON_RESOURCES: RuntimeResourceBudget = {
  maxActiveLocalsPerFunction: 200,
  maxRegistersPerFunction: 255,
  // compilerの一時register推定が未完成でも、local/register上限間に余裕を残す。
  conservativeParallelValueLimit: 50,
};

export function runtimeEnvironmentOf(
  profile: RuntimeProfile,
): RuntimeEnvironment {
  if (profile === "stormworks") {
    return {
      profile,
      semantics: {
        mutableMetatables: false,
        debugLocalIntrospection: false,
      },
      resources: COMMON_RESOURCES,
    };
  }
  return {
    profile,
    semantics: {
      mutableMetatables: true,
      debugLocalIntrospection: true,
    },
    resources: COMMON_RESOURCES,
  };
}

export function checkParallelValueCount(
  environment: RuntimeEnvironment,
  count: number,
): ResourceDecision {
  return checkParallelEvaluation(environment, {
    activeLocalsBefore: 0,
    parallelValueCount: count,
  });
}

export function checkParallelEvaluation(
  environment: RuntimeEnvironment,
  request: ParallelEvaluationRequest,
): ResourceDecision {
  const limit = environment.resources.conservativeParallelValueLimit;
  const localHeadroom = Math.max(
    0,
    environment.resources.maxActiveLocalsPerFunction -
      request.activeLocalsBefore,
  );
  const registerHeadroom = Math.max(
    0,
    environment.resources.maxRegistersPerFunction - request.activeLocalsBefore,
  );
  const allowedCount = Math.min(limit, localHeadroom, registerHeadroom);
  const estimatedPeakRegisters =
    request.activeLocalsBefore + request.parallelValueCount;
  if (request.parallelValueCount <= allowedCount) {
    return {
      allowed: true,
      confidence: "conservative-policy",
      limit: allowedCount,
      estimatedPeakRegisters,
    };
  }
  const reason =
    localHeadroom < request.parallelValueCount
      ? "local-limit"
      : registerHeadroom < request.parallelValueCount
        ? "register-limit"
        : "parallel-value-limit";
  return {
    allowed: false,
    reason,
    limit: allowedCount,
    estimatedPeakRegisters,
  };
}

/** 各function/blockの字句的local生存数を、文の直前位置で数える。 */
export function analyzeLocalResourceUsage(
  chunk: Parser.Chunk,
): LocalResourceUsage {
  const activeBefore = new WeakMap<Parser.Statement, number>();

  const visitBlock = (body: Parser.Statement[], entryActive: number): void => {
    let active = entryActive;
    body.forEach((statement) => {
      activeBefore.set(statement, active);
      switch (statement.type) {
        case "LocalStatement":
          active += statement.variables.length;
          break;
        case "FunctionDeclaration":
          visitBlock(statement.body, statement.parameters.length);
          if (statement.isLocal) active++;
          break;
        case "DoStatement":
        case "WhileStatement":
          visitBlock(statement.body, active);
          break;
        case "RepeatStatement":
          visitBlock(statement.body, active);
          break;
        case "IfStatement":
          statement.clauses.forEach((clause) => {
            visitBlock(clause.body, active);
          });
          break;
        case "ForNumericStatement":
          visitBlock(statement.body, active + 1);
          break;
        case "ForGenericStatement":
          visitBlock(statement.body, active + statement.variables.length);
          break;
      }
    });
  };
  visitBlock(chunk.body, 0);
  return { activeLocalsBefore: (statement) => activeBefore.get(statement) };
}
import Parser from "luaparse";

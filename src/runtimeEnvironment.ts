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
    }
  | {
      readonly allowed: false;
      readonly reason: "parallel-value-limit";
      readonly limit: number;
    };

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
  const limit = environment.resources.conservativeParallelValueLimit;
  return count <= limit
    ? { allowed: true, confidence: "conservative-policy", limit }
    : { allowed: false, reason: "parallel-value-limit", limit };
}

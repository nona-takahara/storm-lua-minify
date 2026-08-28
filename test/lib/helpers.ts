import path from "path";
import { Options } from "luaparse";
import { RawSourceMap } from "source-map";
import { Minifier, MinifierMode } from "../../src/minifier";

export const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");
export const SNAPSHOTS_DIR = path.join(__dirname, "..", "snapshots");

export const LUAPARSE_SETTINGS: Partial<Options> = {
  locations: true,
  luaVersion: "5.3",
  ranges: true,
  scope: true,
};

export interface FixtureCase {
  label: string;
  fixture: string;
  entry?: string;
  mode: MinifierMode;
}

export interface KnownBugCase extends FixtureCase {
  issue: number;
}

export function fixtureEntryPath(fixture: string, entry = "main.lua"): string {
  return path.join(FIXTURES_DIR, fixture, entry);
}

export function slug(c: Pick<FixtureCase, "fixture" | "mode">): string {
  return `${c.fixture}.${c.mode.requireWrapper ? "m" : "sl"}`;
}

export function runMinifier(c: FixtureCase): {
  code: string;
  map: RawSourceMap;
} {
  const minifier = new Minifier(
    fixtureEntryPath(c.fixture, c.entry),
    LUAPARSE_SETTINGS,
    c.mode,
  );
  const sourceNode = minifier.parse();
  const { code, map } = sourceNode.toStringWithSourceMap({
    file: c.fixture + ".min.lua",
  });
  return { code, map: map.toJSON() };
}

// Every case satisfies the approved-output, parseability, and binding contracts.
export const WORKING_CASES: FixtureCase[] = [
  {
    label: "single file",
    fixture: "single-file",
    mode: { requireWrapper: false },
  },
  {
    label: 'require("m") call syntax (wrapper mode)',
    fixture: "require-call",
    mode: { requireWrapper: true },
  },
  {
    label: "dofile (direct-splice mode)",
    fixture: "dofile",
    mode: { requireWrapper: false },
  },
  {
    label: "repeated require of one module (wrapper mode)",
    fixture: "multi-require",
    mode: { requireWrapper: true },
  },
  {
    label: "many top-level requires (wrapper mode)",
    fixture: "entry-scope-many-requires",
    mode: { requireWrapper: true },
  },
  {
    label: "bitwise and floor-division precedence (issue #27 regression)",
    fixture: "bitwise-precedence",
    mode: { requireWrapper: false },
  },
  {
    label: 'require "m" string-call syntax resolves in wrapper mode',
    fixture: "require-string-call",
    mode: { requireWrapper: true },
  },
  {
    label: "direct-splice mode expands a required module at the call site",
    fixture: "require-call",
    mode: { requireWrapper: false },
  },
  {
    label: "direct-splice mode expands repeated requires independently",
    fixture: "multi-require",
    mode: { requireWrapper: false },
  },
  {
    label:
      "direct-splice mode expands a bare require without a function wrapper",
    fixture: "bare-require",
    mode: { requireWrapper: false },
  },
  {
    label:
      "direct-splice mode falls back to an IIFE for a nested require expression",
    fixture: "require-in-expression",
    mode: { requireWrapper: false },
  },
  {
    label: "a dotted module name resolves to a subdirectory in wrapper mode",
    fixture: "nested-module",
    mode: { requireWrapper: true },
  },
  {
    label:
      "wrapper mode merges adjacent requires but preserves reference-order hazards",
    fixture: "merge-locals",
    mode: { requireWrapper: true },
  },
  {
    label: "direct-splice mode keeps adjacent requires separate for splicing",
    fixture: "merge-locals",
    mode: { requireWrapper: false },
  },
  {
    label: "a frequent non-renamable global receives a local alias",
    fixture: "global-alias",
    mode: { requireWrapper: false },
  },
  {
    label: "constant evaluation and propagation",
    fixture: "const-fold",
    mode: { requireWrapper: false, constantOptimizations: true },
  },
];

// These fixtures join WORKING_CASES once they satisfy the shared contracts.
export const KNOWN_BUG_CASES: KnownBugCase[] = [];

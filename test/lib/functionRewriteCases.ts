import fs from "node:fs";
import path from "node:path";

export const functionRewriteCases = JSON.parse(
  fs.readFileSync(
    path.resolve("test/cases/functionRewriteSemantics.json"),
    "utf8",
  ),
) as { name: string; source: string; stdout: string }[];

import { Command, Option } from "commander";
import { optimizationOptionDefinitions } from "./options";

function addBooleanSwitch(
  command: Command,
  name: string,
  description: string,
  shortName?: string,
): void {
  command.addOption(
    new Option(
      shortName ? `${shortName}, --${name}` : `--${name}`,
      description,
    ).default(undefined),
  );
  command.addOption(
    new Option(`--no-${name}`, `Disable ${description.toLowerCase()}`).default(
      undefined,
    ),
  );
}

/** Build the v1 CLI surface without materializing inherited defaults. */
export function createCliProgram(): Command {
  const command = new Command()
    .version("1.0.0")
    .description("A Lua minifier also outputs source map")
    .option("--config <path>", "JSON configuration file")
    .addOption(
      new Option("--runtime-profile <profile>", "Target runtime semantics")
        .choices(["stormworks", "lua53"])
        .default(undefined),
    )
    .addOption(
      new Option(
        "--required-whitespace <style>",
        "Required token separator style",
      )
        .choices(["space", "lf"])
        .default(undefined),
    )
    .addOption(
      new Option(
        "--never-rename-global <name>",
        "Global name that must remain externally visible (repeatable)",
      ).argParser((name: string, names?: string[]) => [...(names ?? []), name]),
    )
    .addOption(
      new Option(
        "--source-mapping-url-style <style>",
        "sourceMappingURL output style",
      )
        .choices(["legacy", "line", "strict"])
        .default(undefined),
    );

  addBooleanSwitch(
    command,
    "require-wrapper",
    "Expand require through a generated function wrapper",
    "-m",
  );
  optimizationOptionDefinitions.forEach((definition) => {
    addBooleanSwitch(command, definition.name, `Enable ${definition.name}`);
  });
  addBooleanSwitch(
    command,
    "allow-introspection-changes",
    "Allow changes observable through debug introspection",
  );
  addBooleanSwitch(
    command,
    "allow-observable-table-read-changes",
    "Allow table reads to cross writes that may change their values",
  );
  addBooleanSwitch(
    command,
    "assume-annotations",
    "Trust supported EmmyLua annotations as optimizer facts",
  );
  addBooleanSwitch(
    command,
    "collect-optimization-diagnostics",
    "Collect optimizer decision diagnostics",
  );
  return command;
}

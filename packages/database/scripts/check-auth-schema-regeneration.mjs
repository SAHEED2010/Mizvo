import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const databaseRoot = fileURLToPath(new URL("../", import.meta.url));
const schemaPath = join(databaseRoot, "src/schema/auth.ts");
const migrationMetaPath = join(databaseRoot, "migrations/meta");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(args) {
  const result = spawnSync(pnpm, args, {
    cwd: databaseRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed: pnpm ${args.join(" ")}`);
}

function runWithExpectedOutput(args, expectedOutput) {
  const result = spawnSync(pnpm, args, {
    cwd: databaseRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout?.includes(expectedOutput)) {
    throw new Error(`Command did not report success: pnpm ${args.join(" ")}`);
  }
}

const committedSchema = await readFile(schemaPath, "utf8");
run(["run", "db:auth-schema"]);
const regeneratedSchema = await readFile(schemaPath, "utf8");
if (regeneratedSchema !== committedSchema) {
  throw new Error(
    "Auth schema regeneration changed src/schema/auth.ts. Review the generated diff and preserve Mizvo's custom tables and constraints.",
  );
}

const tempRoot = await mkdtemp(join(databaseRoot, ".auth-schema-check-"));
const tempOutput = relative(databaseRoot, tempRoot);
try {
  const tempMetaPath = join(tempRoot, "meta");
  await cp(migrationMetaPath, tempMetaPath, { recursive: true });

  runWithExpectedOutput(
    [
      "exec",
      "drizzle-kit",
      "generate",
      "--dialect",
      "postgresql",
      "--schema",
      "src/schema/auth.ts",
      "--out",
      tempOutput,
      "--name",
      "schema-regeneration-check",
    ],
    "No schema changes, nothing to migrate",
  );

  const generatedFiles = await readdir(tempRoot);
  if (generatedFiles.some((file) => file !== "meta")) {
    throw new Error(
      "The regenerated auth schema differs from the latest committed migration snapshot; a migration would be generated.",
    );
  }

  runWithExpectedOutput(
    ["exec", "drizzle-kit", "check", "--dialect", "postgresql", "--out", "migrations"],
    "Everything's fine",
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("Auth schema regeneration is stable and matches the committed migration history.");

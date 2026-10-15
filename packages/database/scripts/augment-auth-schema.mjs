import { readFile, unlink, writeFile } from "node:fs/promises";

const generatedPath = new URL("../src/schema/auth.generated.ts", import.meta.url);
const schemaPath = new URL("../src/schema/auth.ts", import.meta.url);
const customSchemaPath = new URL("../src/schema/auth.custom.ts.fragment", import.meta.url);
let generated;

try {
  generated = await readFile(generatedPath, "utf8");
  const pgCoreImport = generated.match(/^import \{([^}]+)\} from "drizzle-orm\/pg-core";$/m);
  if (!pgCoreImport) throw new Error("Could not find the generated drizzle-orm/pg-core import");

  const pgCoreNames = new Set(
    pgCoreImport[1]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  pgCoreNames.add("check");
  pgCoreNames.add("uniqueIndex");
  generated = generated.replace(
    pgCoreImport[0],
    `import {\n  ${[...pgCoreNames].sort().join(",\n  ")},\n} from "drizzle-orm/pg-core";`,
  );
  const drizzleImport = generated.match(/^import \{([^}]+)\} from "drizzle-orm";$/m);
  if (drizzleImport) {
    const drizzleNames = new Set(drizzleImport[1].split(",").map((name) => name.trim()));
    drizzleNames.add("sql");
    generated = generated.replace(
      drizzleImport[0],
      `import { ${[...drizzleNames].sort().join(", ")} } from "drizzle-orm";`,
    );
  } else {
    generated = `import { relations, sql } from "drizzle-orm";\n${generated}`;
  }

  generated = generated.replace(
    /role: text\("role"\)\.default\("member"\)\.notNull\(\),/,
    'role: text("role").notNull(),',
  );
  const memberStart = generated.indexOf("export const member = pgTable(");
  const memberEnd = generated.indexOf("\n);", memberStart);
  if (memberStart < 0 || memberEnd < 0)
    throw new Error("Could not locate the generated member table");
  const memberTable = generated.slice(memberStart, memberEnd);
  const userIndex = 'index("member_userId_idx").on(table.userId),';
  if (!memberTable.includes(userIndex))
    throw new Error("Generated member indexes changed; review schema augmentation");
  if (memberTable.includes("member_organization_user_unique")) {
    throw new Error(
      "Generated schema unexpectedly already contains Mizvo's custom membership index",
    );
  }
  const roleCheck = `check("member_role_allowed", sql\`$${"{table.role}"} IN ('owner', 'manager', 'staff', 'viewer')\`),`;
  generated = generated.replace(
    userIndex,
    `${userIndex}\n    uniqueIndex("member_organization_user_unique").on(table.organizationId, table.userId),\n    ${roleCheck}`,
  );

  if (generated.includes("export const phoneInvitation = pgTable(")) {
    throw new Error(
      "Generated schema unexpectedly already contains Mizvo's custom invitation tables",
    );
  }

  const customSchema = await readFile(customSchemaPath, "utf8");
  await writeFile(schemaPath, `${generated.trimEnd()}\n\n${customSchema.trim()}\n`);
} finally {
  await unlink(generatedPath).catch(() => {});
}

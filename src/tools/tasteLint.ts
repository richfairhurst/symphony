import path from "node:path";
import { lintTasteRepo } from "../taste/lint";

function formatViolation(v: {
  filePath: string;
  line: number;
  column: number;
  ruleId: string;
  message: string;
}): string {
  return `${v.filePath}:${v.line}:${v.column} ${v.ruleId} ${v.message}`;
}

async function main(): Promise<number> {
  const repoRootAbs = path.resolve(".");
  const res = await lintTasteRepo({ repoRootAbs });
  if (res.violations.length === 0) {
    process.stdout.write("taste:lint ok\n");
    return 0;
  }
  for (const v of res.violations) process.stdout.write(`${formatViolation(v)}\n`);
  process.stderr.write(`taste:lint failed (${res.violations.length} violations)\n`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

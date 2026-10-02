// For trying a run by hand: node src/cli.ts <repo> <ref> <out-dir> <path>...
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { preview } from "./run.ts";

const [repo, ref, out, ...paths] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const started = Date.now();
try {
  const result = await preview(
    repo,
    ref,
    paths.flatMap((path, i) => [
      { name: `${i}-desktop`, path, width: 1280, height: 900 },
      { name: `${i}-mobile`, path, width: 390, height: 844, device: (process.env.DEVICE as "android") ?? "default" },
    ]),
  );
  for (const shot of result.shots) writeFileSync(join(out, `${shot.name}.png`), shot.png);
  writeFileSync(join(out, "log.txt"), result.log);
  console.log(`done in ${Math.round((Date.now() - started) / 1000)}s: ${result.shots.length} shots, failed ${JSON.stringify(result.failed)}`);
} catch (err) {
  writeFileSync(join(out, "log.txt"), (err as { log?: string }).log ?? String(err));
  console.log(`failed after ${Math.round((Date.now() - started) / 1000)}s: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

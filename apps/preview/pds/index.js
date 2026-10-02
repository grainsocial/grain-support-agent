// The reference PDS, started the way its Docker image starts it, configured
// entirely from PDS_* environment variables. The preview runner starts one
// per run, against a throwaway data directory.
import { PDS, envToCfg, envToSecrets, readEnv } from "@atproto/pds";

const env = readEnv();
const pds = await PDS.create(envToCfg(env), envToSecrets(env));
await pds.start();
console.log(`pds listening on ${env.port}`);

const stop = async () => {
  await pds.destroy();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

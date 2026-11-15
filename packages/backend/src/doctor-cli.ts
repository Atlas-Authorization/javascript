#!/usr/bin/env node
import { doctor, formatDoctorReport } from './doctor';

/** `atlas-doctor`: reads ATLAS_SECRET_KEY (and ATLAS_API_URL), prints the report, exits 1 on a failed check. */
export async function runDoctorCli(env: Record<string, string | undefined>, write: (line: string) => void): Promise<number> {
  const report = await doctor({ secretKey: env.ATLAS_SECRET_KEY ?? '', apiUrl: env.ATLAS_API_URL });
  write(formatDoctorReport(report));
  return report.ok ? 0 : 1;
}

// Runs only when executed directly, never when imported.
declare const process: { argv: string[]; env: Record<string, string | undefined>; exit(code: number): never };
if (typeof process !== 'undefined' && /doctor-cli\.(js|cjs|mjs)$/.test(process.argv[1] ?? '')) {
  runDoctorCli(process.env, (l) => console.log(l)).then((code) => process.exit(code));
}

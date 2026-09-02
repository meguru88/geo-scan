/** 依存なしの最小 CLI 引数パーサ。`--flag value` / `--flag=value` / `--flag`（真偽）に対応 */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

/** 値を取らないフラグ。後ろに位置引数が来ても飲み込まない */
const BOOLEAN_FLAGS = new Set(['mock', 'force', 'yes', 'skip-extract', 'no-pdf', 'help', 'check', 'no-install']);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
      continue;
    }
    positionals.push(a);
  }
  return { positionals, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagNumber(args: ParsedArgs, name: string, fallback: number): number {
  const v = args.flags[name];
  if (typeof v !== 'string') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} には数値を指定してください（指定値: ${v}）`);
  return n;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  const v = args.flags[name];
  return v === true || v === '1' || v === 'true';
}

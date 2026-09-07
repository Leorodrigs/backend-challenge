// Review aid: findings are classified, not silently equated with financial bugs.
const rules = {
  numericConversion: /\b(?:Number|parseFloat|parseInt)\s*\(|\.toNumber\s*\(|\.toFixed\s*\(/,
  memoryCollections: /\bnew (?:Map|Set)\b/,
  publication: /\bPublishCommand\b|\.publish\(/,
  databaseLock: /PESSIMISTIC_WRITE|for update|skip locked/i,
  unsafeTypes: /\bany\b|@ts-ignore|@ts-nocheck/,
  ledgerMutation: /(?:update|delete from)\s+["']?wallet_ledger_entries/i,
};
const matches: { category: string; file: string; line: number; text: string }[] = [];
for await (const file of new Bun.Glob('src/**/*.ts').scan('.')) {
  const lines = (await Bun.file(file).text()).split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [category, pattern] of Object.entries(rules)) {
      if (pattern.test(line)) matches.push({ category, file, line: index + 1, text: line.trim() });
    }
  });
}
const config = await Bun.file('tsconfig.json').json() as { compilerOptions: { strict?: boolean; noImplicitAny?: boolean } };
if (config.compilerOptions.strict !== true || config.compilerOptions.noImplicitAny !== true) throw new Error('Strict compiler settings required');
if (matches.some((match) => match.category === 'unsafeTypes' || match.category === 'ledgerMutation')) throw new Error('Static audit requires investigation');
console.log(JSON.stringify({ status: 'PASS', limitation: 'Pattern review complements real SQL/distributed tests; it cannot prove financial invariants.', matches }, null, 2));

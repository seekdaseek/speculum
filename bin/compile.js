#!/usr/bin/env node
// speculum — compile
//
// Writes artifacts/Speculum.json with the ABI and bytecode, and prints the gas
// the compiler estimates. The gas figures matter to the design rather than
// being trivia: the argument for emitting events instead of storing verdicts
// rests on record() being cheap, and an argument like that should rest on a
// measured number.
//
//   node bin/compile.js

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const solc = require('solc');

const SOURCE = 'contracts/Speculum.sol';
const source = readFileSync(SOURCE, 'utf8');

const input = {
  language: 'Solidity',
  sources: { 'Speculum.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.gasEstimates'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));

const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
const warnings = (out.errors ?? []).filter((e) => e.severity !== 'error');

for (const w of warnings) console.warn('warning:', w.formattedMessage.split('\n')[0]);

if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}

const c = out.contracts['Speculum.sol'].Speculum;

mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/Speculum.json',
  JSON.stringify(
    { compiler: solc.version(), abi: c.abi, bytecode: '0x' + c.evm.bytecode.object },
    null,
    2,
  ) + '\n',
);

console.log(`compiled with ${solc.version()}`);
console.log(`  bytecode      ${c.evm.bytecode.object.length / 2} bytes`);
console.log(`  deployment    ${c.evm.gasEstimates.creation.totalCost} gas`);
for (const [fn, gas] of Object.entries(c.evm.gasEstimates.external)) {
  console.log(`  ${fn.padEnd(38)} ${gas} gas`);
}
console.log('\nartifacts/Speculum.json written');

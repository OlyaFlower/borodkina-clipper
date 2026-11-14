// Checks a scene spec before it is rendered:
//   node motion/kit/validate.mjs <scene.json> [<meta.json>]
// 1. against motion/kit/scene.schema.json (structure, block names, every kit block's parameters);
// 2. against the kit itself (lib/spec.js checkSpec): the first block is a base block that suits the
//    cover's framing, presets exist, beats and delays are loop-safe.
// Custom blocks (custom/<name>) are checked for structure only here; the composition checks their
// parameters when it loads them. Prints "ok <name>" or the problems, and exits 1 on any problem.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Ajv from 'ajv';
import { CUSTOM_PREFIX, checkSpec } from './lib/spec.js';
import { kitBlocks } from './schema.mjs';

const schema = JSON.parse(readFileSync(new URL('./scene.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

/** Returns a list of problems (empty when the spec is fine). */
export async function validate(spec, meta = null) {
  if (!validateSchema(spec)) {
    return validateSchema.errors.map((e) => `schema: ${e.instancePath || '/'} ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(', ')})` : ''}`);
  }
  const blocks = await kitBlocks();
  const custom = { stage: 'pixel', params: {}, presets: { subtle: {}, medium: {} } };
  const plain = {
    ...spec,
    blocks: spec.blocks.map((b) => (b.block.startsWith(CUSTOM_PREFIX) ? { ...b, params: {} } : b)),
  };
  for (const b of plain.blocks) if (b.block.startsWith(CUSTOM_PREFIX)) blocks[b.block] = { ...custom, name: b.block };
  try {
    checkSpec(plain, blocks, meta ?? { framing: { mode: spec.blocks[0]?.block === 'card-float' ? 'extend' : 'crop' } });
  } catch (e) {
    return [e.message];
  }
  return [];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [specPath, metaPath] = process.argv.slice(2);
  let spec;
  let meta = null;
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf8'));
    if (metaPath) meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (e) {
    console.error(`cannot read the spec: ${e.message}`);
    process.exit(1);
  }
  const problems = await validate(spec, meta);
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log(`ok ${spec.name ?? specPath}`);
}

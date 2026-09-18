#!/usr/bin/env node
// Set or rotate the Stripe keys, interactively.
//
//   node tools/stripe-keys.mjs            prompt for every key
//   node tools/stripe-keys.mjs webhook    just one (webhook | secret | publishable)
//   node tools/stripe-keys.mjs --local    write .dev.vars only, don't touch Cloudflare
//
// Typed values are hidden and never echoed, never passed as a command argument
// (so they stay out of shell history) and never printed back: the script only
// confirms the prefix and last 4 characters.
//
// Secrets go to two places:
//   - .dev.vars for `wrangler dev` (gitignored)
//   - the deployed Worker, piped into `wrangler secret put` over stdin
// The publishable key isn't a secret and isn't used by any page yet (Payment
// Links are hosted by Stripe), so it's only written to .dev.vars.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const DEV_VARS = new URL('../.dev.vars', import.meta.url);

const KEYS = {
  webhook: {
    name: 'STRIPE_WEBHOOK_SECRET',
    label: 'Webhook signing secret',
    hint: 'Dashboard > Developers > Webhooks > your endpoint > Signing secret',
    prefixes: ['whsec_'],
    secret: true,
  },
  secret: {
    name: 'STRIPE_SECRET_KEY',
    label: 'API key (restricted key preferred)',
    hint: 'Dashboard > Developers > API keys. Only needed once we call the API (invoices).',
    prefixes: ['rk_', 'sk_'],
    secret: true,
    optional: true,
  },
  publishable: {
    name: 'STRIPE_PUBLISHABLE_KEY',
    label: 'Publishable key',
    hint: 'Not used by any page yet. Only needed if we add Stripe.js checkout.',
    prefixes: ['pk_'],
    secret: false,
    optional: true,
  },
};

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let muted = false;
rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      muted = false;
      if (hidden) rl.output.write('\n');
      resolve(answer.trim());
    });
    muted = hidden;
  });
}

const mask = (v) => `${v.slice(0, v.indexOf('_') + 1)}…${v.slice(-4)}`;

// Keep any unrelated lines in .dev.vars; replace only the key being set.
function writeDevVar(name, value) {
  const lines = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, 'utf8').split(/\r?\n/) : [];
  const kept = lines.filter((l) => l.trim() && !l.startsWith(`${name}=`));
  kept.push(`${name}=${value}`);
  writeFileSync(DEV_VARS, kept.join('\n') + '\n', { mode: 0o600 });
}

function putWorkerSecret(name, value) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['wrangler', 'secret', 'put', name], {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: process.platform === 'win32', // npx is a .cmd on Windows
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.write(`${value}\n`);
    child.stdin.end();
  });
}

const args = process.argv.slice(2);
const localOnly = args.includes('--local');
const wanted = args.filter((a) => !a.startsWith('--'));
const chosen = wanted.length ? wanted : Object.keys(KEYS);

for (const which of chosen) {
  const key = KEYS[which];
  if (!key) {
    console.log(`Unknown key "${which}". Use: ${Object.keys(KEYS).join(', ')}`);
    continue;
  }
  console.log(`\n${key.label}  (${key.name})`);
  console.log(`  ${key.hint}`);
  const value = await ask(`  paste it${key.optional ? ', or press Enter to skip' : ''}: `, key.secret);
  if (!value) { console.log('  skipped'); continue; }

  if (!key.prefixes.some((p) => value.startsWith(p))) {
    console.log(`  ✗ that doesn't look right: expected ${key.prefixes.join(' or ')}. Nothing was saved.`);
    continue;
  }
  if (value.startsWith('sk_')) {
    console.log('  ! a restricted key (rk_) is safer than a full secret key — it can be scoped to what we use.');
  }
  if (value.includes('_live_')) {
    const go = await ask('  ! this is a LIVE key. Type "live" to confirm: ');
    if (go !== 'live') { console.log('  skipped'); continue; }
  }

  writeDevVar(key.name, value);
  console.log(`  ✓ .dev.vars updated (${mask(value)})`);

  if (key.secret && !localOnly) {
    const ok = await putWorkerSecret(key.name, value);
    console.log(ok
      ? `  ✓ set on the deployed Worker`
      : `  ✗ could not set it on the Worker. If it isn't deployed yet, deploy first, then rerun this.`);
  }
}

rl.close();
console.log('\n.dev.vars is gitignored. Rerun this script to rotate a key, or after switching sandbox → live.');

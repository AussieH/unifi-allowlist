#!/usr/bin/env node
/**
 * Sets or changes the admin UI password. Prompts twice without echo, or reads one line
 * from a pipe when there is no terminal. Writes an scrypt hash into the config and never
 * prints the password.
 *
 *   node set-password.js --config /etc/unifi-allowlist/admin-ui.json
 *   printf '%s\n' "$PASS" | node set-password.js --config …     # non-interactive
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const args = process.argv.slice(2);
const configPath = args[args.indexOf('--config') + 1] || args[args.indexOf('-c') + 1] || '/etc/unifi-allowlist/admin-ui.json';
const CTRL_C = '\u0003';
const DEL = '\u007f';

function readPiped() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf.split(/\r?\n/)[0]));
    process.stdin.on('error', reject);
  });
}

function prompt(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(value);
      } else if (ch === CTRL_C) {
        stdout.write('\n');
        process.exit(130);
      } else if (ch === DEL || ch === '\b') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const interactive = !!process.stdin.isTTY;
  const a = interactive ? await prompt('New admin UI password: ') : await readPiped();
  if (a.length < 12) {
    console.error('Use at least 12 characters.');
    process.exit(1);
  }
  const b = interactive ? await prompt('Again: ') : a;
  if (a !== b) {
    console.error('They did not match.');
    process.exit(1);
  }
  const N = 1 << 15, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(a, salt, 32, { N, r, p, maxmem: 128 * 1024 * 1024 });
  cfg.passwordHash = ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
  if (!cfg.sessionSecret || String(cfg.sessionSecret).startsWith('PASTE_')) cfg.sessionSecret = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`Password set in ${configPath}. Restart the service: systemctl restart unifi-allowlist-ui`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

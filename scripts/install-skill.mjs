// Makes the jira-stories skill available to Claude Code in every project on this machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'jira-stories');
const dir = path.join(os.homedir(), '.claude', 'skills');
const dest = path.join(dir, 'jira-stories');
const copy = process.argv.includes('--copy');

fs.mkdirSync(dir, { recursive: true });
if (fs.existsSync(dest) || fs.lstatSync(dest, { throwIfNoEntry: false })) {
  console.error(`${dest} already exists. Remove it first if you want to reinstall.`);
  process.exit(1);
}
if (copy) fs.cpSync(src, dest, { recursive: true });
else fs.symlinkSync(src, dest, 'dir');
console.log(`${copy ? 'Copied' : 'Linked'} jira-stories to ${dest}`);
console.log('Set JIRA_BASE_URL and your credentials in your shell profile, or pass --env-file to the script.');

// Test entry point (`npm test`, `npm run coverage`).
//
// This fork's render uploads every page to DocReader by default, and a
// developer machine may well have real credentials configured (an adapter in
// $AM_HOME/adapters/ or DOC_READER_API_KEY in the environment). The suite
// renders hundreds of pages; without a guard, every render that reaches the
// real environment uploads a junk document (this actually happened: 396
// "Untitled" documents from one full-suite run).
//
// So force the upload off for the whole run and strip the credentials from
// the environment the tests inherit. In-process tests see this env, and tests
// that spawn the CLI as a subprocess inherit it too. Tests of the upload
// itself inject their own env and a stub server, so they still exercise the
// real upload code paths.
import { spawnSync } from 'node:child_process';

const env = { ...process.env, AM_DOCREADER_UPLOAD: '0' };
delete env.DOC_READER_API_KEY;
delete env.AM_DOCREADER_ADAPTER;

const run = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit', env });
process.exit(run.status ?? 1);

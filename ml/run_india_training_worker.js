import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = process.argv[2];
if (!SCRIPT) throw new Error('Training script path is required.');
const PYTHON = process.env.PYTHON_EXECUTABLE || (process.platform === 'win32' ? 'py' : 'python3');
const PYTHON_ARGS = process.platform === 'win32' && !process.env.PYTHON_EXECUTABLE ? ['-3.14', '-X', 'utf8'] : [];
const child = spawn(PYTHON, [...PYTHON_ARGS, SCRIPT, ...process.argv.slice(3)], {
  cwd: ROOT,
  windowsHide: true,
  stdio: 'inherit',
  env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
});
child.once('error', error => {
  process.stderr.write(`[India training worker] ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
child.once('close', code => { process.exitCode = code ?? 1; });

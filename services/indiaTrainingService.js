import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ML = path.join(ROOT, 'ml');
const DATA = path.join(ML, 'data');
const MODEL_DIR = path.join(ML, 'models');
const LOG_DIR = path.join(DATA, 'world-cities', 'training_logs');
const CATALOG = path.join(DATA, 'world-cities', 'selected_cities.csv');
const STATE = path.join(LOG_DIR, 'india_training_state.json');
const LOCK = path.join(LOG_DIR, 'india_training.lock');
const SCRIPT = path.join(ML, 'train_all_cities.py');
const WORKER = path.join(ML, 'run_india_training_worker.js');
const DEFAULT_POPULATION = 100000;
const PYTHON = process.env.PYTHON_EXECUTABLE || (process.platform === 'win32' ? 'py' : 'python3');
const PYTHON_ARGS = process.platform === 'win32' && !process.env.PYTHON_EXECUTABLE ? ['-3.14', '-X', 'utf8'] : [];
let startInFlight = null;
let runningChild = null;

const slug = value => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
function targetReady(key, target) {
  const candidates = [key, key.replace(/_in_\d+$/, '')];
  for (const candidate of new Set(candidates)) {
    const model = path.join(MODEL_DIR, `${candidate}_${target}_xgb.joblib`);
    const metadata = path.join(MODEL_DIR, `${candidate}_${target}_metadata.json`);
    try {
      const meta = JSON.parse(fs.readFileSync(metadata, 'utf8'));
      if (fs.statSync(model).size > 0 && meta.model_version === 5 && meta.target === target &&
          Array.isArray(meta.feature_names) && meta.feature_names.length &&
          Number.isFinite(Number(meta.aggregate_validation?.mae))) return true;
    } catch {}
  }
  return false;
}
function readCatalogue() {
  const text = fs.readFileSync(CATALOG, 'utf8').replace(/^\uFEFF/, '');
  const [header, ...lines] = text.split(/\r?\n/);
  const columns = header.split(',');
  const index = Object.fromEntries(columns.map((column, i) => [column, i]));
  return lines.filter(Boolean).flatMap(line => {
    const cols = line.split(',');
    if (cols[index.country_code]?.toUpperCase() !== 'IN') return [];
    const population = Number(cols[index.population]) || 0;
    if (population < DEFAULT_POPULATION) return [];
    const name = cols[index.city]?.trim();
    if (!name) return [];
    const key = slug(name);
    const suffixKey = `${key}_in_${cols[index.geoname_id]}`;
    return [{ city: name, key, suffixKey, population, geonameId: cols[index.geoname_id] }];
  });
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
function workerPid() {
  const lock = readJson(LOCK);
  const state = readJson(STATE);
  const pid = lock?.pid || state?.worker_pid;
  return pidAlive(pid) ? Number(pid) : null;
}
function csvModelState(city) {
  const aqi = targetReady(city.key, 'us_aqi') || targetReady(city.suffixKey, 'us_aqi');
  const pm25 = targetReady(city.key, 'pm2_5') || targetReady(city.suffixKey, 'pm2_5');
  return { aqi, pm25 };
}

export function getIndiaTrainingStatus() {
  const cities = readCatalogue();
  const stored = readJson(STATE);
  const counts = { both_models_ready: 0, aqi_model_missing: 0, pm2_5_model_missing: 0, both_models_missing: 0 };
  let historicalDataUnavailable = 0;
  for (const city of cities) {
    const models = csvModelState(city);
    if (models.aqi && models.pm25) counts.both_models_ready++;
    else if (models.aqi) counts.pm2_5_model_missing++;
    else if (models.pm25) counts.aqi_model_missing++;
    else counts.both_models_missing++;
    const historyKeys = [city.key, city.suffixKey];
    if (!historyKeys.some(key => {
      try { return fs.statSync(path.join(DATA, `${key}_historical.csv`)).size > 0; } catch { return false; }
    })) historicalDataUnavailable++;
  }
  const total = cities.length;
  const completed = counts.both_models_ready;
  const livePid = workerPid();
  const storedFailed = new Set(Object.values(stored?.cities || {})
    .filter(city => ['historical_data_unavailable', 'training_failed'].includes(city.status))
    .map(city => String(city.geoname_id)));
  let failed = 0;
  for (const city of cities) {
    const models = csvModelState(city);
    if (models.aqi && models.pm25) continue;
    if (storedFailed.has(String(city.geonameId))) failed++;
  }
  const currentRecord = Object.values(stored?.cities || {}).find(city => ['in_progress', 'retrying'].includes(city.status));
  const currentProgress = currentRecord ? readJson(path.join(DATA, `${currentRecord.key}_progress.json`)) : null;
  const processing = livePid && currentRecord ? 1 : 0;
  const pending = Math.max(0, total - completed - failed - processing);
  return {
    scope: 'IN', minPopulation: DEFAULT_POPULATION,
    totalCities: total, completedCities: completed, readyCities: completed,
    processingCities: processing, pendingCities: pending, failedCities: failed,
    currentTrainingCity: livePid ? (stored?.current_city || null) : null,
    currentProgress: livePid ? currentProgress : null,
    running: Boolean(livePid), workerPid: livePid,
    historicalDataUnavailable,
    modelCoverage: counts,
    updatedAt: stored?.updated_at || null,
    stateFile: STATE,
  };
}

export function startIndiaTraining() {
  if (startInFlight) return startInFlight;
  if (runningChild && runningChild.exitCode == null) {
    return Promise.resolve({ started: false, alreadyRunning: true, pid: runningChild.pid, status: getIndiaTrainingStatus() });
  }
  const currentPid = workerPid();
  if (currentPid) return Promise.resolve({ started: false, alreadyRunning: true, pid: currentPid, status: getIndiaTrainingStatus() });
  startInFlight = new Promise((resolve, reject) => {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const logPath = path.join(LOG_DIR, 'india_training.log');
    let logFd;
    try {
      logFd = fs.openSync(logPath, 'a');
      const child = spawn(process.execPath, [WORKER, SCRIPT, '--min-population', String(DEFAULT_POPULATION)], {
        cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', logFd, logFd],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
      fs.closeSync(logFd);
      runningChild = child;
      child.once('close', () => { if (runningChild === child) runningChild = null; });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve({ started: true, pid: child.pid, logFile: logPath, status: {
          ...getIndiaTrainingStatus(), running: true, workerPid: child.pid,
        } });
      });
    } catch (error) {
      if (logFd != null) try { fs.closeSync(logFd); } catch {}
      reject(error);
    }
  }).finally(() => { startInFlight = null; });
  return startInFlight;
}

export function resumeIndiaTrainingIfNeeded() {
  const state = readJson(STATE);
  if (!state || (!state.pending && !state.failed)) return Promise.resolve({ started: false, reason: 'no-pending-cities' });
  if (workerPid()) return Promise.resolve({ started: false, alreadyRunning: true, pid: workerPid() });
  return startIndiaTraining();
}

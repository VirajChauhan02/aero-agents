/** Background, single-worker XGBoost training for catalogue-listed Indian cities. */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ML = path.join(ROOT, 'ml');
const MODELS = path.join(ML, 'models');
const DATA = path.join(ML, 'data');
const CATALOG = path.join(DATA, 'world-cities', 'selected_cities.csv');
const PYTHON = process.env.PYTHON_EXECUTABLE || (process.platform === 'win32' ? 'py' : 'python3');
const PY_ARGS = process.platform === 'win32' && !process.env.PYTHON_EXECUTABLE ? ['-3.14', '-X', 'utf8'] : [];
const running = new Map();
const queue = [];
let worker = false;

const slug = s => String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
function indianCity(name, coordinates = null) {
  if (!fs.existsSync(CATALOG)) return null;
  const rows = fs.readFileSync(CATALOG, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const headers = rows.shift().split(',');
  const at = Object.fromEntries(headers.map((h, i) => [h, i]));
  const matches = [];
  for (const row of rows) {
    const cols = row.split(',');
    if (cols[at.country_code]?.toUpperCase() !== 'IN' || slug(cols[at.city]) !== slug(name)) continue;
    matches.push({ city: cols[at.city], key: slug(cols[at.city]), geonameId: cols[at.geoname_id], lat: Number(cols[at.latitude]), lon: Number(cols[at.longitude]) });
  }
  if (!matches.length) return null;
  let match = matches[0];
  if (matches.length > 1 && Number.isFinite(Number(coordinates?.lat)) && Number.isFinite(Number(coordinates?.lon))) {
    const distance = item => (item.lat - Number(coordinates.lat)) ** 2 + (item.lon - Number(coordinates.lon)) ** 2;
    match = matches.sort((a, b) => distance(a) - distance(b))[0];
  }
  if (matches.length > 1) match.key = `${match.key}_in_${match.geonameId}`;
  return match;
}
export function getIndianCityModelKey(city, coordinates = null) { return indianCity(city, coordinates)?.key || null; }
function paths(city) {
  const key = slug(city);
  return Object.fromEntries(['us_aqi', 'pm2_5'].map(t => [t, {
    model: path.join(MODELS, `${key}_${t}_xgb.joblib`),
    metadata: path.join(MODELS, `${key}_${t}_metadata.json`),
  }]));
}
function targetStatus(pair, target) {
  let metadata = null, error = null;
  const modelExists = fs.existsSync(pair.model);
  const metadataExists = fs.existsSync(pair.metadata);
  if (metadataExists) {
    try { metadata = JSON.parse(fs.readFileSync(pair.metadata, 'utf8')); } catch (e) { error = `Invalid metadata JSON: ${e.message}`; }
  }
  const valid = modelExists && fs.statSync(pair.model).size > 0 && metadata?.model_version === 5 && metadata?.target === target && Array.isArray(metadata?.feature_names) && metadata.feature_names.length > 0 && metadata?.aggregate_validation && Number.isFinite(Number(metadata.aggregate_validation.mae));
  return { ready: Boolean(valid), modelExists, metadataExists, metadata, error: error || (!valid && (modelExists || metadataExists) ? 'Model or compatible metadata is incomplete.' : null) };
}
export function getTrainingStatus(city) {
  const key = slug(city), p = paths(city);
  const targets = { us_aqi: targetStatus(p.us_aqi, 'us_aqi'), pm2_5: targetStatus(p.pm2_5, 'pm2_5') };
  let progress = null;
  const progressPath = path.join(DATA, `${key}_progress.json`);
  try { progress = JSON.parse(fs.readFileSync(progressPath, 'utf8')); } catch {}
  const age = progress?.updated_at ? Date.now() - Date.parse(progress.updated_at) : Infinity;
  if (progress && age > 3600000 && !['complete', 'training_failed'].includes(progress.phase)) progress = { ...progress, phase: 'stale', detail: 'Previous training stopped; retry is safe.' };
  if (progress?.phase === 'stale') progress = null;
  return { city: key, targets, isTrained: targets.us_aqi.ready && targets.pm2_5.ready, isTraining: running.has(key) || Boolean(progress && age < 3600000 && !['complete', 'training_failed'].includes(progress.phase)), progress };
}
function writeProgress(key, value) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, `${key}_progress.json`), JSON.stringify({ ...value, updated_at: new Date().toISOString() }, null, 2));
}
function runPython(script, args, timeoutMs = 45 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [...PY_ARGS, path.join(ML, script), ...args], { cwd: ML, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', d => process.stdout.write(`[ML] ${d}`));
    child.stderr.on('data', d => { stderr += d; process.stderr.write(`[ML] ${d}`); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Python timed out after ${timeoutMs / 60000} minutes`)); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr.trim() || `${script} exited ${code}`)); });
  });
}
async function execute(job) {
  const { key, city, coordinates } = job;
  running.set(key, job);
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        writeProgress(key, { phase: 'fetching_history', percent: 5, detail: `Checking cached Open-Meteo history for ${city} (attempt ${attempt}/2).` });
        await runPython('fetch_data.py', [key, '--lat', String(coordinates.lat), '--lon', String(coordinates.lon), '--reuse-cache']);
        writeProgress(key, { phase: 'training_models', percent: 55, detail: `Training only missing AQI/PM2.5 models for ${city}.` });
        await runPython('train_model.py', [key, '--fast']);
        const state = getTrainingStatus(key);
        if (!state.isTrained) throw new Error('Training ended without both valid models and target metadata.');
        writeProgress(key, { phase: 'complete', percent: 100, detail: `Both AQI and PM2.5 models are ready for ${city}.` });
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        writeProgress(key, { phase: 'retrying', percent: 15, detail: `${error.message} Retrying once.` });
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  } catch (error) {
    writeProgress(key, { phase: 'training_failed', percent: 0, detail: error.message });
  } finally { running.delete(key); }
}
async function drain() {
  if (worker) return;
  worker = true;
  try { while (queue.length) await execute(queue.shift()); }
  finally { worker = false; if (queue.length) void drain(); }
}
export function queueIndianCityTraining(city, coordinates = null) {
  const match = indianCity(city, coordinates);
  if (!match) return { started: false, reason: 'not-in-indian-city-catalogue' };
  const key = match.key;
  const status = getTrainingStatus(key);
  if (status.isTrained) return { started: false, reason: 'model-ready' };
  if (running.has(key) || queue.some(j => j.key === key)) return { started: false, reason: 'already-queued' };
  const coords = coordinates && Number.isFinite(Number(coordinates.lat)) && Number.isFinite(Number(coordinates.lon))
    ? { lat: Number(coordinates.lat), lon: Number(coordinates.lon) } : { lat: match.lat, lon: match.lon };
  const job = { key, city: match.city, coordinates: coords };
  queue.push(job);
  writeProgress(key, { phase: worker ? 'queued' : 'starting', percent: 1, detail: worker ? 'Waiting for the current background training job.' : 'Background training queued.' });
  void drain();
  return { started: true, queued: true, city: match.city, key };
}
// Keep the manual endpoint compatible; automatic callers must use the India-scoped entrypoint above.
export function queueManualTraining(city, coordinates = null) {
  const match = indianCity(city, coordinates);
  const key = match?.key || slug(city);
  if (running.has(key) || queue.some(j => j.key === key)) throw new Error(`Training is already queued or running for ${city}.`);
  const coords = coordinates || (match && { lat: match.lat, lon: match.lon });
  if (!coords || !Number.isFinite(Number(coords.lat)) || !Number.isFinite(Number(coords.lon))) throw new Error('Valid coordinates are required to train this city.');
  queue.push({ key, city: String(city), coordinates: coords });
  writeProgress(key, { phase: worker ? 'queued' : 'starting', percent: 1, detail: 'Manual background training queued.' });
  void drain();
  return { queued: true, city };
}

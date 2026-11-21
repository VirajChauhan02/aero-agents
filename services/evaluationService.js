// Live accuracy tracking: store every forecast, later compare it with what actually happened.
// Reference used for verification (be explicit in the UI):
//   * 'Open-Meteo analysis' = the provider's own value for the verified hour (modelled, NOT a station)
//   * 'Observed' = values the team enters from an independent source (e.g. airport METAR, CPCB/OpenAQ monitor)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.EVAL_DATA_DIR || path.join(__dirname, '..', 'data');
const FORECAST_LOG = () => path.join(DATA_DIR, 'prediction_log.jsonl');
const OBS_LOG = () => path.join(DATA_DIR, 'observations.jsonl');
export const HORIZONS = [1, 6, 24];

const asUtcMs = value => {
  const text = String(value);
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`);
};
const hourKey = ms => Math.round(ms / 3600000);

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}
function appendJsonl(file, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

export function metrics(pairs) {
  // pairs: [{pred, obs, base}] base = persistence baseline (value at issue time)
  const n = pairs.length;
  if (!n) return { n: 0 };
  const errs = pairs.map(p => p.pred - p.obs);
  const mae = errs.reduce((a, e) => a + Math.abs(e), 0) / n;
  const rmse = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / n);
  const bias = errs.reduce((a, e) => a + e, 0) / n;
  const meanObs = pairs.reduce((a, p) => a + p.obs, 0) / n;
  const sst = pairs.reduce((a, p) => a + (p.obs - meanObs) ** 2, 0);
  const sse = errs.reduce((a, e) => a + e * e, 0);
  const r2 = n >= 3 && sst > 0 ? 1 - sse / sst : null;
  const withBase = pairs.filter(p => Number.isFinite(p.base));
  const persistenceMae = withBase.length ? withBase.reduce((a, p) => a + Math.abs(p.base - p.obs), 0) / withBase.length : null;
  const r = x => (x == null ? null : Number(x.toFixed(3)));
  return {
    n, mae: r(mae), rmse: r(rmse), bias: r(bias), r2: r(r2), persistenceMae: r(persistenceMae),
    skillVsPersistence: persistenceMae ? r(1 - mae / persistenceMae) : null,
  };
}

// Called after each analysis run: remember what we predicted for +1h, +6h, +24h.
export function logForecast({ city, issuedAt, aqi, predictions }) {
  const rows = predictions?.hourlyTrajectory || [];
  if (!rows.length) return { logged: 0 };
  const issuedMs = asUtcMs(issuedAt);
  const existing = new Set(readJsonl(FORECAST_LOG()).filter(r => r.city === city).map(r => r.key));
  const source = predictions.modelStatus === 'ready' ? 'xgboost' : 'provider';
  const nowAqi = Number(aqi.current.usAqi);
  const nowTemp = aqi.current.meteorology.surfaceTemperatureC;
  const out = [];
  for (const h of HORIZONS) {
    const row = rows.find(r => r.horizonHours === h) || rows.find(r => Math.abs(r.horizonHours - h) <= 0 );
    if (!row) continue;
    const key = `${city}|${hourKey(issuedMs)}|${h}|${source}`;
    if (existing.has(key)) continue;
    out.push({
      key, city, source, horizon: h, issuedAt: new Date(issuedMs).toISOString(), targetTime: row.timestamp,
      predictedAqi: row.predictedAqi, predictedPm25: row.predictedPm25, predictedTemp: row.predictedTemperatureC,
      aqiAtIssue: nowAqi, tempAtIssue: nowTemp, pm25AtIssue: aqi.current.pollutants.pm25.value,
    });
  }
  appendJsonl(FORECAST_LOG(), out);
  return { logged: out.length };
}

export function addObservation({ city, time, temperature = null, pm25 = null, usAqi = null, source }) {
  if (!city || !time || !source) throw new Error('city, time (ISO) and source are required.');
  if (!Number.isFinite(asUtcMs(time))) throw new Error('time must be a valid ISO timestamp.');
  const row = { city, time: new Date(asUtcMs(time)).toISOString(), temperature, pm25, usAqi, source, addedAt: new Date().toISOString() };
  appendJsonl(OBS_LOG(), [row]);
  return row;
}

// Score stored forecasts + manual observations against the hourly series Open-Meteo just returned
// (past_days=8 gives the last 8 days of analysis values).
export function scoreCity(city, aqi) {
  const series = aqi.hourly || {};
  const index = new Map();
  (series.time || []).forEach((t, i) => index.set(hourKey(asUtcMs(t)), i));
  const nowMs = asUtcMs(aqi.current.time);

  const verified = [];
  for (const entry of readJsonl(FORECAST_LOG()).filter(r => r.city === city)) {
    const tMs = asUtcMs(entry.targetTime);
    if (tMs > nowMs) continue;
    const i = index.get(hourKey(tMs));
    if (i == null) continue;
    verified.push({ entry, obsAqi: series.usAqi?.[i], obsPm25: series.pm25?.[i], obsTemp: series.temperature?.[i] });
  }
  const byHorizon = {};
  for (const h of HORIZONS) {
    const rows = verified.filter(v => v.entry.horizon === h);
    byHorizon[h] = {
      usAqi: metrics(rows.filter(v => Number.isFinite(v.obsAqi)).map(v => ({ pred: v.entry.predictedAqi, obs: v.obsAqi, base: v.entry.aqiAtIssue }))),
      temperature: metrics(rows.filter(v => Number.isFinite(v.obsTemp) && Number.isFinite(v.entry.predictedTemp)).map(v => ({ pred: v.entry.predictedTemp, obs: v.obsTemp, base: v.entry.tempAtIssue }))),
    };
  }
  const total = readJsonl(FORECAST_LOG()).filter(r => r.city === city).length;

  // Independent observations vs Open-Meteo analysis for the same hour.
  const observations = readJsonl(OBS_LOG()).filter(o => o.city === city);
  const tempPairs = [], pmPairs = [];
  for (const o of observations) {
    const i = index.get(hourKey(asUtcMs(o.time)));
    if (i == null) continue;
    if (Number.isFinite(o.temperature) && Number.isFinite(series.temperature?.[i])) tempPairs.push({ pred: series.temperature[i], obs: o.temperature });
    if (Number.isFinite(o.pm25) && Number.isFinite(series.pm25?.[i])) pmPairs.push({ pred: series.pm25[i], obs: o.pm25 });
  }
  return {
    city,
    generatedAt: new Date().toISOString(),
    reference: 'Open-Meteo analysis value for the verified hour (modelled, not a ground-truth station)',
    forecastsLogged: total,
    forecastsVerified: verified.length,
    byHorizon,
    openMeteoVsObserved: {
      note: 'Open-Meteo hourly value compared with independent observations entered by the team (e.g. airport METAR, CPCB/OpenAQ monitor). Positive bias = Open-Meteo reads higher.',
      observationsStored: observations.length,
      temperatureC: metrics(tempPairs),
      pm25: metrics(pmPairs),
    },
    status: verified.length ? 'tracking' : 'collecting',
    statusNote: verified.length ? 'Live metrics computed from verified forecasts.' : 'No forecast has reached its target time yet. Metrics appear after +1 h / +6 h / +24 h have passed.',
  };
}

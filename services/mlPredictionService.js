/** Runs the trained Python AQI/weather models and manages background model training. */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getTrainingStatus, getIndianCityModelKey, queueIndianCityTraining, queueManualTraining } from '../agents/trainingAgent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ML_DIR = path.join(__dirname, '..', 'ml');
const PYTHON = process.env.PYTHON_EXECUTABLE || (process.platform === 'win32' ? 'py' : 'python3');
const PYTHON_ARGS = process.platform === 'win32' && !process.env.PYTHON_EXECUTABLE ? ['-3.14', '-X', 'utf8'] : [];
const cityKey = city => String(city).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const WEATHER_TARGETS = ['temperature_2m', 'relative_humidity_2m', 'wind_speed_10m', 'precipitation', 'cloud_cover', 'surface_pressure'];

// Report validation scores only when both the trained weather model artifact
// and its compatible chronological-holdout metadata are present.
export function getWeatherValidationMetrics(city, coordinates = null) {
  const key = getIndianCityModelKey(city, coordinates) || cityKey(city);
  const candidates = [...new Set([key, key.replace(/_in_\d+$/, '')])];
  const metrics = {};
  for (const target of WEATHER_TARGETS) {
    for (const candidate of candidates) {
      const modelPath = path.join(ML_DIR, 'models', `${candidate}_${target}_xgb.joblib`);
      const metadataPath = path.join(ML_DIR, 'models', `${candidate}_${target}_metadata.json`);
      try {
        if (fs.statSync(modelPath).size <= 0) continue;
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const score = metadata.aggregate_validation;
        const valid = metadata.model_version === 5 && metadata.target === target &&
          metadata.target_source === 'Open-Meteo Historical Weather API' &&
          Array.isArray(metadata.feature_names) && metadata.feature_names.length > 0 &&
          Number(metadata.test_pair_count) > 0 && Number(score?.n) > 0 &&
          ['mae', 'rmse', 'r2'].every(field => Number.isFinite(Number(score?.[field])));
        if (!valid) continue;
        metrics[target] = {
          mae: Number(score.mae), rmse: Number(score.rmse), r2: Number(score.r2),
          persistence_mae: Number.isFinite(Number(score.persistence_mae)) ? Number(score.persistence_mae) : null,
          n: Number(score.n), testPairCount: Number(metadata.test_pair_count),
          validationMethod: metadata.validation_method,
          trainedAt: metadata.trained_at,
        };
        break;
      } catch {}
    }
  }
  return metrics;
}

function pythonScript(script, args = [], { timeoutMs = 120000, input = null, onOutput = null } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [...PYTHON_ARGS, script, ...args], {
      cwd: ML_DIR,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Python process timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    proc.stdout.on('data', chunk => {
      const value = chunk.toString();
      stdout += value;
      onOutput?.('stdout', value);
    });
    proc.stderr.on('data', chunk => {
      const value = chunk.toString();
      stderr += value;
      onOutput?.('stderr', value);
    });
    proc.on('error', error => { clearTimeout(timer); reject(error); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `Python exited with status ${code}`));
    });
    if (input != null) proc.stdin.end(JSON.stringify(input));
    else proc.stdin.end();
  });
}

export async function runMLPrediction(aqi, city = 'Delhi', coordinates = null) {
  const series = aqi.hourly || {};
  const asUtcIso = value => {
    const text = String(value);
    return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  };
  const currentTime = asUtcIso(aqi.current.time || new Date().toISOString());
  const cutoff = new Date(currentTime).getTime();
  const history = (series.time || []).map((time, i) => ({
    time: asUtcIso(time),
    usAqi: series.usAqi?.[i],
    pm25: series.pm25?.[i],
  })).filter(row => new Date(row.time).getTime() <= cutoff).slice(-169);
  const weatherHistory = (series.time || []).map((time, i) => ({
    time: asUtcIso(time),
    temperature_2m: series.temperature?.[i],
    relative_humidity_2m: series.relativeHumidity?.[i],
    wind_speed_10m: series.windSpeed?.[i],
    precipitation: series.precipitation?.[i],
    cloud_cover: series.cloudCover?.[i],
    surface_pressure: series.surfacePressure?.[i],
  })).filter(row => new Date(row.time).getTime() <= cutoff).slice(-169);

  const m = aqi.current.meteorology;
  const payload = {
    city: getIndianCityModelKey(city, coordinates) || cityKey(city),
    currentTime,
    history,
    weatherHistory,
    weatherCurrent: {
      temperature_2m: m.surfaceTemperatureC,
      relative_humidity_2m: m.relativeHumidityPercent,
      wind_speed_10m: m.windSpeedMs,
      wind_direction_10m: m.windDirectionDeg,
      surface_pressure: m.surfacePressureHpa,
      precipitation: m.precipitationMm,
      cloud_cover: m.cloudCoverPercent,
      boundary_layer_height: m.boundaryLayerHeightMeters,
      shortwave_radiation: m.shortwaveRadiation,
    },
    hourlyWeatherForecast: (series.time || []).map((time, i) => ({
      time: asUtcIso(time),
      temperatureC: series.temperature?.[i] ?? null,
      humidityPercent: series.relativeHumidity?.[i] ?? null,
      windSpeedMs: series.windSpeed?.[i] ?? null,
      precipitationMm: series.precipitation?.[i] ?? null,
      precipitationProbability: series.precipProb?.[i] ?? null,
      cloudCoverPercent: series.cloudCover?.[i] ?? null,
      surfacePressureHpa: series.surfacePressure?.[i] ?? null,
      weatherCode: series.weatherCode?.[i] ?? null,
    })).filter(row => new Date(row.time).getTime() > cutoff),
    dailyWeather: aqi.dailyWeather || [],
  };

  try {
    const output = await pythonScript(path.join(ML_DIR, 'predict.py'), [], { input: payload, timeoutMs: 120000 });
    const result = JSON.parse(output.trim());
    if (result.error) {
      console.warn(`[ML] ${result.error}`);
      return { modelStatus: 'unavailable', error: result.error };
    }
    return result;
  } catch (error) {
    console.warn('[ML] Prediction unavailable:', error.message);
    return { modelStatus: 'unavailable', error: `ML prediction failed: ${error.message}` };
  }
}

export function isCityModelReady(city) {
  return getTrainingStatus(city).isTrained;
}
export function triggerTraining(city = 'Delhi', coordinates = null) {
  return queueManualTraining(city, coordinates);
}

// Called automatically after a city has been analysed. Existing trained models
// are reused; a missing city model is queued once, without blocking the API.
export function ensureCityTraining(city, coordinates = null) {
  return queueIndianCityTraining(city, coordinates);
}

export { getTrainingStatus };

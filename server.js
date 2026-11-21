// Express API Server for Air Quality and Weather Platform
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import { geocodeLocation, searchLocations, listPopularCities } from './services/cityLocator.js';
import { runAnalysisPipeline } from './services/analysisService.js';
import { getOllamaStatus, generateAssistantResponse } from './services/ollamaService.js';
import { addObservation } from './services/evaluationService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Cache for recent pipeline runs to keep latency low
const analysisCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// 1. Search cities
app.get('/api/locations/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q.trim()) return res.json({ results: listPopularCities() });
    res.json({ results: await searchLocations(q, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Current location by coordinates
app.get('/api/locations/current', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: 'Valid latitude and longitude required' });
  }

  res.json({
    location: { city: 'My Location', name: 'My Location', lat, lon },
    coordinates: { lat, lon }
  });
});

// 3. AQI and weather analysis
app.get('/api/analysis', async (req, res) => {
  try {
    let { city, lat, lon, name, country, searchMode, population, featureCode } = req.query;
    let targetLocation = null;
    let targetCoords = null;

    if (name && lat != null && lon != null) {
      targetCoords = { lat: parseFloat(lat), lon: parseFloat(lon) };
      if (!Number.isFinite(targetCoords.lat) || !Number.isFinite(targetCoords.lon)) {
        return res.status(400).json({ error: 'Valid latitude and longitude required.' });
      }
      targetLocation = {
        city: String(name), name: String(name), country: String(country || ''), ...targetCoords,
        searchMode: ['citywide', 'hyperlocal'].includes(searchMode) ? searchMode : undefined,
        population: population == null ? null : Number(population),
        featureCode: featureCode || '',
      };
    } else if (city) {
      targetLocation = await geocodeLocation(city);
      if (['citywide', 'hyperlocal'].includes(searchMode)) targetLocation.searchMode = searchMode;
      targetCoords = { lat: targetLocation.lat, lon: targetLocation.lon };
    }

    if (!targetLocation && lat && lon) {
      targetCoords = { lat: parseFloat(lat), lon: parseFloat(lon) };
      if (!Number.isFinite(targetCoords.lat) || !Number.isFinite(targetCoords.lon)) {
        return res.status(400).json({ error: 'Valid latitude and longitude required.' });
      }
      targetLocation = {
        city: 'My Location', name: 'My Location',
        searchMode: ['citywide', 'hyperlocal'].includes(searchMode) ? searchMode : 'hyperlocal',
        isCurrentLocation: searchMode !== 'citywide', ...targetCoords,
      };
    }

    if (!targetLocation) {
      targetLocation = await geocodeLocation('Delhi');
      targetCoords = { lat: targetLocation.lat, lon: targetLocation.lon };
    }

    if (!targetCoords) {
      targetCoords = { lat: targetLocation.lat, lon: targetLocation.lon };
    }

    // Check cache
    const cacheKey = `${targetLocation.city}_${targetLocation.searchMode || searchMode || ''}_${Math.round(targetCoords.lat * 100)}_${Math.round(targetCoords.lon * 100)}`;
    const cached = analysisCache.get(cacheKey);
    const now = Date.now();

    const cachedLiveAqi = cached?.data?.chemistryData?.current?.liveAqi;
    const cachedAgeMinutes = cached ? (now - cached.timestamp) / 60000 : Infinity;
    const cpcbCacheStillFresh = cachedLiveAqi?.selectedSource === 'open_meteo' || Boolean(
      cachedLiveAqi?.dataFreshness?.isFresh &&
      (cachedLiveAqi.dataFreshness.oldestAgeMinutes ?? cachedLiveAqi.dataFreshness.nearestAgeMinutes ?? Infinity) + cachedAgeMinutes <=
        (cachedLiveAqi.dataFreshness.thresholdMinutes || 180)
    );
    if (cached && (now - cached.timestamp < CACHE_TTL_MS) && cpcbCacheStillFresh && !req.query.force) {
      return res.json({ ...cached.data, fromCache: true });
    }

    // Run the AQI and weather analysis
    const result = await runAnalysisPipeline(targetLocation, targetCoords);

    // City-specific training is intentionally opt-in via POST /api/ml/train.
    // New locations use the live Open-Meteo provider forecast without background training.

    // Save to cache
    analysisCache.set(cacheKey, { timestamp: now, data: result });

    res.json(result);
  } catch (err) {
    console.error('Analysis pipeline error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3b. Independent observation (e.g. airport METAR / CPCB monitor) so Open-Meteo can be verified
app.post('/api/evaluation/observation', (req, res) => {
  try {
    const { city, time, temperature, pm25, usAqi, source } = req.body || {};
    const num = v => (v === '' || v == null ? null : Number(v));
    res.json({ saved: addObservation({ city, time, temperature: num(temperature), pm25: num(pm25), usAqi: num(usAqi), source }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 4. AQI and Weather Assistant Endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { prompt, history, context, requestedModel } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const response = await generateAssistantResponse({
      prompt,
      conversationHistory: history || [],
      currentLocationContext: context || null,
      requestedModel
    });

    res.json(response);
  } catch (err) {
    console.error('Chat assistant error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 5. Ollama Status & Available Models
app.get('/api/ollama/status', async (req, res) => {
  try {
    const status = await getOllamaStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ONLINE',
    version: '1.0.0',
    service: 'Air Quality and Weather Platform',
    timestamp: new Date().toISOString()
  });
});

// 7. ML Model Training Status & Trigger
import { triggerTraining, getTrainingStatus } from './services/mlPredictionService.js';
import { getIndiaTrainingStatus, resumeIndiaTrainingIfNeeded, startIndiaTraining } from './services/indiaTrainingService.js';

app.get('/api/ml/status', (req, res) => {
  try {
    const city = (req.query.city || 'Delhi').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
    const state = getTrainingStatus(city);
    const modelReady = state.isTrained;
    const progress = state.progress;
    res.json({
      city,
      isTrained: modelReady,
      isTraining: state.isTraining,
      trainingFailed: Boolean(progress?.phase?.includes?.('failed')),
      progress: progress || (modelReady ? { percent: 100, phase: 'complete', detail: 'Both target models and metadata are valid.' } : { percent: 0, phase: 'idle', detail: 'One or both target models are missing or incompatible.' }),
      targets: state.targets,
      metadata: { us_aqi: state.targets.us_aqi.metadata, pm2_5: state.targets.pm2_5.metadata }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// India-only resumable bulk-training status and background start control.
app.get('/api/ml/india-training/status', (req, res) => {
  try { res.json(getIndiaTrainingStatus()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ml/india-training/start', async (req, res) => {
  try {
    const result = await startIndiaTraining();
    res.status(result.alreadyRunning ? 200 : 202).json(result);
  } catch (err) {
    console.error('[ML] Could not start India training queue:', err);
    res.status(500).json({ error: err.message, status: getIndiaTrainingStatus() });
  }
});


app.post('/api/ml/train', (req, res) => {
  try {
    const city = (req.body.city || 'Delhi').trim();
    if (!/^[\p{L} .'-]+$/u.test(city)) return res.status(400).json({ error: 'Invalid city name.' });
    const lat = Number(req.body.lat);
    const lon = Number(req.body.lon);
    const coordinates = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    try {
      triggerTraining(city, coordinates);
    } catch (error) {
      return res.status(409).json({ error: error.message });
    }
    res.json({ success: true, message: `Training triggered in background for ${city}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`ðŸš€ Air Quality and Weather Platform Server Running on:`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   AQI and weather data: Open-Meteo`);
  console.log(`====================================================`);
  void resumeIndiaTrainingIfNeeded().then(result => {
    if (result.started) console.log(`[ML] Resumed India training queue in worker ${result.pid}.`);
  }).catch(error => console.error('[ML] Could not resume India training queue:', error.message));
});

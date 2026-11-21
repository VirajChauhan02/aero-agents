// ==========================================================================
// AirQuality Research Platform - Core Client Application Controller
// Orchestrates API telemetry, Chart.js multi-horizon rendering, data pipeline,
// Ollama AI assistant dialogue, and automated academic PDF dossier compilation.
// ==========================================================================

let currentTelemetry = null;
let currentLocation = { city: 'Delhi', name: 'Delhi', lat: 28.6139, lon: 77.2090 };
let chartInstances = {};
let conversationHistory = [];
let activeTrajectoryMode = 'aqi'; // 'aqi' or 'pm25'
let showConfidenceBand = true;
let searchDebounceTimer = null;
let searchRequestId = 0;

document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  checkOllamaStatus();
  updateChatSuggestions(currentLocation, null);
  // Load the default city.
  loadAnalysisData({ city: 'Delhi' });
});

// ==========================================================================
// Event Listeners & UI Binding
// ==========================================================================
function initEventListeners() {
  // Theme toggle
  document.getElementById('btnThemeToggle').addEventListener('click', toggleTheme);

  // Search input & button
  const searchInput = document.getElementById('citySearchInput');
  const btnSearch = document.getElementById('btnSearch');
  const btnClear = document.getElementById('btnClearSearch');

  btnSearch.addEventListener('click', () => {
    const q = searchInput.value.trim();
    if (q) performSearch(q);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = searchInput.value.trim();
      if (q) performSearch(q);
    }
  });

  searchInput.addEventListener('input', () => {
    btnClear.style.display = searchInput.value ? 'block' : 'none';
    clearTimeout(searchDebounceTimer);
    const query = searchInput.value.trim();
    if (query.length < 3) {
      hideLocationSuggestions();
      return;
    }
    searchDebounceTimer = setTimeout(() => loadLocationSuggestions(query), 280);
  });

  btnClear.addEventListener('click', () => {
    searchInput.value = '';
    btnClear.style.display = 'none';
    hideLocationSuggestions();
  });

  // Quick Preset City Buttons
  document.querySelectorAll('.hub-pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      document.querySelectorAll('.hub-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const city = pill.getAttribute('data-city');
      loadAnalysisData({ city, searchMode: 'citywide' });
    });
  });

  // Geolocation button
  document.getElementById('btnGeoLocation').addEventListener('click', detectUserLocation);

  // Refresh button
  document.getElementById('btnRefresh').addEventListener('click', () => {
    if (currentLocation) {
      loadAnalysisData({
        name: currentLocation.city, lat: currentLocation.lat, lon: currentLocation.lon,
        country: currentLocation.country, searchMode: currentLocation.searchMode || 'citywide',
        population: currentLocation.population, featureCode: currentLocation.featureCode,
      }, true);
    }
  });

  // Research Tabs Switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetPane = document.getElementById(btn.getAttribute('data-tab'));
      if (targetPane) targetPane.classList.add('active');

      // Trigger chart resize on tab switch
      setTimeout(() => {
        Object.values(chartInstances).forEach(chart => {
          if (chart && typeof chart.resize === 'function') chart.resize();
        });
      }, 50);
    });
  });

  // 72h Forecast Chart Toggles
  document.getElementById('toggleAqiTrajectory').addEventListener('click', () => {
    activeTrajectoryMode = 'aqi';
    document.getElementById('toggleAqiTrajectory').classList.add('active');
    document.getElementById('togglePm25Trajectory').classList.remove('active');
    renderPredictionChart();
  });

  document.getElementById('togglePm25Trajectory').addEventListener('click', () => {
    activeTrajectoryMode = 'pm25';
    document.getElementById('togglePm25Trajectory').classList.add('active');
    document.getElementById('toggleAqiTrajectory').classList.remove('active');
    renderPredictionChart();
  });

  document.getElementById('toggleConfidenceBand').addEventListener('click', () => {
    showConfidenceBand = !showConfidenceBand;
    document.getElementById('toggleConfidenceBand').classList.toggle('active', showConfidenceBand);
    renderPredictionChart();
  });

  // Chatbot Dock Controls
  const chatDock = document.getElementById('chatDock');
  const chatFloatingBtn = document.getElementById('chatFloatingBtn');
  const btnChatMinimize = document.getElementById('btnChatMinimize');

  btnChatMinimize.addEventListener('click', () => {
    chatDock.classList.add('minimized');
    chatFloatingBtn.style.display = 'flex';
  });

  chatFloatingBtn.addEventListener('click', () => {
    chatDock.classList.remove('minimized');
    chatFloatingBtn.style.display = 'none';
    document.getElementById('chatInput').focus();
  });

  // Chat Form Submit
  document.getElementById('chatInputForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chatInput');
    const msg = input.value.trim();
    if (msg) {
      sendChatMessage(msg);
      input.value = '';
    }
  });

  // City-specific assistant suggestions (delegated so they can be refreshed).
  document.getElementById('chatSuggestions').addEventListener('click', event => {
    const chip = event.target.closest('.chip-btn');
    if (chip?.dataset.query) sendChatMessage(chip.dataset.query);
  });

  // Copy Abstract Button
  document.getElementById('btnCopyAbstract').addEventListener('click', () => {
    if (currentTelemetry && currentTelemetry.researchAbstract) {
      const abs = currentTelemetry.researchAbstract;
      const text = `${abs.title}\n\nAuthors: ${abs.authors.join(', ')}\n\nAbstract:\n${abs.abstractText}\n\nKeywords: ${abs.keywords.join(', ')}`;
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('btnCopyAbstract');
        btn.textContent = '✅ Copied to Clipboard';
        setTimeout(() => { btn.textContent = '📋 Copy Abstract'; }, 2000);
      });
    }
  });

  // PDF Dossier Export
  document.getElementById('btnExportPdf').addEventListener('click', exportResearchDossierPdf);

  // Train ML Model Button with Live Progress Polling
  const btnTrain = document.getElementById('btnTrainModel');
  if (btnTrain) {
    let pollingInterval = null;
    let trainingRequested = false;

    const pollTrainingProgress = (city) => {
      if (pollingInterval) clearInterval(pollingInterval);
      pollingInterval = setInterval(async () => {
        try {
          const res = await fetch(`/api/ml/status?city=${encodeURIComponent(city)}`);
          const data = await res.json();
          if (data.trainingFailed) {
            btnTrain.innerHTML = data.isTrained ? `<span>⚠</span> ${city} retrain failed` : '<span>⚠</span> Training failed';
            btnTrain.title = data.progress?.detail || 'Training failed';
            btnTrain.disabled = false;
            clearInterval(pollingInterval);
            pollingInterval = null;
            trainingRequested = false;
            return;
          }
          if (data.isTrained) {
            btnTrain.innerHTML = `<span>✅</span> ${city} ML Ready`;
            btnTrain.disabled = false;
            clearInterval(pollingInterval);
            pollingInterval = null;
            if (trainingRequested) {
              trainingRequested = false;
              loadAnalysisData({ lat: currentTelemetry?.meta?.coordinates?.lat, lon: currentTelemetry?.meta?.coordinates?.lon }, true);
            }
            setTimeout(() => {
              btnTrain.innerHTML = '<span>🧠</span> Train ML Model';
            }, 6000);
            return;
          }
          if (data.progress && data.progress.percent > 0) {
            btnTrain.innerHTML = `<span>⏳</span> ${data.progress.percent}% (${data.progress.phase})`;
            btnTrain.title = data.progress.detail || '';
          }
        } catch (_) {}
      }, 3000);
    };

    btnTrain.addEventListener('click', async () => {
      const city = currentLocation ? currentLocation.city : 'Delhi';
      if (!confirm(`Refresh Open-Meteo historical data and train AQI and PM2.5 XGBoost models for ${city}?\n\nThis runs in the background on the server.`)) return;
      btnTrain.disabled = true;
      trainingRequested = true;
      btnTrain.innerHTML = '<span>⏳</span> Starting...';
      try {
        const res = await fetch('/api/ml/train', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ city, lat: currentTelemetry?.meta?.coordinates?.lat, lon: currentTelemetry?.meta?.coordinates?.lon })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Training request was rejected.');
        pollTrainingProgress(city);
      } catch (err) {
        alert('Could not start training: ' + err.message);
        btnTrain.disabled = false;
        trainingRequested = false;
        btnTrain.innerHTML = '<span>🧠</span> Train ML Model';
      }
    });

    // Initial check on load and city change
    window.checkCurrentCityML = () => {
      const city = currentLocation ? currentLocation.city : 'Delhi';
      pollTrainingProgress(city);
    };
    setTimeout(window.checkCurrentCityML, 1500);
  }
}



// ==========================================================================
// Theme Management
// ==========================================================================
function toggleTheme() {
  const isLight = document.body.classList.toggle('theme-light');
  document.body.classList.toggle('theme-dark', !isLight);
  document.getElementById('themeIcon').textContent = isLight ? '🌙' : '☀️';
  // Redraw charts with adapted themes
  renderAllCharts();
}

// ==========================================================================
// Data Fetching & Pipeline Execution
// ==========================================================================
async function loadAnalysisData(params = {}, force = false) {
  showLoading(true, 'Loading AQI and weather...', 'Fetching city-level data from Open-Meteo...');
  hideError();

  try {
    let url = '/api/analysis?';
    if (params.city) url += `city=${encodeURIComponent(params.city)}&`;
    if (params.lat != null && params.lon != null) url += `lat=${params.lat}&lon=${params.lon}&`;
    if (params.name) url += `name=${encodeURIComponent(params.name)}&`;
    if (params.country) url += `country=${encodeURIComponent(params.country)}&`;
    if (params.searchMode) url += `searchMode=${encodeURIComponent(params.searchMode)}&`;
    if (params.population != null) url += `population=${encodeURIComponent(params.population)}&`;
    if (params.featureCode) url += `featureCode=${encodeURIComponent(params.featureCode)}&`;
    if (force) url += 'force=true';

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Analysis Pipeline HTTP ${res.status}`);
    const data = await res.json();

    currentTelemetry = data;
    const previousCity = currentLocation?.city;
    if (previousCity && previousCity !== data.meta.location.city) {
      conversationHistory = [];
      document.querySelectorAll('#chatMessagesContainer .chat-msg:not(.system)').forEach(message => message.remove());
    }
    currentLocation = data.meta.location;
    updateChatSuggestions(currentLocation, data.predictionsData);

    updateHeroRibbon(data);
    updateChemicalViews(data);
    updateModelAndValidation(data);
    updateHealthAndOperations(data);
    renderAgentPanels(data);
    renderAllCharts();
    if (window.checkCurrentCityML) window.checkCurrentCityML();

  } catch (err) {
    console.error('Data loading error:', err);
    showError(`Failed to load AQI and weather data: ${err.message}`);
  } finally {
    showLoading(false);
  }
}

async function loadLocationSuggestions(query) {
  const requestId = ++searchRequestId;
  const box = document.getElementById('searchSuggestions');
  try {
    const response = await fetch(`/api/locations/search?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    if (requestId !== searchRequestId || document.getElementById('citySearchInput').value.trim() !== query) return;
    box.replaceChildren();
    (data.results || []).slice(0, 10).forEach(result => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'suggestion-item';
      const label = document.createElement('span');
      label.className = 'suggestion-label';
      label.textContent = result.city;
      const detail = document.createElement('small');
      detail.textContent = result.fullName || result.country || 'India';
      option.append(label, detail);
      option.addEventListener('click', () => chooseLocationResult(result));
      box.appendChild(option);
    });
    box.style.display = box.childElementCount ? 'block' : 'none';
  } catch (_) {
    if (requestId === searchRequestId) hideLocationSuggestions();
  }
}

function hideLocationSuggestions() {
  const box = document.getElementById('searchSuggestions');
  if (box) { box.style.display = 'none'; box.replaceChildren(); }
}

function chooseLocationResult(result) {
  hideLocationSuggestions();
  const input = document.getElementById('citySearchInput');
  input.value = result.fullName || result.city;
  loadAnalysisData({
    name: result.city, lat: result.lat, lon: result.lon, country: result.country,
    searchMode: result.searchMode, population: result.population, featureCode: result.featureCode,
  }, true);
}

async function performSearch(query) {
  const q = query.trim();
  try {
    const response = await fetch(`/api/locations/search?q=${encodeURIComponent(q)}`);
    const data = await response.json();
    if (!response.ok || !data.results?.length) throw new Error(data.error || `No places found for ${q}.`);
    chooseLocationResult(data.results[0]);
  } catch (error) {
    showError(error.message);
  }
}

function detectUserLocation() {
  if (!navigator.geolocation) {
    showError('Geolocation is not supported by your browser.');
    return;
  }

  showLoading(true, 'Getting Your Location...', 'Loading AQI and weather for your coordinates...');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      loadAnalysisData({ lat, lon, searchMode: 'hyperlocal' });
    },
    (err) => {
      showLoading(false);
      showError(`Unable to retrieve GPS coordinates: ${err.message}`);
    }
  );
}

// Check Ollama Service
async function checkOllamaStatus() {
  try {
    const res = await fetch('/api/ollama/status');
    const data = await res.json();
    const badge = document.getElementById('chatEngineBadge');
    if (data.available && data.models.length > 0) {
      badge.textContent = `Ollama (${data.activeModel})`;
      badge.style.borderColor = 'rgba(16, 185, 129, 0.4)';
      badge.style.color = '#10b981';
    } else {
      badge.textContent = 'Scientific Engine (Active)';
      badge.style.borderColor = 'rgba(6, 182, 212, 0.4)';
      badge.style.color = '#06b6d4';
    }
  } catch (_) {}
}

// ==========================================================================
// UI View Updaters
// ==========================================================================
function updateHeroRibbon(data) {
  const location = data.meta.location;
  const current = data.chemistryData.current;
  const weather = current.meteorology;
  const safeSet = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  const safeClass = (id, className) => { const el = document.getElementById(id); if (el) el.className = className; };

  safeSet('activeCityName', location.city);
  safeSet('activeRegionName', [location.state, location.country].filter(Boolean).join(', ') || 'Selected city');
  safeSet('badgeWeatherCondition', weather.weatherCondition || 'Weather');
  safeSet('valTemp', weather.surfaceTemperatureC ?? '?');
  safeSet('valWindMs', weather.windSpeedMs ?? '?');
  safeSet('valHumidity', weather.relativeHumidityPercent ?? '?');
  safeSet('valWeatherCondition', weather.weatherCondition || 'Unavailable');
  safeSet('valPressure', weather.surfacePressureHpa ?? '?');
  safeSet('valCloudCover', weather.cloudCoverPercent ?? '?');
  safeSet('valWeatherSourceStatus', 'Open-Meteo current weather');

  const isIndia = /india/i.test(location.country || location.countryName || '');
  const liveAqi = current.liveAqi || {
    selectedSource: isIndia ? 'open_meteo' : 'open_meteo', searchMode: 'citywide',
    headlineAqi: isIndia ? (current.providerUsAqi ?? current.usAqi) : current.usAqi,
    category: isIndia ? current.category : current.category, selectedStations: [],
    fallbackAqi: current.providerUsAqi ?? current.usAqi,
  };
  const cpcbSelected = isIndia && liveAqi.selectedSource !== 'open_meteo' && Number.isFinite(liveAqi.headlineAqi);
  const formatIndex = value => Number.isFinite(Number(value)) ? (Number.isInteger(Number(value)) ? String(Number(value)) : Number(value).toFixed(1)) : 'Unavailable';
  const formatDistance = value => Number.isFinite(Number(value)) ? Number(value).toFixed(1) : '?';
  const primaryAqi = liveAqi.headlineAqi;
  const primaryCategory = liveAqi.category;
  safeSet('valUsAqi', primaryAqi ?? '—');
  safeSet('badgeAqiCategory', primaryCategory?.label || 'Unavailable');
  safeClass('badgeAqiCategory', `badge-aqi aqi-${primaryCategory?.code || 'unavailable'}`);
  safeClass('valUsAqi', `aqi-big-number ${cpcbSelected ? `aqi-value-${primaryCategory?.code || 'unavailable'}` : ''}`.trim());
  const nearest = liveAqi.nearestStation;
  const nearbyMedian = liveAqi.regionalMedianAqi;
  const stationCount = liveAqi.regionalMedianStationCount || liveAqi.stationCount || 0;
  const subtitle = !isIndia
    ? 'Open-Meteo Model AQI · US Standard PM estimate'
    : liveAqi.selectedSource === 'cpcb_station_median'
      ? `CPCB Nearby-Station Median • ${liveAqi.regionalMedianStationCount || stationCount} stations`
      : cpcbSelected && nearest
        ? (liveAqi.searchMode === 'citywide'
          ? `CPCB Single-Station Reading • ${nearest.station} (${formatDistance(nearest.distanceKm)} km)`
          : `CPCB Live • ${liveAqi.selectedStation?.station || nearest.station} (${formatDistance(liveAqi.selectedStation?.distanceKm ?? nearest.distanceKm)} km)`)
        : 'Open-Meteo Model AQI';
  safeSet('aqiPrimaryScale', subtitle);
  const displayedStation = liveAqi.selectedStation || nearest;
  safeSet('aqiStationMeta', cpcbSelected && displayedStation
    ? `${displayedStation.agency ? `Agency: ${displayedStation.agency} · ` : ''}Updated: ${displayedStation.observedAt || 'time unavailable'}`
    : '');
  const secondaryWrap = document.getElementById('aqiSecondaryLabel')?.parentElement;
  if (secondaryWrap) secondaryWrap.style.display = cpcbSelected || !isIndia ? '' : 'none';
  if (cpcbSelected && liveAqi.selectedSource === 'cpcb_station_median') {
    safeSet('aqiSecondaryLabel', liveAqi.searchMode === 'hyperlocal' ? 'Nearby-station median:' : 'Nearest:');
    safeSet('valIndiaAqi', liveAqi.searchMode === 'hyperlocal'
      ? `${formatIndex(liveAqi.regionalMedianAqi)} (${liveAqi.regionalMedianStationCount} stations)`
      : `${nearest?.station || 'station unavailable'} (${formatDistance(nearest?.distanceKm)} km)`);
  } else if (cpcbSelected && liveAqi.searchMode === 'hyperlocal' && nearbyMedian != null) {
    safeSet('aqiSecondaryLabel', 'Nearby-station median:');
    safeSet('valIndiaAqi', `${formatIndex(nearbyMedian)} (${liveAqi.regionalMedianStationCount} stations)`);
  } else if (cpcbSelected && liveAqi.searchMode === 'citywide' && nearest) {
    safeSet('aqiSecondaryLabel', 'Nearest:');
    safeSet('valIndiaAqi', `${nearest.station} (${formatDistance(nearest.distanceKm)} km)`);
  } else if (cpcbSelected) {
    safeSet('aqiSecondaryLabel', 'Station:');
    safeSet('valIndiaAqi', liveAqi.selectedStation?.station || nearest?.station || 'Unavailable');
  } else if (!isIndia) {
    safeSet('aqiSecondaryLabel', 'India estimate (India only):');
    safeSet('valIndiaAqi', 'Not applicable');
  }
  const primaryPollutant = isIndia ? current.indiaPrimaryPollutant : current.primaryPollutant;
  const pollutantNames = { 'PM2.5': 'PM2.5', PM10: 'PM10', CO: 'CO', NO2: 'NO₂', OZONE: 'O₃', SO2: 'SO₂', NH3: 'NH₃', PB: 'Pb' };
  const cpcbIndices = Object.entries(liveAqi.dominantPollutantSubIndices || current.indiaCpcbSubIndices || {})
    .filter(([name, value]) => pollutantNames[name.toUpperCase()] && Number.isFinite(value) && value >= 0 && value <= 500)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, value]) => `${pollutantNames[name.toUpperCase()]} (${formatIndex(value)})`);
  safeSet('aqiScaleNote', cpcbSelected
    ? `${liveAqi.selectedSource === 'cpcb_station_median' ? 'Nearby station median sub-indices' : 'Dominant'}: ${cpcbIndices.length ? cpcbIndices.join(' • ') : 'Pollutant sub-index data unavailable'}\nOpen-Meteo Model AQI: ${liveAqi.fallbackAqi ?? 'Unavailable'}`
    : isIndia
      ? 'CPCB station unavailable or stale. Displaying the Open-Meteo Model AQI and modeled pollutant data.'
      : `Open-Meteo modeled PM concentrations with EPA particulate breakpoints; not station readings.${current.usAqiCappedAt500 ? ' PM2.5 AQI capped at 500.' : ''} Main pollutant: ${primaryPollutant || 'Unavailable'}`);
  safeSet('valPrimaryPollutant', primaryPollutant || 'Unavailable');

  const details = document.getElementById('stationDetailsDisclosure');
  const detailsList = document.getElementById('stationDetailsList');
  if (details && detailsList) {
    const stations = liveAqi.selectedStations || [];
    details.hidden = !isIndia || !stations.length;
    detailsList.replaceChildren();
    stations.forEach(station => {
      const row = document.createElement('div');
      row.className = 'station-reading-row';
      const title = document.createElement('strong');
      title.textContent = `${station.station} · ${station.agency || 'Agency unavailable'}`;
      const reading = document.createElement('span');
      reading.textContent = `AQI ${formatIndex(station.aqi)} · ${formatDistance(station.distanceKm)} km · ${station.observedAt}`;
      const indices = Object.entries(station.pollutantSubIndices || {}).filter(([, value]) => Number.isFinite(value)).map(([name, value]) => `${name} sub-index ${formatIndex(value)}`).join(' · ');
      const pollutants = document.createElement('small');
      pollutants.textContent = indices || 'Pollutant sub-indices unavailable; CPCB feed does not expose concentration values.';
      row.append(title, reading, pollutants);
      if (station.qualityFlags?.length) {
        const flag = document.createElement('small');
        flag.className = 'station-quality-flag';
        flag.textContent = station.qualityFlags.join(' ');
        row.append(flag);
      }
      detailsList.append(row);
    });
  }

  const pm25 = current.pollutants.pm25;
  safeSet('valPm25Conc', pm25.value ?? '?');
  safeSet('badgeWhoExceed', pm25.ratio == null ? '?' : `${pm25.ratio}x WHO guideline`);
  safeSet('valPm10Conc', `${current.pollutants.pm10.value ?? '?'} ug/m3`);
  safeSet('valNo2Conc', `${current.pollutants.no2.value ?? '?'} ug/m3`);
  safeSet('valAod', current.pollutants.aod.value ?? 'Unavailable');
  safeSet('pollutantDataSourceNote', cpcbSelected
    ? 'CPCB feed supplies AQI sub-indices only; concentrations shown are Open-Meteo modeled values.'
    : 'Open-Meteo modeled concentrations · not station measurements');
}

function updateChemicalViews(data) {
  const chem = data.chemistryData.current;
  const tbody = document.getElementById('chemicalTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const specs = [
    { name: 'Fine Particulate Matter', formula: 'PM2.5', key: 'pm25', toxicity: 'Penetrates deep alveoli and enters capillary bloodstream' },
    { name: 'Coarse Particulate Matter', formula: 'PM10', key: 'pm10', toxicity: 'Upper bronchial deposition, tracheobronchial irritation' },
    { name: 'Nitrogen Dioxide', formula: 'NO₂', key: 'no2', toxicity: 'Airway hyperresponsiveness, secondary nitrate aerosol precursor' },
    { name: 'Ground-Level Ozone', formula: 'O₃', key: 'o3', toxicity: 'Potent oxidant, induces chest tightness and reduces FEV1' },
    { name: 'Sulphur Dioxide', formula: 'SO₂', key: 'so2', toxicity: 'Bronchoconstriction in asthmatics, acid rain precursor' },
    { name: 'Carbon Monoxide', formula: 'CO', key: 'co', toxicity: 'Carboxyhemoglobin formation, reduces tissue oxygen delivery' }
  ];

  specs.forEach(s => {
    const pol = chem.pollutants[s.key];
    if (!pol) return;
    const row = document.createElement('tr');
    const isPrimary = chem.primaryPollutant.toUpperCase().includes(s.formula.toUpperCase());
    row.innerHTML = `
      <td><strong>${s.name}</strong> ${isPrimary ? '<span class="badge-research">PRIMARY</span>' : ''}</td>
      <td><code>${s.formula}</code></td>
      <td><strong>${pol.value}</strong> ${pol.unit}</td>
      <td>${pol.whoLimit} ${pol.unit}</td>
      <td><span class="${pol.ratio > 1 ? 'text-danger' : 'text-success'}"><strong>${pol.ratio}x</strong></span></td>
      <td>${pol.subIndex || '—'}</td>
      <td style="font-size: 0.8rem; color: var(--text-muted);">${s.toxicity}</td>
    `;
    tbody.appendChild(row);
  });
}

function updateModelAndValidation(data) {
  const pred = data.predictionsData;
  const metrics = pred.modelValidationMetrics || {};
  const abs = data.researchAbstract;
  const safeSet = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };

  const trained = pred.modelStatus === 'ready';
  const apiForecast = pred.modelStatus === 'api_fallback';
  const forecastAvailable = trained || apiForecast;
  safeSet('valModelR2', trained ? metrics.rSquaredScore : '—');
  safeSet('valModelRmse', trained ? metrics.rmse + ' AQI' : '—');
  safeSet('valModelMae', trained ? metrics.mae + ' AQI' : '?');
  safeSet('valModelDirAcc', trained ? metrics.directionAccuracyPercent + '%' : '—');
  safeSet('valModelArch', trained ? metrics.architecture : apiForecast ? 'Open-Meteo API' : 'Model not trained');
  safeSet('valModelMethod', trained ? metrics.validationNote : apiForecast ? 'Provider forecast; not ML validation' : 'No forecast available');
  safeSet('valModelStatus', trained ? 'ML Ready' : apiForecast ? 'API Forecast' : 'Unavailable');
  safeSet('badgeModelStatus', trained ? 'ML Ready' : apiForecast ? 'API' : 'No model');
  safeSet('forecastSourceBadge', trained ? 'XGBOOST ML' : apiForecast ? 'OPEN-METEO API' : 'NO AQI FORECAST');
  const weatherDays = pred.forecastCoverage?.weatherDays ?? (pred.dailySummary || []).length;
  const aqiDays = pred.forecastCoverage?.aqiDays ?? (pred.dailySummary || []).filter(day => day.avgAqi != null).length;
  safeSet('forecastCoverageBadge', `${weatherDays}-DAY WEATHER · ${aqiDays}-DAY AQI`);
  safeSet('forecastChartSubtitle', trained ? '168-hour city-specific ML forecast; confidence intervals from held-out residuals' : apiForecast ? `${pred.hourlyTrajectory?.length || 0} hourly AQI values supplied by Open-Meteo; no local ML confidence interval` : 'AQI forecast unavailable for this location');
  safeSet('valModelStatusDetail', trained ? 'Validated model for ' + pred.city : apiForecast ? 'AQI forecast supplied by Open-Meteo for ' + pred.city : (pred.error || 'No AQI forecast available'));
  safeSet('forecastSourceDescription', trained
    ? 'US AQI scale · XGBoost prediction trained against Open-Meteo Air Quality history.'
    : apiForecast
      ? 'US AQI scale · Open-Meteo Air Quality API forecast; not an XGBoost prediction.'
      : 'US AQI scale · AQI forecast unavailable for this location.');
  safeSet('modelCityVal', forecastAvailable ? pred.city : '—');
  safeSet('modelTrainRowsVal', trained ? Number(metrics.trainPairCount).toLocaleString() : '—');
  safeSet('modelTestRowsVal', trained ? Number(metrics.testPairCount).toLocaleString() : '—');
  safeSet('modelPersistenceMaeVal', trained ? metrics.persistenceMae + ' AQI' : '—');
  safeSet('modelTrainedAtVal', trained && metrics.trainedAt ? new Date(metrics.trainedAt).toLocaleString() : '—');
  const horizonContainer = document.getElementById('modelHorizonMetrics');
  if (horizonContainer) {
    horizonContainer.innerHTML = '';
    if (trained && metrics.horizonMetrics) {
      const table = document.createElement('table');
      table.className = 'model-horizon-table';
      table.innerHTML = '<thead><tr><th>Hours</th><th>MAE</th><th>RMSE</th><th>R²</th></tr></thead>';
      const body = document.createElement('tbody');
      Object.entries(metrics.horizonMetrics).forEach(([horizon, value]) => {
        const row = document.createElement('tr');
        [horizon, value.mae, value.rmse, value.r2].forEach(cell => {
          const td = document.createElement('td');
          td.textContent = String(cell ?? '—');
          row.appendChild(td);
        });
        body.appendChild(row);
      });
      table.appendChild(body);
      horizonContainer.appendChild(table);
    } else {
      horizonContainer.textContent = apiForecast ? 'This city is using the Open-Meteo provider forecast. ML accuracy metrics are not applicable.' : 'No trained model metrics available.';
    }
  }

  if (abs) {
    safeSet('abstractPaperTitle', abs.title);
    safeSet('abstractPaperAuthors', 'Authors: ' + abs.authors.join(', '));
    safeSet('abstractPaperBody', abs.abstractText);
    const kwContainer = document.getElementById('abstractPaperKeywords');
    if (kwContainer) {
      kwContainer.innerHTML = '';
      abs.keywords.forEach(k => {
        const span = document.createElement('span');
        span.className = 'keyword-tag';
        span.textContent = k;
        kwContainer.appendChild(span);
      });
    }
  }

  const dailyContainer = document.getElementById('dailyForecastCards');
  if (dailyContainer && pred.dailySummary) {
    dailyContainer.innerHTML = '';
    pred.dailySummary.forEach(d => {
      const card = document.createElement('div');
      card.className = 'daily-card';
      const hasAqi = d.avgAqi != null && Number.isFinite(Number(d.avgAqi));
      const aqiValue = hasAqi ? Math.round(Number(d.avgAqi)) : 'AQI unavailable';
      const aqiColor = hasAqi ? getAqiHex(Number(d.avgAqi)) : '#94a3b8';
      const categoryBadge = hasAqi
        ? `<span class="badge-aqi aqi-${d.categoryClass || 'moderate'}" style="font-size: 0.68rem; padding: 2px 6px;">${d.aqiCategory || 'AQI forecast'}</span>`
        : '<span class="badge-aqi" style="font-size:0.68rem;padding:2px 6px;">Not available</span>';
      // Daily cards are displayed in the viewer's local calendar, not UTC.
      // Open-Meteo hourly timestamps are requested in UTC for ML feature alignment.
      const localForecastDate = new Date();
      localForecastDate.setHours(0, 0, 0, 0);
      localForecastDate.setDate(localForecastDate.getDate() + Math.max(0, Number(d.dayIndex || 1) - 1));
      const displayDate = localForecastDate.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
      const forecastDayName = Number(d.dayIndex || 1) === 1 ? 'Today'
        : Number(d.dayIndex || 1) === 2 ? 'Tomorrow'
          : localForecastDate.toLocaleDateString(undefined, { weekday: 'short' });
      card.innerHTML = `
        <div class="daily-day-name">${forecastDayName} <span class="daily-full-name">(${displayDate})</span></div>
        <div class="daily-wx-pill"><span class="daily-wx-icon">${d.weatherIcon || '⛅'}</span><span class="daily-wx-label">${d.weatherCondition || 'Weather unavailable'}</span></div>
        <div class="daily-temp-row"><span class="daily-temp-high">${d.tempMax ?? '—'}°C</span><span class="daily-temp-divider">/</span><span class="daily-temp-low">${d.tempMin ?? '—'}°C</span></div>
        <div class="daily-rain-pill ${Number(d.totalPrecipitationMm) > 5 ? 'rain-high' : ''}">💧 ${d.totalPrecipitationMm ?? '—'} mm rain</div>
        <div style="font-size:0.72rem;color:var(--text-secondary);margin-top:4px">Humidity ${d.avgHumidityPercent ?? '—'}% · Wind max ${d.maxWindSpeedMs ?? '—'} m/s</div>
        <div class="daily-aqi-row"><div class="daily-aqi-num" style="color: ${aqiColor}">${aqiValue}</div>${categoryBadge}</div>
        <div class="daily-tip-text">${d.healthTip || (trained ? 'Forecast from the trained city-specific ML model.' : apiForecast ? 'AQI forecast supplied by Open-Meteo; not a local ML prediction.' : (pred.error || 'AQI forecast unavailable.'))}</div>
      `;
      dailyContainer.appendChild(card);
    });
  }
}
function updateHealthAndOperations(data) {
  const health = data.healthAndOpsData;
  if (!health) return;
  const setText = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
  setText('healthSeverityBadge', `AQI ${health.currentAqi}: ${health.advisoryTone}`);
  setText('healthPathologyText', health.guidanceNote);
  const container = document.getElementById('cohortsGrid');
  if (!container) return;
  container.innerHTML = '';
  (health.vulnerableCohorts || []).forEach(group => {
    const card = document.createElement('div');
    card.className = 'cohort-card';
    const heading = document.createElement('strong');
    heading.textContent = `${group.group} ? ${group.status}`;
    const advice = document.createElement('p');
    advice.textContent = group.directive;
    card.append(heading, advice);
    container.appendChild(card);
  });
}

function getAqiHex(aqi) {
  if (aqi <= 50) return '#10b981';
  if (aqi <= 100) return '#fbbf24';
  if (aqi <= 150) return '#fb923c';
  if (aqi <= 200) return '#f87171';
  if (aqi <= 300) return '#c084fc';
  return '#fda4af';
}

// ==========================================================================
// Chart.js Rendering Functions
// ==========================================================================
function renderAllCharts() {
  if (!currentTelemetry) return;
  renderPredictionChart();
  renderSpeciationRadarChart();
  renderWhoComparisonBarChart();
  renderFeatureImportanceChart();
}

// 1. 72-Hour Predictive Chart with Confidence Bounds
function renderPredictionChart() {
  const ctx = document.getElementById('predictionChart');
  if (!ctx) return;

  if (chartInstances.prediction) chartInstances.prediction.destroy();

  const series = currentTelemetry.predictionsData.hourlyTrajectory || [];
  const labels = series.map((s, i) => i % 12 === 0 ? s.displayTime : '');
  const isAqi = activeTrajectoryMode === 'aqi';

  const mainData = isAqi ? series.map(s => s.predictedAqi) : series.map(s => s.predictedPm25);
  const upperData = isAqi ? series.map(s => s.upperBound95) : series.map(s => s.pm25UpperBound95);
  const lowerData = isAqi ? series.map(s => s.lowerBound95) : series.map(s => s.pm25LowerBound95);

  const datasets = [
    {
      label: isAqi ? (currentTelemetry.predictionsData.modelStatus === 'api_fallback' ? 'AQI forecast (Open-Meteo API)' : 'Predicted AQI (XGBoost)') : (currentTelemetry.predictionsData.modelStatus === 'api_fallback' ? 'PM2.5 forecast (Open-Meteo API)' : 'Predicted PM2.5 (XGBoost)'),
      data: mainData,
      borderColor: isAqi ? '#06b6d4' : '#f97316',
      backgroundColor: isAqi ? 'rgba(6, 182, 212, 0.15)' : 'rgba(249, 115, 22, 0.15)',
      fill: false,
      tension: 0.35,
      borderWidth: 2.5,
      pointRadius: 2,
      pointHoverRadius: 6
    }
  ];

  if (showConfidenceBand && currentTelemetry.predictionsData.modelStatus === 'ready') {
    datasets.unshift({
      label: '95% Confidence Upper Bound',
      data: upperData,
      borderColor: 'transparent',
      backgroundColor: isAqi ? 'rgba(6, 182, 212, 0.08)' : 'rgba(249, 115, 22, 0.08)',
      fill: '+1',
      pointRadius: 0,
      tension: 0.35
    });
    datasets.push({
      label: '95% Confidence Lower Bound',
      data: lowerData,
      borderColor: 'transparent',
      backgroundColor: 'transparent',
      fill: false,
      pointRadius: 0,
      tension: 0.35
    });
  }

  chartInstances.prediction = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const idx = items[0].dataIndex;
              return `${series[idx].displayTime} (+${series[idx].horizonHours}h)`;
            },
            afterBody: (items) => {
              const idx = items[0].dataIndex;
              const source = currentTelemetry.predictionsData.modelStatus === 'api_fallback' ? 'Open-Meteo Air Quality API' : 'Trained XGBoost model';
              return `Source: ${source} | Horizon: ${series[idx].horizonHours}h`;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: false,
          grid: { color: 'rgba(255, 255, 255, 0.06)' },
          ticks: { color: '#94a3b8' }
        },
        x: {
          grid: { display: false },
          ticks: { color: '#94a3b8', maxRotation: 0 }
        }
      }
    }
  });
}

// 2. Chemical Speciation Radar Chart
function renderSpeciationRadarChart() {
  const ctx = document.getElementById('speciationRadarChart');
  if (!ctx) return;
  if (chartInstances.radar) chartInstances.radar.destroy();

  const pol = currentTelemetry.chemistryData.current.pollutants;
  const labels = ['PM2.5', 'PM10', 'NO₂', 'SO₂', 'CO (×0.01)', 'O₃'];
  const values = [
    pol.pm25.value,
    pol.pm10.value,
    pol.no2.value,
    pol.so2.value,
    Math.round(pol.co.value * 0.01),
    pol.o3.value
  ];

  chartInstances.radar = new Chart(ctx, {
    type: 'radar',
    data: {
      labels,
      datasets: [{
        label: 'Aerosol & Criteria Gases (µg/m³)',
        data: values,
        borderColor: '#06b6d4',
        backgroundColor: 'rgba(6, 182, 212, 0.25)',
        borderWidth: 2,
        pointBackgroundColor: '#06b6d4',
        pointRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        r: {
          grid: { color: 'rgba(255, 255, 255, 0.08)' },
          angleLines: { color: 'rgba(255, 255, 255, 0.08)' },
          pointLabels: { color: '#94a3b8', font: { size: 11, family: 'Inter' } },
          ticks: { backdropColor: 'transparent', color: '#64748b' }
        }
      },
      plugins: { legend: { display: false } }
    }
  });
}

// 3. WHO Guidelines Comparison Bar Chart
function renderWhoComparisonBarChart() {
  const ctx = document.getElementById('whoComparisonBarChart');
  if (!ctx) return;
  if (chartInstances.who) chartInstances.who.destroy();

  const pol = currentTelemetry.chemistryData.current.pollutants;
  const labels = ['PM2.5', 'PM10', 'NO₂', 'SO₂', 'O₃'];
  const observed = [pol.pm25.value, pol.pm10.value, pol.no2.value, pol.so2.value, pol.o3.value];
  const whoLimits = [pol.pm25.whoLimit, pol.pm10.whoLimit, pol.no2.whoLimit, pol.so2.whoLimit, pol.o3.whoLimit];

  chartInstances.who = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Observed Concentration',
          data: observed,
          backgroundColor: '#06b6d4',
          borderRadius: 4
        },
        {
          label: 'WHO 2021 Guideline',
          data: whoLimits,
          backgroundColor: '#ef4444',
          borderRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.06)' },
          ticks: { color: '#94a3b8' }
        },
        x: {
          grid: { display: false },
          ticks: { color: '#94a3b8' }
        }
      },
      plugins: {
        legend: {
          position: 'top',
          labels: { color: '#94a3b8', font: { size: 11 } }
        }
      }
    }
  });
}

// 4. Feature Importance Horizontal Bar Chart
function renderFeatureImportanceChart() {
  const ctx = document.getElementById('featureImportanceChart');
  if (!ctx) return;
  if (chartInstances.features) chartInstances.features.destroy();

  const feat = currentTelemetry.predictionsData.modelValidationMetrics.featureImportance || [];
  const labels = feat.map(f => f.feature);
  const data = feat.map(f => Math.round(f.importance * 100));

  chartInstances.features = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Relative Predictive Weight (%)',
        data,
        backgroundColor: [
          '#06b6d4',
          '#3b82f6',
          '#8b5cf6',
          '#f59e0b',
          '#10b981',
          '#64748b'
        ],
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.06)' },
          ticks: { color: '#94a3b8' },
          max: 40
        },
        y: {
          grid: { display: false },
          ticks: { color: '#94a3b8', font: { size: 10 } }
        }
      },
      plugins: { legend: { display: false } }
    }
  });
}

// ==========================================================================
// AI Scientific Assistant Dialogue
// ==========================================================================
function updateChatSuggestions(location, predictions) {
  const container = document.getElementById('chatSuggestions');
  if (!container) return;
  const city = location?.city || 'this city';
  const forecastLabel = ['ready', 'api_fallback'].includes(predictions?.modelStatus) ? `7-day AQI & weather in ${city}` : `7-day weather in ${city}`;
  const forecastQuestion = ['ready', 'api_fallback'].includes(predictions?.modelStatus)
    ? `Show me the 7-day AQI and weather outlook for ${city}, and identify whether the AQI forecast comes from ML or the provider API.`
    : `Show me the 7-day weather outlook for ${city}, and tell me whether an AQI forecast is available.`;
  const suggestions = [
    { label: `Current AQI in ${city}`, query: `What is the current AQI in ${city}, and what does its category mean?` },
    { label: `Main pollutant in ${city}`, query: `Which pollutant is contributing most to the AQI in ${city}?` },
    { label: forecastLabel, query: forecastQuestion },
    { label: `Health guidance for ${city}`, query: `What general precautions should people in ${city} consider based on the current AQI?` },
  ];
  container.replaceChildren(...suggestions.map(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip-btn';
    button.dataset.query = item.query;
    button.textContent = item.label;
    return button;
  }));
}

async function sendChatMessage(promptText) {
  const container = document.getElementById('chatMessagesContainer');

  // Append user message
  const userMsg = document.createElement('div');
  userMsg.className = 'chat-msg user';
  userMsg.innerHTML = `
    <div class="msg-avatar">👤</div>
    <div class="msg-bubble">${escapeHtml(promptText)}</div>
  `;
  container.appendChild(userMsg);
  container.scrollTop = container.scrollHeight;

  // Append thinking placeholder
  const botMsg = document.createElement('div');
  botMsg.className = 'chat-msg bot';
  botMsg.innerHTML = `
    <div class="msg-avatar">🤖</div>
    <div class="msg-bubble">
      <span class="status-dot"></span> <em>Preparing an answer from current AQI and weather data...</em>
    </div>
  `;
  container.appendChild(botMsg);
  container.scrollTop = container.scrollHeight;

  const contextSummary = currentTelemetry ? {
    location: currentTelemetry.meta.location,
    chemistryData: { current: currentTelemetry.chemistryData.current, dailyWeather: currentTelemetry.chemistryData.dailyWeather },
    predictionsData: currentTelemetry.predictionsData,
    healthAndOpsData: currentTelemetry.healthAndOpsData,
    researchAbstract: currentTelemetry.researchAbstract
  } : null;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: promptText,
        history: conversationHistory,
        context: contextSummary
      })
    });

    if (!res.ok) throw new Error(`Assistant HTTP ${res.status}`);
    const data = await res.json();

    const formattedReply = renderMarkdown(data.reply);
    botMsg.querySelector('.msg-bubble').innerHTML = formattedReply;
    conversationHistory.push({ role: 'user', content: promptText });
    conversationHistory.push({ role: 'assistant', content: data.reply });
  } catch (err) {
    botMsg.querySelector('.msg-bubble').innerHTML = `
      <span class="text-danger">⚠️ Error communicating with assistant: ${err.message}</span>
    `;
  }

  container.scrollTop = container.scrollHeight;
}

// Simple Markdown Renderer
function renderMarkdown(text) {
  if (!text) return '';
  const lines = escapeHtml(String(text)).replace(/\r/g, '').split('\n');
  const output = [];
  let paragraph = [];
  let listOpen = false;
  const inline = value => value
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const flushParagraph = () => {
    if (paragraph.length) output.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => { if (listOpen) output.push('</ul>'); listOpen = false; };
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { flushParagraph(); closeList(); continue; }
    if (line.startsWith('|') && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1].trim())) {
      flushParagraph(); closeList();
      const headers = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      i--;
      output.push(`<div class="chat-table-wrap"><table class="chat-response-table"><thead><tr>${headers.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, index) => `<td>${inline(row[index] || 'Unavailable')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph(); closeList();
      const level = Math.min(heading[1].length + 2, 5);
      output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const item = line.match(/^[-*]\s+(.+)$/);
    if (item) {
      flushParagraph();
      if (!listOpen) { output.push('<ul>'); listOpen = true; }
      output.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  closeList();
  return output.join('');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ==========================================================================
// Academic Research Dossier PDF Generator
// ==========================================================================
async function exportResearchDossierPdf() {
  if (!currentTelemetry) {
    alert('Please wait for city data to finish loading.');
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const location = currentTelemetry.meta.location;
  const current = currentTelemetry.chemistryData.current;
  const predictions = currentTelemetry.predictionsData;
  const abstract = currentTelemetry.researchAbstract;
  const weather = current.meteorology || {};
  const metrics = predictions.modelValidationMetrics || {};
  const daily = predictions.dailySummary || [];
  const weatherMetrics = metrics.weatherValidationMetrics || {};
  const colors = {
    navy: [11, 24, 43], ink: [24, 39, 57], muted: [92, 108, 124],
    cyan: [6, 182, 212], pale: [239, 247, 250], line: [220, 229, 235], white: [255, 255, 255],
  };
  const value = (input, digits = 1) => {
    if (input == null || input === '' || !Number.isFinite(Number(input))) return 'N/A';
    const n = Number(input);
    return Number.isInteger(n) ? String(n) : n.toFixed(digits);
  };
  const aqiColor = aqi => {
    if (aqi <= 50) return [16, 150, 105];
    if (aqi <= 100) return [190, 139, 0];
    if (aqi <= 150) return [220, 105, 35];
    if (aqi <= 200) return [200, 55, 55];
    if (aqi <= 300) return [130, 70, 150];
    return [105, 45, 65];
  };
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const generatedAt = new Date();
  const generatedLabel = generatedAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  doc.setProperties({
    title: `Air Quality and Weather Report - ${location.city || 'Selected City'}`,
    subject: 'Current conditions and machine-learning forecast',
    author: 'Air Quality and Weather Research Project',
  });

  const drawHeader = (eyebrow, title, subtitle) => {
    doc.setFillColor(...colors.navy);
    doc.rect(0, 0, pageWidth, 29, 'F');
    doc.setFillColor(...colors.cyan);
    doc.rect(0, 28, pageWidth, 1.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...colors.cyan);
    doc.text(eyebrow.toUpperCase(), 15, 9);
    doc.setFontSize(17);
    doc.setTextColor(...colors.white);
    doc.text(title, 15, 18);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(205, 219, 232);
    doc.text(subtitle, 15, 25);
    doc.setTextColor(...colors.white);
    doc.setFontSize(8);
    doc.text(generatedLabel, pageWidth - 15, 18, { align: 'right' });
  };
  const drawFooter = pageNumber => {
    doc.setDrawColor(...colors.line);
    doc.line(15, pageHeight - 10, pageWidth - 15, pageHeight - 10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...colors.muted);
    const footerNote = predictions.modelStatus === 'ready'
      ? 'Current observations and historical targets: Open-Meteo; AQI forecasts are city-specific ML estimates, not official alerts.'
      : predictions.modelStatus === 'api_fallback'
        ? 'AQI outlook is supplied by the Open-Meteo provider API, not a local ML model; not an official alert.'
        : 'Current observations and weather outlook: Open-Meteo; AQI forecast is unavailable.';
    doc.text(footerNote, 15, pageHeight - 5);
    doc.text(`${pageNumber} / 2`, pageWidth - 15, pageHeight - 5, { align: 'right' });
  };
  const sectionTitle = (title, x, y, note = '') => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...colors.ink);
    doc.text(title, x, y);
    if (note) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(...colors.muted);
      doc.text(note, pageWidth - 15, y, { align: 'right' });
    }
  };
  const drawCard = (x, y, w, h, label, main, sub, accent = colors.cyan) => {
    doc.setFillColor(249, 252, 253);
    doc.setDrawColor(...colors.line);
    doc.roundedRect(x, y, w, h, 2, 2, 'FD');
    doc.setFillColor(...accent);
    doc.roundedRect(x, y, 2.2, h, 1, 1, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...colors.muted);
    doc.text(label.toUpperCase(), x + 7, y + 7);
    doc.setFontSize(16);
    doc.setTextColor(...colors.ink);
    doc.text(String(main), x + 7, y + 16);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...colors.muted);
    doc.text(String(sub || ''), x + 7, y + h - 4);
  };

  // Page 1: a concise city snapshot and the complete forecast table.
  drawHeader('City report', 'Air Quality & Weather', `${location.city || 'Selected location'}${location.country ? `, ${location.country}` : ''}  |  Current conditions and 7-day outlook`);
  const cardY = 36;
  const cardGap = 4;
  const cardWidth = (pageWidth - 30 - cardGap * 3) / 4;
  const isIndiaReport = /india/i.test(location.country || '');
  const reportLiveAqi = current.liveAqi || {};
  const aqiValueNow = isIndiaReport ? (reportLiveAqi.headlineAqi ?? current.indiaAqi ?? current.indiaIndicativeAqi) : current.usAqi;
  const reportAqiLabel = isIndiaReport
    ? (reportLiveAqi.selectedSource === 'cpcb_station_median' ? 'CPCB Nearby-Station Median' : reportLiveAqi.selectedSource === 'cpcb_station' ? 'CPCB Station AQI' : 'Open-Meteo Model AQI')
    : 'US EPA PM AQI estimate';
  const reportAqiCategory = isIndiaReport
    ? (reportLiveAqi.category?.label || current.indiaCategory?.label || current.indiaIndicativeCategory?.label)
    : current.category?.label;
  const cardData = [
    [reportAqiLabel, value(aqiValueNow, 0), reportAqiCategory || 'Insufficient Data', aqiColor(Number(aqiValueNow) || 0)],
    ['PM2.5', `${value(current.pollutants?.pm25?.value)} ug/m3`, `PM10 ${value(current.pollutants?.pm10?.value)} ug/m3`, [6, 182, 212]],
    ['Temperature', `${value(weather.surfaceTemperatureC)} deg C`, weather.weatherCondition || 'Current weather', [235, 145, 55]],
    ['Humidity & wind', `${value(weather.relativeHumidityPercent, 0)}%`, `Wind ${value(weather.windSpeedMs)} m/s`, [79, 124, 172]],
  ];
  cardData.forEach((card, i) => drawCard(15 + i * (cardWidth + cardGap), cardY, cardWidth, 27, ...card));

  sectionTitle('City summary', 15, 73, `Primary pollutant: ${current.indiaPrimaryPollutant || current.primaryPollutant || 'N/A'}  |  ${reportAqiLabel}: ${value(aqiValueNow, 0)}${isIndiaReport && reportLiveAqi.selectedSource === 'cpcb_station_median' ? ` (${reportLiveAqi.regionalMedianStationCount} nearby stations; regional estimate)` : ''}`);
  const summaryText = abstract?.abstractText || 'Current AQI and weather readings are shown above. Daily values below are generated from the selected city forecast.';
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...colors.ink);
  const allSummaryLines = doc.splitTextToSize(summaryText, pageWidth - 30);
  const summaryLines = allSummaryLines.length > 3 ? [...allSummaryLines.slice(0, 2), '...'] : allSummaryLines;
  doc.text(summaryLines, 15, 80, { lineHeightFactor: 1.3 });

  sectionTitle('7-day US AQI forecast', 15, 94, predictions.modelStatus === 'ready' ? 'XGBoost forecast · US AQI scale' : predictions.modelStatus === 'api_fallback' ? 'Open-Meteo AQI API · US AQI scale (not ML)' : 'Weather outlook available; US AQI forecast unavailable');
  const columns = [
    { title: 'DAY', width: 24 }, { title: 'DATE', width: 25 }, { title: 'AVG US AQI', width: 27 },
    { title: 'PM2.5', width: 27 }, { title: 'CONDITIONS', width: 38 }, { title: 'HIGH / LOW', width: 31 },
    { title: predictions.modelStatus === 'ready' ? 'RAIN' : 'RAIN CHANCE', width: 27 }, { title: 'HUMIDITY', width: 28 }, { title: 'MAX WIND', width: 25 },
  ];
  let tableX = 15;
  let tableY = 99;
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
  doc.setFillColor(...colors.navy);
  doc.roundedRect(tableX, tableY, tableWidth, 8, 1.5, 1.5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(...colors.white);
  let cursorX = tableX;
  columns.forEach(column => {
    doc.text(column.title, cursorX + 2, tableY + 5.2);
    cursorX += column.width;
  });
  tableY += 8;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  (daily.slice(0, 7)).forEach((day, index) => {
    if (index % 2 === 0) {
      doc.setFillColor(...colors.pale);
      doc.rect(tableX, tableY, tableWidth, 8.5, 'F');
    }
    const values = [
      day.dayName || 'N/A', day.dateStr || 'N/A', value(day.avgAqi, 0), value(day.avgPm25),
      day.weatherCondition || 'N/A', `${value(day.tempMax, 0)} / ${value(day.tempMin, 0)} deg C`,
      predictions.modelStatus === 'ready' ? `${value(day.totalPrecipitationMm)} mm` : `${value(day.rainProb, 0)}%`,
      `${value(day.avgHumidityPercent, 0)}%`, `${value(day.maxWindSpeedMs)} m/s`,
    ];
    cursorX = tableX;
    values.forEach((cell, cellIndex) => {
      if (cellIndex === 2 && day.avgAqi != null) doc.setTextColor(...aqiColor(Number(day.avgAqi)));
      else doc.setTextColor(...colors.ink);
      const maxWidth = columns[cellIndex].width - 4;
      doc.text(doc.splitTextToSize(String(cell), maxWidth).slice(0, 1), cursorX + 2, tableY + 5.5);
      cursorX += columns[cellIndex].width;
    });
    tableY += 8.5;
  });
  if (!daily.length) {
    doc.setTextColor(...colors.muted);
    doc.text('No forecast rows are available for this city.', tableX + 2, tableY + 6);
  }
  drawFooter(1);

  // Page 2: validation scores, methodology, and data interpretation notes.
  doc.addPage('a4', 'landscape');
  drawHeader('Model notes', 'Validation & data', `${location.city || 'Selected location'}  |  Model version ${metrics.architecture ? '5' : 'unavailable'}`);
  sectionTitle('AQI model holdout performance', 15, 39, 'Regression errors are measured in AQI points');
  const scoreY = 45;
  const scoreGap = 4;
  const scoreWidth = (pageWidth - 30 - scoreGap * 3) / 4;
  const scoreCards = [
    ['AQI MAE', `${value(metrics.mae)} points`, 'Mean absolute error', [6, 182, 212]],
    ['AQI RMSE', `${value(metrics.rmse)} points`, 'Penalizes larger misses', [79, 124, 172]],
    ['R-squared', value(metrics.rSquaredScore, 3), 'Holdout fit score', [119, 106, 180]],
    ['Direction match', `${value(metrics.directionAccuracyPercent, 1)}%`, 'Correct rise / fall direction', [235, 145, 55]],
  ];
  scoreCards.forEach((card, i) => drawCard(15 + i * (scoreWidth + scoreGap), scoreY, scoreWidth, 27, ...card));

  const weatherLabels = {
    temperature_2m: ['Temperature', 'deg C'], relative_humidity_2m: ['Humidity', 'percentage points'],
    wind_speed_10m: ['Wind speed', 'm/s'], precipitation: ['Precipitation', 'mm/hour'],
    cloud_cover: ['Cloud cover', 'percentage points'], surface_pressure: ['Surface pressure', 'hPa'],
  };
  const wxCols = [
    { title: 'VARIABLE', width: 75 }, { title: 'MAE', width: 52 },
    { title: 'RMSE', width: 52 }, { title: 'R-SQUARED', width: 42 }, { title: 'PERSISTENCE MAE', width: 46 },
  ];
  const verifiedWeatherRows = Object.entries(weatherLabels).flatMap(([target, [label, unit]]) => {
    const score = weatherMetrics[target];
    const sampleCount = Number(score?.n ?? score?.testPairCount ?? score?.validationPairCount);
    const hasMetric = key => Number.isFinite(Number(score?.[key]));
    if (!score || !Number.isFinite(sampleCount) || sampleCount < 1 || !hasMetric('mae') || !hasMetric('rmse') || !hasMetric('r2')) return [];
    return [{ target, label, unit, score }];
  });
  sectionTitle('Weather model holdout errors', 15, 82, verifiedWeatherRows.length ? 'MAE and persistence comparison use each variable native unit' : '');
  let wxY = 87;
  if (verifiedWeatherRows.length) {
    const wxX = 15;
    const wxWidth = wxCols.reduce((sum, column) => sum + column.width, 0);
    doc.setFillColor(...colors.navy);
    doc.roundedRect(wxX, wxY, wxWidth, 8, 1.5, 1.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(...colors.white);
    let wxCursor = wxX;
    wxCols.forEach(column => { doc.text(column.title, wxCursor + 2, wxY + 5.2); wxCursor += column.width; });
    wxY += 8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    verifiedWeatherRows.forEach(({ label, unit, score }, index) => {
      if (index % 2 === 0) {
        doc.setFillColor(...colors.pale);
        doc.rect(wxX, wxY, wxWidth, 8.5, 'F');
      }
      const row = [label, `${value(score.mae)} ${unit}`, `${value(score.rmse)} ${unit}`, value(score.r2, 3), `${value(score.persistence_mae)} ${unit}`];
      wxCursor = wxX;
      row.forEach((cell, i) => { doc.setTextColor(...colors.ink); doc.text(doc.splitTextToSize(cell, wxCols[i].width - 4).slice(0, 1), wxCursor + 2, wxY + 5.5); wxCursor += wxCols[i].width; });
      wxY += 8.5;
    });
  } else {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...colors.muted);
    doc.text('Weather-model validation metrics are unavailable; weather forecasts are supplied by Open-Meteo.', 15, 91);
  }

  const notesY = Math.max(wxY + 18, verifiedWeatherRows.length ? 157 : 112);
  sectionTitle('Method and interpretation', 15, notesY);
  const methodLines = [
    `Model: ${metrics.architecture || 'No compatible trained model is available for this city.'}`,
    `Evaluation: ${metrics.validationNote || 'Model holdout statistics are unavailable.'} AQI persistence MAE: ${value(metrics.persistenceMae)} points.`,
    `Training data: ${metrics.targetSource || 'Open-Meteo Air Quality API'} and Open-Meteo Historical Weather API. Trained: ${metrics.trainedAt ? new Date(metrics.trainedAt).toLocaleString() : 'N/A'}. AQI test samples: ${value(metrics.testPairCount, 0)}.`,
    'These results measure agreement with the historical data source. They do not guarantee future performance or replace official measurements and health guidance.',
  ];
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...colors.ink);
  const methodText = doc.splitTextToSize(methodLines.join('\n'), pageWidth - 30);
  doc.text(methodText, 15, notesY + 6, { lineHeightFactor: 1.25 });
  drawFooter(2);

  const safeCity = String(location.city || 'City').replace(/[^a-z0-9_-]+/gi, '_');
  doc.save(`Air_Quality_Weather_Report_${safeCity}_${generatedAt.toISOString().slice(0, 10)}.pdf`);
}

// Helpers
function showLoading(show, title = '', sub = '') {
  const overlay = document.getElementById('loadingOverlay');
  if (show) {
    if (title) document.querySelector('.loader-title').textContent = title;
    if (sub) document.getElementById('loaderSubtext').textContent = sub;
    overlay.style.display = 'flex';
  } else {
    overlay.style.display = 'none';
  }
}

function showError(msg) {
  const banner = document.getElementById('errorBanner');
  document.getElementById('errorMessage').textContent = msg;
  banner.style.display = 'flex';
}

function hideError() {
  document.getElementById('errorBanner').style.display = 'none';
}


// ---------- Multi-agent trace and live accuracy ----------
function escHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const fmtNum = v => (v == null ? '&mdash;' : escHtml(v));

function renderAgentPanels(data) {
  const trace = document.getElementById('agentTraceList');
  if (trace && data.agentTrace) {
    trace.innerHTML = `<div class="card-subtitle">Coordinator plan: ${escHtml(data.agentTrace.coordinator.plan.join(' \u2192 '))} &middot; total ${escHtml(data.agentTrace.coordinator.totalMs)} ms</div>` +
      data.agentTrace.agents.map(a => `<div class="agent-trace-row ${escHtml(a.status)}"><span class="dot"></span><div><strong>${escHtml(a.agent)}</strong><small>${escHtml(a.summary)}</small>${(a.notes || []).map(n => `<small>\u2022 ${escHtml(n)}</small>`).join('')}</div><span>${escHtml(a.status)} &middot; ${escHtml(a.ms)} ms</span></div>`).join('');
  }
  const out = document.getElementById('agentOutputs');
  if (out) {
    const ex = data.explainability;
    const alerts = data.healthAndOpsData?.alerts || [];
    out.innerHTML =
      `<h5>Alerts (rules ${escHtml(data.healthAndOpsData?.rulesVersion || 'n/a')})</h5>` +
      (alerts.length ? `<ul>${alerts.map(x => `<li><strong>${escHtml(x.level)}</strong>: ${escHtml(x.message)} <small>(${escHtml(x.source)}, ${escHtml(x.validAt)})</small></li>`).join('')}</ul>` : '<p>No alert thresholds exceeded.</p>') +
      (ex ? `<h5>Explanation</h5><p><em>${escHtml(ex.method)}</em></p>` +
        (ex.modelDrivers.length ? `<ul>${ex.modelDrivers.map(d => `<li>${escHtml(d.feature)} (${escHtml(d.importance)})</li>`).join('')}</ul>` : '') +
        `<ul>${ex.meteorologicalContext.map(t => `<li>${escHtml(t)}</li>`).join('')}</ul><p><small>${escHtml(ex.caveat)}</small></p>` : '');
  }
  const panel = document.getElementById('evalPanel');
  const ev = data.evaluation;
  if (panel && ev) {
    const rows = [1, 6, 24].map(h => {
      const m = ev.byHorizon[h].usAqi;
      return `<tr><td>+${h} h</td><td>${fmtNum(m.n)}</td><td>${fmtNum(m.mae)}</td><td>${fmtNum(m.rmse)}</td><td>${fmtNum(m.r2)}</td><td>${fmtNum(m.persistenceMae)}</td><td>${fmtNum(m.skillVsPersistence)}</td></tr>`;
    }).join('');
    const o = ev.openMeteoVsObserved;
    panel.innerHTML =
      `<p><strong>${escHtml(ev.status)}</strong>: ${escHtml(ev.statusNote)} (${escHtml(ev.forecastsVerified)} verified of ${escHtml(ev.forecastsLogged)} logged)</p>` +
      `<table class="eval-table"><thead><tr><th>US AQI</th><th>n</th><th>MAE</th><th>RMSE</th><th>R&sup2;</th><th>Persist. MAE</th><th>Skill</th></tr></thead><tbody>${rows}</tbody></table>` +
      `<p><small>Reference: ${escHtml(ev.reference)}. Skill &gt; 0 means better than "nothing changes" persistence.</small></p>` +
      `<p><strong>Open-Meteo vs independent observations</strong> (${escHtml(o.observationsStored)} stored): temperature MAE ${fmtNum(o.temperatureC.mae)} &deg;C, bias ${fmtNum(o.temperatureC.bias)} (n=${fmtNum(o.temperatureC.n)}); PM2.5 MAE ${fmtNum(o.pm25.mae)}, bias ${fmtNum(o.pm25.bias)} (n=${fmtNum(o.pm25.n)}).</p>`;
  }
}

document.addEventListener('click', async event => {
  if (event.target?.id !== 'obsSaveBtn') return;
  const msg = document.getElementById('obsMsg');
  try {
    if (!currentLocation) throw new Error('Load a city first.');
    const timeLocal = document.getElementById('obsTime').value;
    if (!timeLocal) throw new Error('Pick the observation time.');
    const body = {
      city: currentLocation.city,
      time: new Date(timeLocal).toISOString(),
      temperature: document.getElementById('obsTemp').value,
      pm25: document.getElementById('obsPm25').value,
      source: document.getElementById('obsSource').value.trim(),
    };
    const res = await fetch('/api/evaluation/observation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Save failed');
    msg.textContent = 'Saved. Reloading...';
    const params = currentLocation.city === 'My Location' ? { lat: currentLocation.lat, lon: currentLocation.lon } : { city: currentLocation.city };
    await loadAnalysisData(params, true);
    msg.textContent = 'Saved and scored.';
  } catch (err) {
    msg.textContent = err.message;
  }
});

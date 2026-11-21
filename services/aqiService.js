// Atmospheric Chemistry & Air Quality Service
// Fetches AQI history/forecast and meteorology from Open-Meteo without synthetic fallbacks
import { calculateMedian, classifyIndianSearchMode, fetchIndiaCpcbStations, selectCpcbAqi } from './indiaAqiService.js';

export async function fetchAtmosphericChemistry(lat, lon, country = '', selectionContext = {}) {
  const roundLat = Math.round(lat * 10000) / 10000;
  const roundLon = Math.round(lon * 10000) / 10000;

  // Open-Meteo Air Quality URL (Full 7-day hourly forecast)
  const aqiUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${roundLat}&longitude=${roundLon}&timezone=UTC&past_days=8&forecast_days=7&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,aerosol_optical_depth,dust,us_aqi,european_aqi&hourly=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,aerosol_optical_depth,us_aqi`;

  // Open-Meteo Weather URL (Full 7-day hourly & daily weather forecast)
  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${roundLat}&longitude=${roundLon}&timezone=UTC&wind_speed_unit=kmh&past_days=8&forecast_days=7&current=temperature_2m,relative_humidity_2m,precipitation,cloud_cover,shortwave_radiation,surface_pressure,wind_speed_10m,wind_direction_10m,boundary_layer_height,weather_code&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,boundary_layer_height,surface_pressure,weather_code,precipitation,precipitation_probability,cloud_cover,shortwave_radiation&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max`;

  // Daily max/min must follow the city's local calendar day, not the UTC day.
  const localDailyUrl = `https://api.open-meteo.com/v1/forecast?latitude=${roundLat}&longitude=${roundLon}&timezone=auto&wind_speed_unit=kmh&forecast_days=7&current=temperature_2m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max`;

  try {
    const [aqiRes, wxRes, localRes] = await Promise.all([
      fetch(aqiUrl, { headers: { 'User-Agent': 'AirQualityWeather/1.0' } }),
      fetch(weatherUrl, { headers: { 'User-Agent': 'AirQualityWeather/1.0' } }),
      fetch(localDailyUrl, { headers: { 'User-Agent': 'AirQualityWeather/1.0' } }).catch(() => null)
    ]);

    if (!aqiRes.ok) throw new Error(`AQI API HTTP ${aqiRes.status}`);
    const aqiData = await aqiRes.json();

    let wxData = null;
    if (wxRes.ok) {
      wxData = await wxRes.json();
    }

    let localDaily = null;
    if (localRes && localRes.ok) localDaily = await localRes.json();
    const processed = processAtmosphericData(aqiData, wxData, localDaily);
    // Prefer a valid fresh CPCB station overall AQI for the live India headline.
    // Keep the Open-Meteo calculation separately as a fallback/model estimate.
    const isIndia = /^(in|india)$/i.test(String(country || '').trim());
    const fallbackAqi = isIndia && processed.current.providerUsAqi != null && Number.isFinite(Number(processed.current.providerUsAqi))
      ? Number(processed.current.providerUsAqi)
      : processed.current.usAqi;
    let liveAqi = {
      selectedSource: 'open_meteo', searchMode: 'citywide', headlineAqi: fallbackAqi,
      category: processed.current.category, stationCount: 0, selectedStations: [], nearestStation: null,
      nearestStationDistanceKm: null, observationTimestamp: processed.current.time || null,
      regionalMedianAqi: null, regionalMedianStationCount: 0, pollutantValues: null,
      pollutantSources: { source: 'Open-Meteo modeled hourly concentrations', isStationMeasurement: false },
      source: 'Open-Meteo Model AQI', sourceUrl: null,
      fallbackAqi, fallbackSource: 'Open-Meteo Model AQI',
      dataFreshness: { source: 'Open-Meteo', isFresh: Number.isFinite(fallbackAqi), timestamp: processed.current.time || null },
    };
    let stationFeed = null;
    if (isIndia) {
      const searchMode = classifyIndianSearchMode(selectionContext.location || {}, selectionContext.searchMode || '');
      try {
        const defaultRadiusKm = searchMode === 'citywide' ? 25 : 20;
        stationFeed = await fetchIndiaCpcbStations(roundLat, roundLon, { radiusKm: selectionContext.radiusKm || defaultRadiusKm });
      } catch (error) {
        console.warn(`CPCB live AQI unavailable for (${roundLat}, ${roundLon}):`, error.message);
      }
      const radiusKm = stationFeed?.radiusKm || 25;
      const selection = selectCpcbAqi(stationFeed?.stations || [], searchMode, radiusKm);
      const stationSource = stationFeed?.source || 'CPCB data unavailable';
      const chosen = selection.selectedStation;
      const sufficiency = assessCpcbSubIndexSufficiency(chosen?.pollutantSubIndices || selection.nearestStation?.pollutantSubIndices || {});
      const regionalSubIndices = {};
      if (searchMode === 'citywide' && selection.regionalMedianStationCount >= 3) {
        const keys = [...new Set(selection.selectedStations.flatMap(station => Object.keys(station.pollutantSubIndices || {})))];
        for (const key of keys) {
          const values = selection.selectedStations.map(station => station.pollutantSubIndices?.[key]).filter(Number.isFinite);
          const median = values.length ? calculateMedian(values) : null;
          if (median != null) regionalSubIndices[key] = median;
        }
      }
      const headlineSubIndices = chosen?.pollutantSubIndices || regionalSubIndices;
      const selectedSource = selection.headlineAqi == null ? 'open_meteo' : selection.selectedSource;
      liveAqi = {
        ...selection,
        selectedSource,
        headlineAqi: selection.headlineAqi ?? fallbackAqi,
      category: selection.headlineAqi == null ? getAqiCategory(fallbackAqi) : getIndiaAqiCategory(selection.headlineAqi),
        stationCount: selection.selectedStations.length,
        nearestStation: selection.nearestStation,
        selectedStations: selection.selectedStations,
        observationTimestamp: chosen?.observedAt || selection.nearestStation?.observedAt || null,
        pollutantValues: null,
        pollutantSources: {
          pm25: 'Open-Meteo modeled concentration', pm10: 'Open-Meteo modeled concentration',
          no2: 'Open-Meteo modeled concentration', so2: 'Open-Meteo modeled concentration',
          co: 'Open-Meteo modeled concentration', o3: 'Open-Meteo modeled concentration',
          note: 'CPCB feed provides pollutant sub-indices, not concentration measurements.',
          isStationMeasurement: false,
        },
        dominantPollutantSubIndices: headlineSubIndices,
        fallbackAqi,
        fallbackSource: 'Open-Meteo Model AQI',
        source: selectedSource === 'open_meteo' ? 'Open-Meteo Model AQI' : stationSource,
        sourceUrl: stationFeed?.sourceUrl || null,
        dataFreshness: selection.dataFreshness,
      };
      processed.current.indiaAqi = selectedSource === 'open_meteo' ? null : liveAqi.headlineAqi;
      processed.current.indiaAqiStatus = selectedSource === 'cpcb_station_median' ? 'regional_median' : selectedSource === 'cpcb_station' ? 'official' : 'open_meteo_fallback';
      processed.current.indiaCategory = selectedSource === 'open_meteo' ? null : liveAqi.category;
      processed.current.indiaIndicativeCategory = selectedSource === 'open_meteo' ? liveAqi.category : null;
      processed.current.indiaAqiSource = liveAqi.source;
      processed.current.indiaAqiStation = (chosen || selection.nearestStation)?.station || null;
      processed.current.indiaAqiAgency = (chosen || selection.nearestStation)?.agency || null;
      processed.current.indiaAqiDistanceKm = (chosen || selection.nearestStation)?.distanceKm ?? null;
      processed.current.indiaAqiObservedAt = liveAqi.observationTimestamp;
      processed.current.indiaReportedCpcbAqi = (chosen || selection.nearestStation)?.aqi ?? null;
      processed.current.indiaReportedCpcbCategory = (chosen || selection.nearestStation)?.category || null;
      processed.current.indiaCpcbSubIndices = headlineSubIndices;
      processed.current.indiaCpcbStations = selection.selectedStations;
      processed.current.indiaCpcbSource = stationSource;
      processed.current.indiaCpcbDataSufficiency = sufficiency;
      const dominantIndex = Object.entries(headlineSubIndices).sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1))[0];
      processed.current.indiaPrimaryPollutant = chosen?.primaryPollutant || dominantIndex?.[0] || null;
      processed.current.indiaAqiAttribution = stationFeed?.source || null;
      processed.current.indiaAqiSourceUrl = stationFeed?.sourceUrl || null;
      processed.current.indiaAqiDataQuality = selection.dataFreshness;
    }
    processed.current.liveAqi = liveAqi;
    processed.current.countryCode = /^(in|india)$/i.test(String(country || '').trim()) ? 'IN' : '';
    return processed;
  } catch (err) {
    console.warn(`Atmospheric fetch failed for (${lat}, ${lon}):`, err.message);
    throw new Error(`Open-Meteo air quality/weather data unavailable: ${err.message}`);
  }
}

// Translate WMO Weather Codes to simple friendly English & emoji
export function decodeWeatherCode(code) {
  if (code === 0) return { label: 'Clear Sky', icon: '☀️' };
  if ([1, 2].includes(code)) return { label: 'Partly Cloudy', icon: '⛅' };
  if (code === 3) return { label: 'Cloudy', icon: '☁️' };
  if ([45, 48].includes(code)) return { label: 'Hazy / Foggy', icon: '🌫️' };
  if ([51, 53, 55].includes(code)) return { label: 'Light Rain', icon: '🌦️' };
  if ([61, 63, 65].includes(code)) return { label: 'Rain', icon: '🌧️' };
  if ([71, 73, 75].includes(code)) return { label: 'Snow', icon: '❄️' };
  if ([80, 81, 82].includes(code)) return { label: 'Rain Showers', icon: '🌧️' };
  if ([95, 96, 99].includes(code)) return { label: 'Thunderstorm', icon: '⛈️' };
  return { label: 'Fair Weather', icon: '🌤️' };
}

// Process raw API telemetry into structured chemical speciation and weather data
function processAtmosphericData(aqi, wx, localDaily = null) {
  const cur = aqi.current || {};
  const curWx = (wx && wx.current) || {};

  if ((cur.pm2_5 == null && cur.pm10 == null) || !wx || curWx.temperature_2m == null) {
    throw new Error('Open-Meteo returned incomplete current AQI or weather data.');
  }

  const pm25 = cur.pm2_5 != null ? Math.round(cur.pm2_5 * 10) / 10 : null;
  const pm10 = cur.pm10 != null ? Math.round(cur.pm10 * 10) / 10 : null;
  const no2 = cur.nitrogen_dioxide != null ? Math.round(cur.nitrogen_dioxide * 10) / 10 : null;
  const so2 = cur.sulphur_dioxide != null ? Math.round(cur.sulphur_dioxide * 10) / 10 : null;
  const co = cur.carbon_monoxide != null ? Math.round(cur.carbon_monoxide * 10) / 10 : null;
  const o3 = cur.ozone != null ? Math.round(cur.ozone * 10) / 10 : null;
  const aod = cur.aerosol_optical_depth != null ? Math.round(cur.aerosol_optical_depth * 100) / 100 : null;
  const dust = cur.dust != null ? Math.round(cur.dust * 10) / 10 : null;

  // Current weather values from the Open-Meteo forecast API
  const boundaryLayerHgt = curWx.boundary_layer_height != null ? Math.round(curWx.boundary_layer_height) : null;
  const temp2m = Math.round(curWx.temperature_2m * 10) / 10;
  const rh2m = curWx.relative_humidity_2m != null ? Math.round(curWx.relative_humidity_2m) : null;
  const wind10m = curWx.wind_speed_10m != null ? Math.round(curWx.wind_speed_10m / 3.6 * 10) / 10 : null;
  const pressureHpa = curWx.surface_pressure != null ? Math.round(curWx.surface_pressure) : null;
  const weatherCode = curWx.weather_code !== undefined ? curWx.weather_code : 0;
  const weatherDesc = decodeWeatherCode(weatherCode);

  // EPA & Indian CPCB AQI Computations
  const epaSubIndices = calculateEpaSubIndices({ pm25, pm10, no2, so2, co, o3 });
  const indiaSubIndices = calculateIndiaNaqiSubIndices({ pm25, pm10, no2, so2, co, o3 });

  // Current US Standard AQI is calculated from pollutant concentrations using
  // the configured EPA breakpoints; the provider's raw index is not displayed.
  const usAqi = epaSubIndices.maxAqi;
  const indiaAqi = indiaSubIndices.officialAqi;
  const indiaIndicativeAqi = indiaSubIndices.indicativeAqi;

  // WHO 2021 Guideline Exceedance Multipliers
  const whoExceedance = {
    pm25Ratio: Math.round((pm25 / 15) * 10) / 10,
    pm10Ratio: Math.round((pm10 / 45) * 10) / 10,
    no2Ratio: Math.round((no2 / 25) * 10) / 10,
    so2Ratio: Math.round((so2 / 40) * 10) / 10,
    o3Ratio: Math.round((o3 / 100) * 10) / 10
  };

  // Hourly Series for model feeding (Full 7 days / 168 hours)
  const hourlyTime = (aqi.hourly && aqi.hourly.time) || [];
  const hourlyPm25 = (aqi.hourly && aqi.hourly.pm2_5) || [];
  const hourlyPm10 = (aqi.hourly && aqi.hourly.pm10) || [];
  const hourlyUsAqi = (aqi.hourly && aqi.hourly.us_aqi) || [];
  const hourlyPbl = (wx && wx.hourly && wx.hourly.boundary_layer_height) || [];
  const hourlyWind = (wx && wx.hourly && wx.hourly.wind_speed_10m) || [];
  const hourlyTemp = (wx && wx.hourly && wx.hourly.temperature_2m) || [];
  const hourlyPrecip = (wx && wx.hourly && wx.hourly.precipitation_probability) || [];

  // Daily weather forecast for next week
  const dailyWx = (localDaily && localDaily.daily) || (wx && wx.daily) || {};
  const utcOffsetSeconds = localDaily?.utc_offset_seconds ?? 0;
  const todayUtc = localDaily?.current?.time
    ? String(localDaily.current.time).slice(0, 10)
    : String(cur.time || new Date().toISOString()).slice(0, 10);
  const dailySummaryWeather = (dailyWx.time || [])
    .map((dateStr, i) => {
      const code = dailyWx.weather_code?.[i] ?? null;
      const info = code == null ? { label: 'Unavailable', icon: '🌤️' } : decodeWeatherCode(code);
      return {
        date: dateStr,
        weatherCode: code,
        tempMax: dailyWx.temperature_2m_max?.[i] != null ? Math.round(dailyWx.temperature_2m_max[i]) : null,
        tempMin: dailyWx.temperature_2m_min?.[i] != null ? Math.round(dailyWx.temperature_2m_min[i]) : null,
        rainProb: dailyWx.precipitation_probability_max?.[i] ?? null,
        windMax: dailyWx.wind_speed_10m_max?.[i] != null ? Math.round(dailyWx.wind_speed_10m_max[i] / 3.6 * 10) / 10 : null,
        weatherCondition: info.label,
        weatherIcon: info.icon
      };
    })
    .filter(day => day.date >= todayUtc)
    .slice(0, 7);

  return {
    current: {
      usAqi,
      providerUsAqi: cur.us_aqi ?? null,
      time: cur.time,
      indiaAqi,
      indiaIndicativeAqi,
      indiaAqiStatus: indiaSubIndices.status,
      indiaAqiDataQuality: {
        validPollutantCount: indiaSubIndices.validPollutantCount,
        hasParticulate: indiaSubIndices.hasParticulate,
        reasons: indiaSubIndices.reasons,
        averagingHours: null,
        validHours: 0,
        sourceVerified: false,
      },
      indiaPrimaryPollutant: indiaSubIndices.primaryPollutant,
      primaryPollutant: epaSubIndices.primaryPollutant,
      category: getAqiCategory(usAqi),
      indiaCategory: getIndiaAqiCategory(indiaAqi),
      indiaIndicativeCategory: getIndiaAqiCategory(indiaIndicativeAqi),
      indiaAqiSource: 'Open-Meteo modeled concentrations; indicative only',
      usAqiSource: 'Open-Meteo modeled PM concentrations; EPA particulate formula',
      usAqiCappedAt500: Number.isFinite(pm25) && Math.floor(pm25 * 10 + 1e-8) / 10 > 325.4,
      pollutants: {
        pm25: { value: pm25, unit: 'µg/m³', whoLimit: 15, ratio: whoExceedance.pm25Ratio, subIndex: epaSubIndices.pm25 },
        pm10: { value: pm10, unit: 'µg/m³', whoLimit: 45, ratio: whoExceedance.pm10Ratio, subIndex: epaSubIndices.pm10 },
        no2: { value: no2, unit: 'µg/m³', whoLimit: 25, ratio: whoExceedance.no2Ratio, subIndex: epaSubIndices.no2 },
        so2: { value: so2, unit: 'µg/m³', whoLimit: 40, ratio: whoExceedance.so2Ratio, subIndex: epaSubIndices.so2 },
        co: { value: co, unit: 'µg/m³', whoLimit: 4000, ratio: Math.round((co / 4000) * 100) / 100, subIndex: epaSubIndices.co },
        o3: { value: o3, unit: 'µg/m³', whoLimit: 100, ratio: whoExceedance.o3Ratio, subIndex: epaSubIndices.o3 },
        aod: { value: aod, unit: 'unitless (550nm)', rating: aod > 0.6 ? 'High Aerosol Haze' : 'Normal / Low' },
        dust: { value: dust, unit: 'µg/m³' }
      },
      pollutantConcentrationSource: 'Open-Meteo modeled hourly concentrations; not CPCB station measurements',
      meteorology: {
        boundaryLayerHeightMeters: boundaryLayerHgt,
        surfaceTemperatureC: temp2m,
        relativeHumidityPercent: rh2m,
        windSpeedMs: wind10m,
        windDirectionDeg: curWx.wind_direction_10m ?? null,
        surfacePressureHpa: pressureHpa,
        precipitationMm: curWx.precipitation ?? null,
        cloudCoverPercent: curWx.cloud_cover ?? null,
        shortwaveRadiation: curWx.shortwave_radiation ?? null,
        weatherCondition: weatherDesc.label,
        weatherIcon: weatherDesc.icon
      }
    },
    timezone: localDaily?.timezone || 'UTC',
    utcOffsetSeconds,
    hourly: {
      time: hourlyTime,
      pm25: hourlyPm25,
      pm10: hourlyPm10,
      usAqi: hourlyUsAqi,
      boundaryLayerHeight: hourlyPbl,
      windSpeed: hourlyWind.map(value => value == null ? null : Math.round(value / 3.6 * 10) / 10),
      temperature: hourlyTemp,
      precipProb: hourlyPrecip,
      relativeHumidity: (wx && wx.hourly && wx.hourly.relative_humidity_2m) || [],
      windDirection: (wx && wx.hourly && wx.hourly.wind_direction_10m) || [],
      surfacePressure: (wx && wx.hourly && wx.hourly.surface_pressure) || [],
      precipitation: (wx && wx.hourly && wx.hourly.precipitation) || [],
      cloudCover: (wx && wx.hourly && wx.hourly.cloud_cover) || [],
      shortwaveRadiation: (wx && wx.hourly && wx.hourly.shortwave_radiation) || [],
      weatherCode: (wx && wx.hourly && wx.hourly.weather_code) || []
    },
    dailyWeather: dailySummaryWeather
  };
}

// EPA AQI Linear Breakpoint Calculation Formula:
// I = ((I_high - I_low) / (C_high - C_low)) * (C - C_low) + I_low
function linearInterpolate(c, cLow, cHigh, iLow, iHigh, minimumIndex = iLow) {
  const index = Math.round(((iHigh - iLow) / (cHigh - cLow)) * (c - cLow) + iLow);
  return Math.min(iHigh, Math.max(minimumIndex, index));
}

// EPA PM2.5 Breakpoints (2024 revised standard)
function calculatePm25EpaSubIndex(c) {
  if (!Number.isFinite(c) || c < 0) return null;
  // EPA requires PM2.5 concentrations to be truncated (not rounded) to 0.1 µg/m³.
  c = Math.floor(c * 10 + 1e-8) / 10;
  if (c <= 9.0) return linearInterpolate(c, 0.0, 9.0, 0, 50);
  if (c <= 35.4) return linearInterpolate(c, 9.1, 35.4, 51, 100);
  if (c <= 55.4) return linearInterpolate(c, 35.5, 55.4, 101, 150);
  if (c <= 125.4) return linearInterpolate(c, 55.5, 125.4, 151, 200);
  if (c <= 225.4) return linearInterpolate(c, 125.5, 225.4, 201, 300);
  // EPA 2024 assigns AQI 301–500 to PM2.5 225.5–325.4 µg/m³.
  return linearInterpolate(Math.min(325.4, c), 225.5, 325.4, 301, 500);
}

// EPA PM10 Breakpoints
function calculatePm10EpaSubIndex(c) {
  if (c <= 54) return linearInterpolate(c, 0, 54, 0, 50);
  if (c <= 154) return linearInterpolate(c, 55, 154, 51, 100);
  if (c <= 254) return linearInterpolate(c, 155, 254, 101, 150);
  if (c <= 354) return linearInterpolate(c, 255, 354, 151, 200);
  if (c <= 424) return linearInterpolate(c, 355, 424, 201, 300);
  return linearInterpolate(Math.min(600, c), 425, 604, 301, 500);
}

// Calculate all US EPA sub-indices
export function calculateEpaSubIndices({ pm25, pm10, no2, so2, co, o3 }) {
  const idxPm25 = calculatePm25EpaSubIndex(pm25);
  const idxPm10 = Number.isFinite(pm10) && pm10 >= 0 ? calculatePm10EpaSubIndex(Math.floor(pm10)) : null;
  // Open-Meteo current gas concentrations are instantaneous µg/m³, while EPA
  // gas AQI needs pollutant-specific units and rolling averaging periods. Do not
  // invent gas sub-indices from those mismatched inputs.
  const idxNo2 = null;
  const idxO3 = null;

  const entries = [
    { name: 'PM2.5', value: idxPm25 },
    { name: 'PM10', value: idxPm10 },
    { name: 'NO2', value: idxNo2 },
    { name: 'O3', value: idxO3 }
  ];

  const available = entries.filter(entry => Number.isFinite(entry.value));
  available.sort((a, b) => b.value - a.value);

  return {
    pm25: idxPm25,
    pm25CappedAt500: Number.isFinite(pm25) && Math.floor(pm25 * 10 + 1e-8) / 10 > 325.4,
    pm10: idxPm10,
    no2: idxNo2,
    o3: idxO3,
    so2: null,
    co: null,
    maxAqi: available.length ? available[0].value : null,
    primaryPollutant: available.length ? available[0].name : null
  };
}

// Indian CPCB NAQI (National Air Quality Index) Breakpoints
function calculateBreakpointSubIndex(value, breakpoints) {
  if (!Number.isFinite(value) || value < 0) return null;
  let previousIndex = breakpoints[0][2];
  for (const [low, high, indexLow, indexHigh] of breakpoints) {
    if (value <= high) return linearInterpolate(value, low, high, indexLow, indexHigh, previousIndex);
    previousIndex = indexHigh;
  }
  const [low, high, indexLow, indexHigh] = breakpoints.at(-1);
  return linearInterpolate(Math.min(value, high), low, high, indexLow, indexHigh, previousIndex);
}

export function calculateIndiaNaqiSubIndices({ pm25, pm10, no2 }, quality = {}) {
  const subIndices = {
    pm25: calculateBreakpointSubIndex(pm25, [
      [0, 30, 0, 50], [31, 60, 51, 100], [61, 90, 101, 200],
      [91, 120, 201, 300], [121, 250, 301, 400], [250, 500, 401, 500],
    ]),
    pm10: calculateBreakpointSubIndex(pm10, [
      [0, 50, 0, 50], [51, 100, 51, 100], [101, 250, 101, 200],
      [251, 350, 201, 300], [351, 430, 301, 400], [430, 600, 401, 500],
    ]),
    no2: calculateBreakpointSubIndex(no2, [
      [0, 40, 0, 50], [41, 80, 51, 100], [81, 180, 101, 200],
      [181, 280, 201, 300], [281, 400, 301, 400], [400, 800, 401, 500],
    ]),
  };
  const hasParticulate = Number.isFinite(pm25) && pm25 >= 0 || Number.isFinite(pm10) && pm10 >= 0;
  const available = Object.entries(subIndices).filter(([, value]) => Number.isFinite(value));
  available.sort((a, b) => b[1] - a[1]);
  const primaryNames = { pm25: 'PM2.5', pm10: 'PM10', no2: 'NO₂' };
  const validPollutantCount = available.length;
  const averagingValid = quality.averagingHours === 24 && Number(quality.validHours) >= 16 && quality.dataQualityValid === true;
  const sufficient = validPollutantCount >= 3 && hasParticulate && averagingValid;
  const indicativeAqi = hasParticulate && available.length ? available[0][1] : null;
  const reasons = [];
  if (validPollutantCount < 3) reasons.push(`Requires at least three valid pollutants; found ${validPollutantCount}.`);
  if (!hasParticulate) reasons.push('At least PM2.5 or PM10 is required.');
  if (quality.averagingHours !== 24) reasons.push('Valid 24-hour pollutant averages are unavailable.');
  if (!(Number(quality.validHours) >= 16)) reasons.push('At least 16 valid hourly observations are required.');
  if (quality.dataQualityValid !== true) reasons.push('CPCB measurement quality has not been verified.');
  return {
    ...subIndices,
    maxAqi: indicativeAqi,
    indicativeAqi,
    officialAqi: sufficient ? indicativeAqi : null,
    status: sufficient ? 'official' : 'insufficient_data',
    validPollutantCount,
    hasParticulate,
    reasons: sufficient ? [] : reasons,
    primaryPollutant: indicativeAqi != null ? primaryNames[available[0][0]] : null,
  };
}

export function assessCpcbSubIndexSufficiency(subIndices, quality = {}) {
  const values = Object.entries(subIndices || {}).filter(([, value]) => Number.isFinite(value) && value >= 0 && value <= 500);
  const hasParticulate = ['PM2.5', 'PM10', 'pm25', 'pm10'].some(key => Number.isFinite(subIndices?.[key]) && subIndices[key] >= 0 && subIndices[key] <= 500);
  const averagingValid = quality.averagingHours === 24 && Number(quality.validHours) >= 16 && quality.dataQualityValid === true;
  const sufficient = values.length >= 3 && hasParticulate && averagingValid;
  return {
    validPollutantCount: values.length,
    hasParticulate,
    averagingValid,
    sufficient,
    reasons: [
      ...(values.length < 3 ? [`Requires at least three valid pollutants; found ${values.length}.`] : []),
      ...(!hasParticulate ? ['At least PM2.5 or PM10 is required.'] : []),
      ...(!averagingValid ? ['Verified 24-hour averages with at least 16 valid hours are unavailable.'] : []),
    ],
  };
}

export function getAqiCategory(aqi) {
  if (!Number.isFinite(aqi) || aqi < 0) return { label: 'Unavailable', code: 'unavailable' };
  if (aqi <= 50) return { label: 'Good', code: 'good', color: '#10b981', textColor: '#064e3b' };
  if (aqi <= 100) return { label: 'Moderate', code: 'moderate', color: '#f59e0b', textColor: '#78350f' };
  if (aqi <= 150) return { label: 'Unhealthy for Sensitive Groups', code: 'unhealthy-sensitive', color: '#f97316', textColor: '#7c2d12' };
  if (aqi <= 200) return { label: 'Unhealthy', code: 'unhealthy', color: '#ef4444', textColor: '#7f1d1d' };
  if (aqi <= 300) return { label: 'Very Unhealthy', code: 'very-unhealthy', color: '#a855f7', textColor: '#4c1d95' };
  return { label: 'Hazardous', code: 'hazardous', color: '#881337', textColor: '#ffe4e6' };
}


export function getIndiaAqiCategory(aqi) {
  if (!Number.isFinite(aqi) || aqi < 0) {
    return { label: 'Unavailable', code: 'unavailable' };
  }

  if (aqi <= 50) return { label: 'Good', code: 'india-good' };
  if (aqi <= 100) return { label: 'Satisfactory', code: 'india-satisfactory' };
  if (aqi <= 200) return { label: 'Moderate', code: 'india-moderate' };
  if (aqi <= 300) return { label: 'Poor', code: 'india-poor' };
  if (aqi <= 400) return { label: 'Very Poor', code: 'india-very-poor' };
  return { label: 'Severe', code: 'india-severe' };
}



  

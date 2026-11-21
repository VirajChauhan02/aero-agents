  import { decodeWeatherCode } from './aqiService.js';

  export async function runAnalysisPipeline(location, coordinates) {
    // Multi-agent orchestration lives in agents/coordinator.js
    const { runCoordinator } = await import('../agents/coordinator.js');
    return runCoordinator(location, coordinates, { buildAbstract: makeResearchAbstract });
  }

  export function buildProviderForecast(aqi, city, modelError = null) {
    const series = aqi.hourly || {};
    const now = Date.parse(aqi.current?.time || new Date().toISOString());
    const weatherRows = (series.time || []).map((time, index) => {
      const timestamp = Date.parse(time);
      if (!Number.isFinite(timestamp)) return null;
      return {
        timestamp,
        sourceIndex: index,
        date: new Date(timestamp + (aqi.utcOffsetSeconds || 0) * 1000).toISOString().slice(0, 10),
        temperature: series.temperature?.[index] ?? null,
        humidity: series.relativeHumidity?.[index] ?? null,
        wind: series.windSpeed?.[index] ?? null,
        precipitation: series.precipitation?.[index] ?? null,
        rainProbability: series.precipProb?.[index] ?? null,
        cloud: series.cloudCover?.[index] ?? null,
        pressure: series.surfacePressure?.[index] ?? null,
        code: series.weatherCode?.[index] ?? null,
      };
    }).filter(Boolean);

    // Keep only genuine future AQI observations returned by the provider.
    // Null/missing provider values are not converted to zero.
    const rows = weatherRows.map((weather, index) => {
      const timestamp = weather.timestamp;
      if (timestamp <= now) return null;
      const aqiValue = series.usAqi?.[weather.sourceIndex];
      const pm25Value = series.pm25?.[weather.sourceIndex];
      if (aqiValue == null || pm25Value == null || aqiValue === '' || pm25Value === '' ||
          !Number.isFinite(Number(aqiValue)) || !Number.isFinite(Number(pm25Value))) return null;
      const decodedWeather = decodeWeatherCode(weather.code);
      const value = Number(aqiValue);
      return {
        timestamp: new Date(timestamp).toISOString(),
        horizonHours: Math.max(1, Math.round((timestamp - now) / 3600000)),
        displayTime: new Date(timestamp).toLocaleString('en-IN', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', hour12: false }) + ' UTC',
        date: weather.date,
        predictedAqi: Math.max(0, Math.min(500, Math.round(value))),
        predictedPm25: Math.max(0, Number(pm25Value)),
        predictedTemperatureC: weather.temperature,
        predictedHumidityPercent: weather.humidity,
        predictedWindSpeedMs: weather.wind,
        predictedPrecipitationMm: weather.precipitation,
        precipitationProbabilityPercent: weather.rainProbability,
        predictedCloudCoverPercent: weather.cloud,
        predictedSurfacePressureHpa: weather.pressure,
        weatherCondition: decodedWeather.label,
        weatherIcon: decodedWeather.icon,
        lowerBound95: null,
        upperBound95: null,
        pm25LowerBound95: null,
        pm25UpperBound95: null,
        aqiCategory: getProviderAqiCategory(value),
        categoryClass: getProviderAqiClass(value),
        primaryDriver: 'Open-Meteo provider forecast',
        forecastSource: 'Open-Meteo Air Quality API',
      };
    }).filter(Boolean).slice(0, 168);

    const aqiByDate = new Map();
    for (const row of rows) {
      if (!aqiByDate.has(row.date)) aqiByDate.set(row.date, []);
      aqiByDate.get(row.date).push(row);
    }
    const weatherDays = (aqi.dailyWeather || []).slice(0, 7);
    const dailySummary = weatherDays.map((day, index) => {
      const dayRows = aqiByDate.get(day.date) || [];
      const aqiValues = dayRows.map(row => row.predictedAqi);
      const pmValues = dayRows.map(row => row.predictedPm25);
      const dayWeather = weatherRows.filter(row => row.date === day.date);
      const humidity = dayWeather.map(row => row.humidity).filter(Number.isFinite);
      const winds = dayWeather.map(row => row.wind).filter(Number.isFinite);
      const rain = dayWeather.map(row => row.rainProbability).filter(Number.isFinite);
      const condition = day.weatherCondition || 'Unavailable';
      const avgAqi = aqiValues.length ? Math.round(aqiValues.reduce((a, b) => a + b, 0) / aqiValues.length) : null;
      return {
        dayIndex: index + 1,
        dayName: index === 0 ? 'Today' : index === 1 ? 'Tomorrow' : new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
        dateStr: new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' }),
        dateIso: `${day.date}T12:00:00Z`,
        avgAqi,
        minAqi: aqiValues.length ? Math.min(...aqiValues) : null,
        maxAqi: aqiValues.length ? Math.max(...aqiValues) : null,
        avgPm25: pmValues.length ? Number((pmValues.reduce((a, b) => a + b, 0) / pmValues.length).toFixed(1)) : null,
        aqiCategory: avgAqi == null ? 'AQI unavailable' : getProviderAqiCategory(avgAqi),
        categoryClass: avgAqi == null ? 'unavailable' : getProviderAqiClass(avgAqi),
        tempMax: day.tempMax ?? null,
        tempMin: day.tempMin ?? null,
        rainProb: day.rainProb ?? (rain.length ? Math.round(rain.reduce((a, b) => a + b, 0) / rain.length) : null),
        weatherCondition: condition,
        weatherIcon: day.weatherIcon || '🌤️',
        avgHumidityPercent: humidity.length ? Math.round(humidity.reduce((a, b) => a + b, 0) / humidity.length) : null,
        maxWindSpeedMs: day.windMax ?? (winds.length ? Number(Math.max(...winds).toFixed(1)) : null),
        totalPrecipitationMm: dayWeather.length ? Number(dayWeather.reduce((sum, row) => sum + (Number(row.precipitation) || 0), 0).toFixed(1)) : null,
        healthTip: avgAqi == null
          ? 'Weather forecast is available, but the AQI provider has no value for this date.'
          : 'AQI outlook supplied by Open-Meteo; this is not a city-specific ML prediction.',
        trend: 'provider forecast',
        forecastSource: avgAqi == null ? 'Weather API only; AQI unavailable' : 'Open-Meteo Air Quality API',
      };
    });

    return {
      modelType: 'Open-Meteo Air Quality Forecast',
      modelStatus: rows.length ? 'api_fallback' : 'unavailable',
      source: 'Open-Meteo Air Quality API',
      city,
      error: modelError,
      hourlyTrajectory: rows,
      dailySummary,
      forecastCoverage: {
        weatherDays: weatherDays.length,
        aqiDays: dailySummary.filter(day => day.avgAqi != null).length,
        aqiHourlyRecords: rows.length,
      },
      modelValidationMetrics: {
        architecture: 'Provider AQI forecast (not ML)',
        targetSource: 'Open-Meteo Air Quality API',
        rSquaredScore: null, rmse: null, mae: null, directionAccuracyPercent: null,
        persistenceMae: null, featureImportance: [], horizonMetrics: [],
        validationNote: 'Provider forecast; no local ML validation metrics are claimed.',
        weatherForecastSource: 'Open-Meteo Weather API',
      },
    };
  }

  function getProviderAqiCategory(value) {
    if (value <= 50) return 'Good';
    if (value <= 100) return 'Moderate';
    if (value <= 150) return 'Unhealthy for Sensitive Groups';
    if (value <= 200) return 'Unhealthy';
    if (value <= 300) return 'Very Unhealthy';
    return 'Hazardous';
  }
  function getProviderAqiClass(value) {
    if (value <= 50) return 'good';
    if (value <= 100) return 'moderate';
    if (value <= 150) return 'unhealthy-sensitive';
    if (value <= 200) return 'unhealthy';
    if (value <= 300) return 'very-unhealthy';
    return 'hazardous';
  }

  function makeResearchAbstract({ location, aqi, predictions }) {
    const current = aqi.current;
    const pm25 = current.pollutants.pm25.value;
    const validation = predictions.modelStatus === 'ready'
      ? `The city-specific AQI model uses a chronological holdout; reported holdout MAE is ${predictions.modelValidationMetrics.mae} AQI points and RMSE is ${predictions.modelValidationMetrics.rmse}.`
      : predictions.modelStatus === 'api_fallback'
        ? 'The 7-day AQI outlook is supplied by the Open-Meteo Air Quality forecast API because no city-specific trained model is available. These are provider forecasts, not local ML predictions.'
        : 'No AQI forecast is currently available.';
    return {
      title: `AQI and Weather Analysis: ${location.city}`,
      authors: ['Air Quality and Weather Research Platform'],
      abstractText: `Aero calculates a US EPA particulate AQI estimate of ${current.usAqi ?? 'unavailable'} (${current.category?.label || 'unavailable'}) from Open-Meteo modeled pollutant concentrations for ${location.city}; PM2.5 is ${pm25} µg/m³. Any India AQI derived from these modeled hourly concentrations is indicative only, not an official CPCB National AQI. Current weather is ${current.meteorology.weatherCondition} at ${current.meteorology.surfaceTemperatureC}°C, with wind speed ${current.meteorology.windSpeedMs} m/s. ${validation} When trained, the horizon-calibrated ML system predicts future AQI and weather from historical Open-Meteo data.`,
      keywords: ['AQI', 'Air Quality', 'Weather', 'Open-Meteo', 'XGBoost', 'Chronological Validation', location.city],
    };
  }

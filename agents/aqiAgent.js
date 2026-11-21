import { getWeatherValidationMetrics, runMLPrediction } from '../services/mlPredictionService.js';
import { buildProviderForecast } from '../services/analysisService.js';
import { runAgent } from './baseAgent.js';
import { ensureCityTraining } from '../services/mlPredictionService.js';

// Calls the trained XGBoost service; if no compatible model exists it falls back to the
// provider forecast and says so explicitly (never presented as ML).
export function aqiAgent(aqi, city, coordinates = null) {
  return runAgent({ name: 'AQI Agent', role: 'Combine pollutant + weather + temporal features and forecast AQI', dependsOn: ['Data Agent'] }, async () => {
    let predictions = await runMLPrediction(aqi, city, coordinates);
    let usedModel = predictions?.modelStatus === 'ready' && predictions.hourlyTrajectory?.length > 0;
    let training = { started: false };
    if (!usedModel) {
      try { training = ensureCityTraining(city, coordinates); } catch (error) { console.warn('[ML] Automatic training was not queued:', error.message); }
    }
    if (!predictions || !predictions.hourlyTrajectory?.length) {
      predictions = buildProviderForecast(aqi, city, predictions?.error || null);
      usedModel = false;
    }
    predictions.modelValidationMetrics ||= {};
    predictions.modelValidationMetrics.weatherValidationMetrics = getWeatherValidationMetrics(city, coordinates);
    return {
      output: predictions,
      summary: usedModel
        ? `City-specific XGBoost model, ${predictions.hourlyTrajectory.length} hourly points.`
        : `No trained model used (${predictions.modelStatus}); provider forecast, ${predictions.hourlyTrajectory?.length || 0} hourly points.`,
      notes: usedModel ? [] : ['Forecast is Open-Meteo provider output, not a local ML prediction.', ...(training.started ? ['India-only model training queued in the background.'] : [])],
    };
  });
}

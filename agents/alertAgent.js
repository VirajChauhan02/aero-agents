import { evaluateHealthAndAirQuality } from '../services/healthEpidemiology.js';
import { runAgent } from './baseAgent.js';

export const ALERT_RULES_VERSION = 'v3-multistation-cpcb';

function level(aqi) {
  if (aqi > 300) return { level: 'hazardous', label: 'Hazardous' };
  if (aqi > 200) return { level: 'very-unhealthy', label: 'Very Unhealthy' };
  if (aqi > 150) return { level: 'unhealthy', label: 'Unhealthy' };
  if (aqi > 100) return { level: 'sensitive', label: 'Unhealthy for Sensitive Groups' };
  return null;
}

function indiaLevel(aqi) {
  if (aqi > 400) return { level: 'severe', label: 'Severe' };
  if (aqi > 300) return { level: 'very-poor', label: 'Very Poor' };
  if (aqi > 200) return { level: 'poor', label: 'Poor' };
  if (aqi > 100) return { level: 'moderate', label: 'Moderate' };
  if (aqi > 50) return { level: 'satisfactory', label: 'Satisfactory' };
  return null;
}

// Versioned, explicit rules. Every message states its horizon, timestamp and forecast source.
export function alertAgent(aqi, predictions) {
  return runAgent({ name: 'Alert/Recommendation Agent', role: 'Turn forecast into alerts and precautions', dependsOn: ['AQI Agent'], optional: true }, async () => {
    const health = evaluateHealthAndAirQuality(aqi);
    const alerts = [];
    const isIndia = aqi.current.countryCode === 'IN';
    const currentValue = isIndia ? (aqi.current.liveAqi?.headlineAqi ?? aqi.current.indiaAqi ?? aqi.current.indiaIndicativeAqi) : aqi.current.usAqi;
    const now = isIndia ? indiaLevel(currentValue) : level(currentValue);
    if (now) alerts.push({
      horizonHours: 0,
      validAt: aqi.current.time,
      level: now.level,
      message: isIndia
        ? `${aqi.current.liveAqi?.selectedSource === 'cpcb_station_median' ? 'CPCB nearby-station median' : aqi.current.liveAqi?.selectedSource === 'cpcb_station' ? 'Reported CPCB station AQI' : 'Open-Meteo Model AQI'} ${currentValue} (${now.label}).`
        : `Current US AQI ${currentValue} (${now.label}).`,
      source: isIndia ? aqi.current.indiaAqiSource : 'Open-Meteo modeled PM concentrations',
    });
    const next24 = (predictions?.hourlyTrajectory || []).filter(r => r.horizonHours <= 24);
    if (next24.length) {
      const peak = next24.reduce((a, b) => (b.predictedAqi > a.predictedAqi ? b : a));
      const lv = level(peak.predictedAqi);
      if (lv) alerts.push({
        horizonHours: peak.horizonHours, validAt: peak.timestamp, level: lv.level,
        message: `Forecast peak US AQI ${peak.predictedAqi} (${lv.label}) about ${peak.horizonHours} h ahead.`,
        source: predictions.modelStatus === 'ready' ? 'City XGBoost model' : 'Open-Meteo provider forecast',
      });
    }
    const output = { ...health, alerts, rulesVersion: ALERT_RULES_VERSION, issuedAt: new Date().toISOString() };
    return { output, summary: alerts.length ? `${alerts.length} alert(s) raised.` : 'No alert thresholds exceeded.' };
  });
}

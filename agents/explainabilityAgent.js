import { runAgent } from './baseAgent.js';

// Two clearly separated explanation types. Neither is causal.
//  1) model drivers: global XGBoost feature importance (only when a trained model was used)
//  2) meteorological context: transparent rules on current weather (not model attribution)
export function explainabilityAgent(aqi, predictions) {
  return runAgent({ name: 'Explainability Agent', role: 'Explain drivers of the forecast', dependsOn: ['AQI Agent'], optional: true }, async () => {
    const met = aqi.current.meteorology;
    const context = [];
    if (met.boundaryLayerHeightMeters != null && met.boundaryLayerHeightMeters < 500) context.push('Low boundary-layer height (<500 m) limits vertical mixing, which tends to raise surface pollutant concentrations.');
    if (met.windSpeedMs != null && met.windSpeedMs < 2) context.push('Light wind (<2 m/s) gives weak horizontal dispersion.');
    if (met.relativeHumidityPercent != null && met.relativeHumidityPercent > 80) context.push('High humidity can favour secondary aerosol formation and haze.');
    if ((met.precipitationMm ?? 0) > 0.2) context.push('Current precipitation can wash out particulate matter.');
    if (!context.length) context.push('No unfavourable dispersion signal in the current weather.');

    const importance = predictions?.modelStatus === 'ready' ? predictions.modelValidationMetrics?.featureImportance : null;
    const drivers = Array.isArray(importance) && importance.length
      ? importance.slice(0, 5).map(item => ({ feature: item.feature, importance: item.importance }))
      : [];
    const output = {
      method: drivers.length ? 'XGBoost global feature importance (association, not causation)' : 'Rule-based meteorological context only (no trained model used)',
      modelDrivers: drivers,
      meteorologicalContext: context,
      caveat: 'These describe model associations / general atmospheric reasoning, not causal effects. SHAP values are not computed in this build.',
    };
    return { output, summary: drivers.length ? `Top driver: ${drivers[0].feature}.` : 'Context rules only.' };
  });
}

export function evaluateHealthAndAirQuality(aqiData) {
  const india = aqiData.current.countryCode === 'IN';
  const liveAqi = aqiData.current.liveAqi;
  const aqiValue = india ? (liveAqi?.headlineAqi ?? aqiData.current.indiaAqi ?? aqiData.current.indiaIndicativeAqi) : aqiData.current.usAqi;
  const liveSourceLabel = liveAqi?.selectedSource === 'cpcb_station_median' ? 'CPCB Nearby-Station Median' :
    liveAqi?.selectedSource === 'cpcb_station' ? 'CPCB Station AQI' : 'Open-Meteo Model AQI';
  const aqi = Number(aqiValue);
  const pm25Value = aqiData.current.pollutants.pm25.value;
  const pm25 = pm25Value == null ? Number.NaN : Number(pm25Value);
  if (!Number.isFinite(aqi)) {
    return {
      advisoryTone: 'unavailable',
      currentAqi: null,
      aqiStandard: india ? liveSourceLabel : 'US AQI',
      aqiStatus: 'Insufficient data',
      pm25MicrogramsPerCubicMeter: Number.isFinite(pm25) ? pm25 : null,
      vulnerableCohorts: [],
      guidanceNote: 'Current AQI is insufficient; follow local public-health advice.',
      engineeringMitigation: { recommendedCadrCfm: null, optimalVentilationTiming: 'Check current and forecast AQI before opening windows.' },
    };
  }
  const highRisk = india ? aqi > 300 : aqi > 200;
  const warning = india ? aqi > 200 : aqi > 150;
  const caution = aqi > 100;
  const advisoryTone = highRisk ? 'danger' : warning ? 'warning' : caution ? 'caution' : aqi > 50 ? 'moderate' : 'good';

  const vulnerableCohorts = [
    {
      group: 'Children and older adults',
      status: caution ? 'Take extra care' : 'Usual precautions',
      directive: warning ? 'Reduce prolonged or strenuous outdoor activity.' : caution ? 'Consider limiting prolonged outdoor activity.' : 'Follow local air-quality guidance.',
    },
    {
      group: 'People with asthma or heart and lung conditions',
      status: caution ? 'Take extra care' : 'Usual precautions',
      directive: warning ? 'Follow your care plan and reduce strenuous outdoor activity.' : 'Follow your care plan and monitor symptoms.',
    },
    {
      group: 'Outdoor workers and active people',
      status: warning ? 'Reduce strenuous exposure' : 'Check current conditions',
      directive: warning ? 'Take breaks indoors or reduce strenuous activity outdoors.' : 'Check the AQI before extended outdoor activity.',
    },
  ];

  return {
    advisoryTone,
    currentAqi: aqi,
    aqiStandard: india ? liveSourceLabel : 'US AQI',
    aqiStatus: india ? (liveAqi?.selectedSource === 'cpcb_station_median' ? 'Regional estimate from nearby reported stations' : liveAqi?.selectedSource === 'cpcb_station' ? 'Reported station reading' : 'Open-Meteo model estimate') : 'EPA particulate estimate',
    aqiCategory: india
      ? (liveAqi?.category?.label || (aqiData.current.indiaAqiStatus === 'official' ? aqiData.current.indiaCategory?.label : aqiData.current.indiaIndicativeCategory?.label))
      : aqiData.current.category?.label,
    pm25MicrogramsPerCubicMeter: pm25,
    vulnerableCohorts,
    guidanceNote: 'General guidance only. Follow local public-health advice and seek medical care for concerning symptoms.',
    engineeringMitigation: {
      recommendedCadrCfm: aqi > 100 ? Math.round((56 * ((india ? aqi > 300 : aqi > 200) ? 5 : 4) * 0.5886) * 1.2) : null,
      optimalVentilationTiming: 'Check current and forecast AQI before opening windows; choose a lower-AQI period.',
    },
  };
}

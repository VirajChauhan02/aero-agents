
"""Train horizon-conditioned XGBoost forecasts for Open-Meteo AQI and PM2.5.

Rows are kept on a continuous hourly time index. Forecast samples only use
information available at the forecast origin; validation is chronological and
purges the maximum forecast horizon at the train/test boundary.
"""

import json
import os
import sys
import warnings
from datetime import datetime

import joblib
import numpy as np
import pandas as pd
import xgboost as xgb

from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

warnings.filterwarnings("ignore")

ML_DIR = os.path.dirname(__file__)
DATA_DIR = os.path.join(ML_DIR, "data")
MODEL_DIR = os.path.join(ML_DIR, "models")
os.makedirs(MODEL_DIR, exist_ok=True)

LAGS = [0, 1, 2, 3, 6, 12, 24, 48, 72, 168]
ROLLING = [6, 24, 72]

TRAIN_HORIZONS = sorted(set([
    1, 3, 6, 12, 18, 24, 36, 48, 60, 72, 84,
    96, 108, 120, 132, 144, 156, 168
]))

EVAL_HORIZONS = [1, 6, 12, 24, 48, 72, 120, 168]

WEATHER_TARGETS = [
    "temperature_2m",
    "relative_humidity_2m",
    "wind_speed_10m",
    "precipitation",
    "cloud_cover",
    "surface_pressure",
]

WEATHER_LAGS = [1, 3, 6, 12, 24, 48, 72, 168]
WEATHER_ROLLING = [6, 24, 72]

WEATHER_COLUMNS = [
    "temperature_2m",
    "relative_humidity_2m",
    "wind_speed_10m",
    "wind_direction_10m",
    "surface_pressure",
    "precipitation",
    "cloud_cover",
    "boundary_layer_height",
    "shortwave_radiation",
]


def make_features(df):
    f = pd.DataFrame(index=df.index)
    idx = df.index

    f["hour_sin"] = np.sin(2 * np.pi * idx.hour / 24)
    f["hour_cos"] = np.cos(2 * np.pi * idx.hour / 24)
    f["weekday_sin"] = np.sin(2 * np.pi * idx.dayofweek / 7)
    f["weekday_cos"] = np.cos(2 * np.pi * idx.dayofweek / 7)
    f["year_day_sin"] = np.sin(2 * np.pi * idx.dayofyear / 365.25)
    f["year_day_cos"] = np.cos(2 * np.pi * idx.dayofyear / 365.25)

    for col in WEATHER_COLUMNS:
        if col in df:
            values = pd.to_numeric(df[col], errors="coerce")

            if col == "wind_speed_10m":
                values = values / 3.6

            elif col == "wind_direction_10m":
                radians = np.deg2rad(values)
                f["wind_dir_sin"] = np.sin(radians)
                f["wind_dir_cos"] = np.cos(radians)
                continue

            f[col] = values

    for col in WEATHER_TARGETS:
        if col not in df:
            continue

        values = pd.to_numeric(df[col], errors="coerce")

        if col == "wind_speed_10m":
            values = values / 3.6

        for lag in WEATHER_LAGS:
            f[f"{col}_lag{lag}"] = values.shift(lag)

        for window in WEATHER_ROLLING:
            roll = values.rolling(window, min_periods=window)
            f[f"{col}_roll{window}_mean"] = roll.mean()
            f[f"{col}_roll{window}_std"] = roll.std()

    for target in ["us_aqi", "pm2_5"]:
        values = pd.to_numeric(df[target], errors="coerce")

        for lag in LAGS:
            f[f"{target}_lag{lag}"] = values.shift(lag)

        for window in ROLLING:
            roll = values.rolling(window, min_periods=window)
            f[f"{target}_roll{window}_mean"] = roll.mean()
            f[f"{target}_roll{window}_std"] = roll.std()

        for lag in [1, 3, 6, 12]:
            f[f"{target}_change_{lag}h"] = (
                values - values.shift(lag)
            )

        mean_6 = values.rolling(6, min_periods=6).mean()
        mean_24 = values.rolling(24, min_periods=24).mean()
        mean_72 = values.rolling(72, min_periods=72).mean()

        f[f"{target}_trend_6h_24h"] = mean_6 - mean_24
        f[f"{target}_trend_24h_72h"] = mean_24 - mean_72

    return f.replace([np.inf, -np.inf], np.nan)


def make_pairs(features, target, horizons, origin_mask):
    xs, ys, hs, origins = [], [], [], []

    for horizon in horizons:
        future = target.shift(-horizon)

        valid = (
            origin_mask
            & features.notna().all(axis=1)
            & future.notna()
        )

        if not valid.any():
            continue

        x = features.loc[valid].to_numpy(dtype=np.float32)

        valid_times = features.index[valid] + pd.Timedelta(
            hours=horizon
        )

        calendar_features = {
            "hour_sin": np.sin(2 * np.pi * valid_times.hour / 24),
            "hour_cos": np.cos(2 * np.pi * valid_times.hour / 24),
            "weekday_sin": np.sin(
                2 * np.pi * valid_times.dayofweek / 7
            ),
            "weekday_cos": np.cos(
                2 * np.pi * valid_times.dayofweek / 7
            ),
            "year_day_sin": np.sin(
                2 * np.pi * valid_times.dayofyear / 365.25
            ),
            "year_day_cos": np.cos(
                2 * np.pi * valid_times.dayofyear / 365.25
            ),
        }

        for name, values in calendar_features.items():
            x[:, features.columns.get_loc(name)] = (
                values.astype(np.float32)
            )

        h_col = np.full((len(x), 1), horizon, dtype=np.float32)

        xs.append(np.concatenate([x, h_col], axis=1))

        ys.append(
            (future.loc[valid] - target.loc[valid]).to_numpy(
                dtype=np.float32
            )
        )

        hs.append(np.full(len(x), horizon, dtype=np.int16))
        origins.append(features.index[valid].to_numpy())

    if not xs:
        raise ValueError(
            "No valid forecast samples. Check AQI coverage and hourly continuity."
        )

    return (
        np.vstack(xs),
        np.concatenate(ys),
        np.concatenate(hs),
        np.concatenate(origins),
    )


def metric_pack(y_true, y_pred, origin_aqi):
    direction = (
        np.sign(y_true - origin_aqi)
        == np.sign(y_pred - origin_aqi)
    )

    return {
        "mae": round(
            float(mean_absolute_error(y_true, y_pred)), 3
        ),
        "rmse": round(
            float(np.sqrt(mean_squared_error(y_true, y_pred))), 3
        ),
        "r2": (
            round(float(r2_score(y_true, y_pred)), 4)
            if len(y_true) > 1 else None
        ),
        "direction_accuracy_percent": round(
            float(np.mean(direction) * 100), 2
        ),
        "persistence_mae": round(
            float(mean_absolute_error(y_true, origin_aqi)), 3
        ),
        "n": int(len(y_true)),
    }


def make_model(objective, weather_model=False, fast_mode=False):

    if fast_mode and not weather_model:
        return xgb.XGBRegressor(
            objective=objective,
            n_estimators=120,
            max_depth=4,
            learning_rate=0.06,
            subsample=0.85,
            colsample_bytree=0.85,
            reg_alpha=0.1,
            reg_lambda=3.0,
            min_child_weight=8,
            tree_method="hist",
            n_jobs=-1,
            random_state=42,
        )

    if weather_model:
        return xgb.XGBRegressor(
            objective="reg:squarederror",
            n_estimators=180,
            max_depth=5,
            learning_rate=0.045,
            subsample=0.85,
            colsample_bytree=0.85,
            reg_alpha=0.1,
            reg_lambda=3.0,
            min_child_weight=8,
            tree_method="hist",
            n_jobs=-1,
            random_state=42,
        )

    if objective == "reg:absoluteerror":
        return xgb.XGBRegressor(
            objective=objective,
            n_estimators=450,
            max_depth=5,
            learning_rate=0.04,
            subsample=0.85,
            colsample_bytree=0.85,
            reg_alpha=0.1,
            reg_lambda=3.0,
            min_child_weight=8,
            tree_method="hist",
            n_jobs=-1,
            random_state=42,
        )

    return xgb.XGBRegressor(
        objective=objective,
        n_estimators=350,
        max_depth=6,
        learning_rate=0.045,
        subsample=0.85,
        colsample_bytree=0.85,
        reg_alpha=0.1,
        reg_lambda=2.0,
        min_child_weight=5,
        tree_method="hist",
        n_jobs=-1,
        random_state=42,
    )


def origin_values(target, origins):
    return target.reindex(
        pd.DatetimeIndex(origins)
    ).to_numpy(dtype=float)


def target_bounds(target_name):
    return {
        "us_aqi": (0, 500),
        "pm2_5": (0, 500),
        "temperature_2m": (-60, 60),
        "relative_humidity_2m": (0, 100),
        "wind_speed_10m": (0, 100),
        "precipitation": (0, 100),
        "cloud_cover": (0, 100),
        "surface_pressure": (800, 1100),
    }.get(target_name, (None, None))


def clip_target(values, bounds):
    return (
        np.clip(values, *bounds)
        if bounds[0] is not None else values
    )


def tune_correction_scales(
    y_delta, y_origin, horizons, model_delta, bounds
):
    scales = {}

    for horizon in EVAL_HORIZONS:
        mask = horizons == horizon

        if not mask.any():
            continue

        actual = y_origin[mask] + y_delta[mask]

        best = min(
            (0.0, 1.0),
            key=lambda scale: mean_absolute_error(
                actual,
                clip_target(
                    y_origin[mask] + model_delta[mask] * scale,
                    bounds
                )
            ),
        )

        best_mae = mean_absolute_error(
            actual,
            clip_target(
                y_origin[mask] + model_delta[mask] * best,
                bounds
            )
        )

        for scale in np.arange(0.05, 1.001, 0.05):
            score = mean_absolute_error(
                actual,
                clip_target(
                    y_origin[mask] + model_delta[mask] * scale,
                    bounds
                )
            )

            if score < best_mae - 1e-9:
                best = float(scale)
                best_mae = float(score)

        scales[str(horizon)] = round(float(best), 2)

    return scales


def scale_for_horizon(scales, horizon):
    keys = sorted(int(key) for key in scales)

    if not keys:
        return 1.0

    left = max(
        (key for key in keys if key <= horizon),
        default=keys[0]
    )

    right = min(
        (key for key in keys if key >= horizon),
        default=keys[-1]
    )

    if left == right:
        return float(scales[str(left)])

    weight = (horizon - left) / (right - left)

    return (
        float(scales[str(left)])
        + (
            float(scales[str(right)])
            - float(scales[str(left)])
        ) * weight
    )


def metadata_feature_names(features):
    return list(features.columns) + ["forecast_horizon_hours"]


def train_target(
    city, df, features, target_name, key, fast_mode=False
):
    target = pd.to_numeric(
        df[target_name], errors="coerce"
    )

    if target_name == "wind_speed_10m":
        target = target / 3.6

    weather_model = target_name in WEATHER_TARGETS
    bounds = target_bounds(target_name)

    training_horizons = (
        EVAL_HORIZONS if weather_model else TRAIN_HORIZONS
    )

    available = target.notna()
    valid_times = df.index[available]

    if len(valid_times) < 24 * 60:
        raise ValueError(
            f"Only {len(valid_times)} valid {target_name} rows; "
            "at least 1,440 are required."
        )

    test_start = valid_times.max() - pd.Timedelta(days=90)
    validation_start = test_start - pd.Timedelta(days=90)

    purge_hours = max(TRAIN_HORIZONS)

    validation_train_end = (
        validation_start - pd.Timedelta(hours=purge_hours)
    )

    test_train_end = (
        test_start - pd.Timedelta(hours=purge_hours)
    )

    train_mask = (
        (df.index < validation_train_end) & available
    )

    validation_mask = (
        (df.index >= validation_start)
        & (df.index < test_train_end)
        & available
    )

    final_train_mask = (
        (df.index < test_train_end) & available
    )

    test_mask = (
        (df.index >= test_start) & available
    )

    train_x, train_y, _, _ = make_pairs(
        features, target, training_horizons, train_mask
    )

    validation_x, validation_y, validation_h, validation_origins = (
        make_pairs(
            features, target, EVAL_HORIZONS, validation_mask
        )
    )

    test_x, test_y, test_h, test_origins = make_pairs(
        features, target, EVAL_HORIZONS, test_mask
    )

    if len(validation_y) < 100:
        raise ValueError(
            f"Insufficient validation {target_name} samples "
            f"({len(validation_y)})."
        )

    if len(test_y) < 100:
        raise ValueError(
            f"Insufficient held-out {target_name} samples "
            f"({len(test_y)})."
        )

    validation_origin = origin_values(
        target, validation_origins
    )

    candidate_results = []
    best_candidate = None

    objectives = (
        ("reg:squarederror",)
        if weather_model
        else ("reg:squarederror", "reg:absoluteerror")
    )

    for objective in objectives:
        candidate = make_model(
            objective,
            weather_model,
            fast_mode=fast_mode
        )

        candidate.fit(train_x, train_y, verbose=False)

        validation_delta = candidate.predict(
            validation_x
        ).astype(float)

        scales = tune_correction_scales(
            validation_y,
            validation_origin,
            validation_h,
            validation_delta,
            bounds
        )

        validation_pred = np.array([
            clip_target(
                origin + delta * scale_for_horizon(
                    scales, int(horizon)
                ),
                bounds
            )
            for origin, delta, horizon in zip(
                validation_origin,
                validation_delta,
                validation_h
            )
        ])

        validation_actual = (
            validation_y.astype(float) + validation_origin
        )

        validation_score = float(
            mean_absolute_error(
                validation_actual, validation_pred
            )
        )

        candidate_results.append({
            "objective": objective,
            "validation_mae": round(validation_score, 3),
            "correction_scales_by_horizon": scales,
        })

        if (
            best_candidate is None
            or validation_score < best_candidate["validation_mae"]
        ):
            best_candidate = {
                "objective": objective,
                "validation_mae": validation_score,
                "scales": scales,
            }

        del candidate

    final_x, final_y, _, _ = make_pairs(
        features, target, training_horizons, final_train_mask
    )

    model = make_model(
        best_candidate["objective"],
        weather_model,
        fast_mode=fast_mode
    )

    model.fit(final_x, final_y, verbose=False)

    origin_target = origin_values(target, test_origins)

    y_true = test_y.astype(float) + origin_target

    predicted_delta = model.predict(test_x).astype(float)

    pred = np.array([
        clip_target(
            origin + delta * scale_for_horizon(
                best_candidate["scales"], int(horizon)
            ),
            bounds
        )
        for origin, delta, horizon in zip(
            origin_target, predicted_delta, test_h
        )
    ])

    horizon_metrics = {}
    residuals_by_horizon = {}

    for h in EVAL_HORIZONS:
        mask = test_h == h

        if not mask.any():
            continue

        vals = metric_pack(
            y_true[mask],
            pred[mask],
            origin_target[mask]
        )

        horizon_metrics[str(h)] = vals

        residuals_by_horizon[str(h)] = {
            "lower": round(
                float(np.quantile(
                    y_true[mask] - pred[mask], 0.025
                )),
                3
            ),
            "upper": round(
                float(np.quantile(
                    y_true[mask] - pred[mask], 0.975
                )),
                3
            ),
        }

    metadata = {
        "model_version": 5,
        "city": city,
        "target": target_name,
        "target_source": (
            "Open-Meteo Historical Weather API"
            if weather_model
            else "Open-Meteo Air Quality API"
        ),
        "model_type": (
            f"Horizon-calibrated XGBoost "
            f"({best_candidate['objective']})"
        ),
        "trained_at": datetime.utcnow().isoformat(
            timespec="seconds"
        ) + "Z",
        "feature_names": metadata_feature_names(features),
        "train_pair_count": int(len(final_y)),
        "test_pair_count": int(len(test_y)),
        "validation_pair_count": int(len(validation_y)),
        "train_end": str(test_train_end),
        "validation_start": str(validation_start),
        "test_start": str(test_start),
        "validation_method": (
            "Chronological train/validation/test split; "
            "90-day validation and test windows with "
            "168-hour purge; no random split"
        ),
        "validation_model_selection": {
            "selected_objective": best_candidate["objective"],
            "selected_validation_mae": round(
                float(best_candidate["validation_mae"]), 3
            ),
            "candidate_results": candidate_results,
        },
        "correction_scales_by_horizon": best_candidate["scales"],
        "horizon_metrics": horizon_metrics,
        "residual_quantiles_by_horizon": residuals_by_horizon,
        "aggregate_validation": metric_pack(
            y_true, pred, origin_target
        ),
        "feature_importance": sorted(
            [
                {
                    "feature": name,
                    "importance": round(float(value), 6)
                }
                for name, value in zip(
                    metadata_feature_names(features),
                    model.feature_importances_
                )
            ],
            key=lambda item: item["importance"],
            reverse=True
        )[:20],
    }

    model_path = os.path.join(
        MODEL_DIR, f"{key}_{target_name}_xgb.joblib"
    )

    metadata_path = os.path.join(
        MODEL_DIR, f"{key}_{target_name}_metadata.json"
    )

    # Final protection: never overwrite an existing model.
    if os.path.exists(model_path):
        raise FileExistsError(
            f"Model already exists; refusing to overwrite: {model_path}"
        )

    joblib.dump(model, model_path)

    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    return metadata


def train(city="Delhi", fast_mode=False):
    key = city.lower().replace(" ", "_")

    csv_path = os.path.join(
        DATA_DIR, f"{key}_historical.csv"
    )

    if not os.path.exists(csv_path):
        raise FileNotFoundError(
            f"No data found for {city}. "
            f"Run fetch_data.py {city} first."
        )

    raw = pd.read_csv(csv_path, low_memory=False)

    if "time" not in raw or "us_aqi" not in raw:
        raise ValueError(
            "Historical data must contain time and us_aqi columns."
        )

    raw["time"] = pd.to_datetime(
        raw["time"], errors="coerce", utc=True
    ).dt.tz_convert(None)

    raw = (
        raw.dropna(subset=["time"])
        .sort_values("time")
        .drop_duplicates("time", keep="last")
        .set_index("time")
    )

    hourly_index = pd.date_range(
        raw.index.min().floor("h"),
        raw.index.max().floor("h"),
        freq="h"
    )

    df = raw.reindex(hourly_index)
    df.index.name = "time"

    features = make_features(df)

    progress_path = os.path.join(
        DATA_DIR, f"{key}_progress.json"
    )

    def progress(phase, percent, detail):
        with open(progress_path, "w", encoding="utf-8") as f:
            json.dump({
                "phase": phase,
                "percent": percent,
                "detail": detail,
                "updated_at": datetime.utcnow().isoformat() + "Z"
            }, f)

    aqi_model_path = os.path.join(
        MODEL_DIR, f"{key}_us_aqi_xgb.joblib"
    )

    pm_model_path = os.path.join(
        MODEL_DIR, f"{key}_pm2_5_xgb.joblib"
    )

    aqi_meta_path = os.path.join(
        MODEL_DIR, f"{key}_us_aqi_metadata.json"
    )

    pm_meta_path = os.path.join(
        MODEL_DIR, f"{key}_pm2_5_metadata.json"
    )

    def load_existing(model_path, metadata_path, target):
        if not os.path.isfile(model_path) or os.path.getsize(model_path) == 0:
            raise FileNotFoundError(f"Existing {target} model is empty or missing.")
        if not os.path.isfile(metadata_path):
            raise FileNotFoundError(f"Existing {target} metadata missing; refusing to overwrite the model.")
        with open(metadata_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        if (meta.get("model_version") != 5 or meta.get("target") != target
                or not meta.get("feature_names")
                or not isinstance(meta.get("aggregate_validation"), dict)):
            raise ValueError(f"Existing {target} metadata is incompatible; refusing to mark the city ready.")
        return meta

    if os.path.exists(aqi_model_path):
        print("[SKIP] Existing AQI model protected.")
        aqi_meta = load_existing(aqi_model_path, aqi_meta_path, "us_aqi")

    else:
        progress(
            "training_aqi",
            10,
            "Training AQI forecast model"
        )

        aqi_meta = train_target(
            city,
            df,
            features,
            "us_aqi",
            key,
            fast_mode=fast_mode
        )

    if os.path.exists(pm_model_path):
        print("[SKIP] Existing PM2.5 model protected.")
        pm_meta = load_existing(pm_model_path, pm_meta_path, "pm2_5")

    else:
        progress(
            "training_pm25",
            55,
            "Training PM2.5 forecast model"
        )

        pm_meta = train_target(
            city,
            df,
            features,
            "pm2_5",
            key,
            fast_mode=fast_mode
        )

    summary = {
        "model_version": 5,
        "city": city,
        "trained_at": aqi_meta["trained_at"],
        "model_type": aqi_meta["model_type"],
        "target_source": aqi_meta["target_source"],
        "aqi": aqi_meta["aggregate_validation"],
        "pm25": pm_meta["aggregate_validation"],
        "weather_forecast_source": (
            "Open-Meteo Weather Forecast API "
            "(no separate local weather models)"
        ),
        "horizon_metrics": aqi_meta["horizon_metrics"],
        "validation_method": aqi_meta["validation_method"],
        "train_pair_count": aqi_meta["train_pair_count"],
        "test_pair_count": aqi_meta["test_pair_count"],
        "feature_importance": aqi_meta["feature_importance"],
    }

    with open(
        os.path.join(MODEL_DIR, f"{key}_metadata.json"),
        "w",
        encoding="utf-8"
    ) as f:
        json.dump(summary, f, indent=2)

    progress(
        "complete",
        100,
        f"AQI MAE {summary['aqi']['mae']} | "
        f"PM2.5 MAE {summary['pm25']['mae']}"
    )

    print(json.dumps(summary, indent=2))

    return summary


if __name__ == "__main__":
    try:
        city_args = [
            arg for arg in sys.argv[1:]
            if not arg.startswith("--")
        ]

        train(
            city_args[0] if city_args else "Delhi",
            fast_mode="--fast" in sys.argv
        )

    except Exception as exc:
        print(f"[TRAIN ERROR] {exc}", file=sys.stderr)
        sys.exit(1)

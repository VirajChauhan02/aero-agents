
import json
import os
import sys

import joblib
import numpy as np
import pandas as pd

from train_model import (
    EVAL_HORIZONS,
    make_features,
    make_pairs,
    origin_values,
    scale_for_horizon,
    target_bounds,
    clip_target,
)

ML_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ML_DIR, "data")
MODEL_DIR = os.path.join(ML_DIR, "models")


def diagnose(city="Mumbai"):
    key = city.lower().replace(" ", "_")

    csv_path = os.path.join(DATA_DIR, f"{key}_historical.csv")
    model_path = os.path.join(
        MODEL_DIR, f"{key}_us_aqi_xgb.joblib"
    )
    metadata_path = os.path.join(
        MODEL_DIR, f"{key}_us_aqi_metadata.json"
    )

    for path in [csv_path, model_path, metadata_path]:
        if not os.path.exists(path):
            raise FileNotFoundError(f"File not found: {path}")

    print("Loading historical data...")
    raw = pd.read_csv(csv_path, low_memory=False)

    raw["time"] = (
        pd.to_datetime(raw["time"], errors="coerce", utc=True)
        .dt.tz_convert(None)
    )

    raw = (
        raw.dropna(subset=["time"])
        .sort_values("time")
        .drop_duplicates("time", keep="last")
        .set_index("time")
    )

    hourly_index = pd.date_range(
        raw.index.min().floor("h"),
        raw.index.max().floor("h"),
        freq="h",
    )

    df = raw.reindex(hourly_index)
    df.index.name = "time"

    target = pd.to_numeric(df["us_aqi"], errors="coerce")
    available = target.notna()

    valid_times = df.index[available]

    test_start = valid_times.max() - pd.Timedelta(days=90)
    test_mask = (df.index >= test_start) & available

    print("Generating features...")
    features = make_features(df)

    print("Preparing test samples...")
    test_x, test_y, test_h, test_origins = make_pairs(
        features,
        target,
        EVAL_HORIZONS,
        test_mask,
    )

    origins = pd.DatetimeIndex(test_origins)
    origin_aqi = origin_values(target, test_origins)

    actual = test_y.astype(float) + origin_aqi

    print("Loading existing XGBoost model...")
    model = joblib.load(model_path)

    with open(metadata_path, "r", encoding="utf-8") as f:
        metadata = json.load(f)

    scales = metadata["correction_scales_by_horizon"]
    bounds = target_bounds("us_aqi")

    print("Generating predictions...")
    predicted_delta = model.predict(test_x).astype(float)

    predicted = np.array([
        clip_target(
            origin + delta * scale_for_horizon(scales, int(horizon)),
            bounds,
        )
        for origin, delta, horizon in zip(
            origin_aqi, predicted_delta, test_h
        )
    ])

    # Assign each forecast to the month it predicts.
    target_times = origins + pd.to_timedelta(test_h, unit="h")

    results = pd.DataFrame({
        "target_time": target_times,
        "horizon_hours": test_h,
        "actual_aqi": actual,
        "predicted_aqi": predicted,
        "persistence_aqi": origin_aqi,
    })

    results["target_month"] = (
        pd.to_datetime(results["target_time"])
        .dt.strftime("%Y-%m")
    )

    results["absolute_error"] = (
        results["actual_aqi"] - results["predicted_aqi"]
    ).abs()

    results["persistence_error"] = (
        results["actual_aqi"] - results["persistence_aqi"]
    ).abs()

    results["prediction_bias"] = (
        results["predicted_aqi"] - results["actual_aqi"]
    )

    # Monthly metrics for each forecast horizon.
    monthly = (
        results.groupby(["horizon_hours", "target_month"])
        .agg(
            records=("actual_aqi", "size"),
            actual_mean=("actual_aqi", "mean"),
            predicted_mean=("predicted_aqi", "mean"),
            model_mae=("absolute_error", "mean"),
            persistence_mae=("persistence_error", "mean"),
            prediction_bias=("prediction_bias", "mean"),
        )
        .reset_index()
    )

    monthly["model_mae"] = monthly["model_mae"].round(3)
    monthly["persistence_mae"] = monthly["persistence_mae"].round(3)
    monthly["prediction_bias"] = monthly["prediction_bias"].round(3)
    monthly["actual_mean"] = monthly["actual_mean"].round(2)
    monthly["predicted_mean"] = monthly["predicted_mean"].round(2)

    monthly_path = os.path.join(
        DATA_DIR, f"{key}_monthly_test_diagnostics.csv"
    )

    monthly.to_csv(monthly_path, index=False)

    # Overall metrics for each horizon, for comparison.
    summary = (
        results.groupby("horizon_hours")
        .agg(
            records=("actual_aqi", "size"),
            model_mae=("absolute_error", "mean"),
            persistence_mae=("persistence_error", "mean"),
            prediction_bias=("prediction_bias", "mean"),
        )
        .reset_index()
    )

    summary = summary.round(3)

    summary_path = os.path.join(
        DATA_DIR, f"{key}_horizon_test_diagnostics.csv"
    )

    summary.to_csv(summary_path, index=False)

    print("\n===== TEST PERIOD =====")
    print("Test start:", test_start)
    print("Test end:", valid_times.max())
    print("Total prediction samples:", len(results))

    print("\n===== HORIZON SUMMARY =====")
    print(summary.to_string(index=False))

    print("\n===== MONTHLY RESULTS =====")
    print(monthly.to_string(index=False))

    print("\nSaved files:")
    print(monthly_path)
    print(summary_path)


if __name__ == "__main__":
    city = sys.argv[1] if len(sys.argv) > 1 else "Mumbai"

    try:
        diagnose(city)
    except Exception as exc:
        print(f"\n[DIAGNOSTIC ERROR] {exc}")
        sys.exit(1)

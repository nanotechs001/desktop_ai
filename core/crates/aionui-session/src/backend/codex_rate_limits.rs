//! codex `account/rateLimits/*` → [`SessionEvent::RateLimitInfo`], the same
//! event the claude adapter emits, so a ChatGPT-login codex session feeds the
//! renderer's subscription usage ring.
//!
//! Wire shape, verified against openai/codex main (2026-10-21):
//! - `codex-rs/app-server-protocol/src/protocol/v2/account.rs`: the
//!   `account/rateLimits/read` response is `{rateLimits: RateLimitSnapshot, …}`;
//!   the `account/rateLimits/updated` notification is `{rateLimits}`, a "sparse
//!   rolling update" whose nullable values "do not clear a previously observed
//!   value". `RateLimitSnapshot{primary?, secondary?, planType?,
//!   rateLimitReachedType?, …}`, `RateLimitWindow{usedPercent: i32 (0-100),
//!   windowDurationMins?, resetsAt?}`. Every `Option` serializes as `null`.
//! - `codex-rs/protocol/src/protocol.rs`: `resets_at` is "Unix timestamp
//!   (seconds since epoch)".
//!
//! Read defensively: a missing or mistyped value is skipped, never a panic.

use std::ops::RangeInclusive;

use serde_json::{Value, json};

use crate::event::{RateLimitStatus, RateLimitWindow, RateLimitWindowKind, SessionEvent};

/// JSON-RPC id of our usage reads. A string, so it never collides with the
/// backend's numeric request counter, and the reader can claim the response
/// without a correlation map.
pub(super) const READ_ID: &str = "aionui-rate-limits-read";

const FIVE_HOUR_MINS: RangeInclusive<i64> = 240..=360;
const SEVEN_DAY_MINS: RangeInclusive<i64> = 9000..=11000;
const WARNING_FRACTION: f64 = 0.9;
/// Epoch seconds stay below this until the year 33658; a larger value is milliseconds.
const EPOCH_MS_FLOOR: u64 = 1_000_000_000_000;

/// The `account/rateLimits/read` request frame. Older servers ignore the
/// unknown params.
pub(super) fn read_request() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": READ_ID,
        "method": "account/rateLimits/read",
        "params": { "supportsLunaReserve": false, "excludeResetCreditDetails": true },
    })
}

/// The snapshot after an `account/rateLimits/updated` notification, or None
/// when the update is for another limit than the snapshot's (the read's
/// `rateLimits` is the main one). Its nulls never clear a value, so a reached
/// limit is cleared here once an update without a reached type brings every
/// window back under 100%.
pub(super) fn apply_update(last: &Value, update: &Value) -> Option<Value> {
    let limit_id = |v: &Value| v.get("limitId").and_then(Value::as_str).map(str::to_owned);
    if let (Some(ours), Some(theirs)) = (limit_id(last), limit_id(update))
        && ours != theirs
    {
        return None;
    }
    let mut merged = merge(last, update);
    let window_keys = ["primary", "secondary"];
    let update_has_window = window_keys.iter().any(|k| update.get(k).is_some_and(Value::is_object));
    let update_reached = update.get("rateLimitReachedType").is_some_and(|t| !t.is_null());
    let all_below_full = window_keys.iter().all(|k| {
        merged
            .get(k)
            .and_then(|w| w.get("usedPercent"))
            .and_then(Value::as_f64)
            .is_none_or(|p| p < 100.0)
    });
    if update_has_window
        && !update_reached
        && all_below_full
        && let Some(obj) = merged.as_object_mut()
    {
        obj.remove("rateLimitReachedType");
    }
    Some(merged)
}

/// Merge a sparse update into the last snapshot: objects merge key by key, and
/// a null or absent value keeps the old one.
fn merge(last: &Value, update: &Value) -> Value {
    match (last, update) {
        (Value::Object(old), Value::Object(new)) => {
            let mut out = old.clone();
            for (key, value) in new.iter().filter(|(_, v)| !v.is_null()) {
                let merged = old.get(key).map_or_else(|| value.clone(), |o| merge(o, value));
                out.insert(key.clone(), merged);
            }
            Value::Object(out)
        }
        (_, Value::Null) => last.clone(),
        _ => update.clone(),
    }
}

/// The usage reading for a snapshot, or None when it is not a subscription
/// login (no `planType` and no window: an API-key codex login).
pub(super) fn to_event(snapshot: &Value) -> Option<SessionEvent> {
    let window = |key: &str| snapshot.get(key).filter(|w| w.is_object());
    let (primary, secondary) = (window("primary"), window("secondary"));
    let has_plan = snapshot.get("planType").is_some_and(|p| !p.is_null());
    if !has_plan && primary.is_none() && secondary.is_none() {
        return None;
    }
    let windows: Vec<RateLimitWindow> = [
        (primary, RateLimitWindowKind::FiveHour),
        (secondary, RateLimitWindowKind::SevenDay),
    ]
    .into_iter()
    .filter_map(|(w, fallback)| map_window(w?, fallback))
    .collect();
    let status = if snapshot.get("rateLimitReachedType").is_some_and(|t| !t.is_null()) {
        RateLimitStatus::Rejected
    } else if windows
        .iter()
        .any(|w| w.utilization.is_some_and(|u| u >= WARNING_FRACTION))
    {
        RateLimitStatus::AllowedWarning
    } else {
        RateLimitStatus::Allowed
    };
    Some(SessionEvent::RateLimitInfo {
        status: Some(status),
        rate_limit_type: None,
        resets_at: None,
        utilization: None,
        windows,
        surpassed_threshold: None,
    })
}

/// A window by its duration; `fallback` (primary → 5-hour, secondary → weekly)
/// when codex gives none. A duration that is neither is not a window we show.
fn map_window(w: &Value, fallback: RateLimitWindowKind) -> Option<RateLimitWindow> {
    let kind = match w.get("windowDurationMins").and_then(Value::as_i64) {
        None => fallback,
        Some(m) if FIVE_HOUR_MINS.contains(&m) => RateLimitWindowKind::FiveHour,
        Some(m) if SEVEN_DAY_MINS.contains(&m) => RateLimitWindowKind::SevenDay,
        Some(_) => return None,
    };
    let utilization = w
        .get("usedPercent")
        .and_then(Value::as_f64)
        .filter(|p| p.is_finite() && *p >= 0.0)
        .map(|p| p / 100.0);
    let resets_at = w
        .get("resetsAt")
        .and_then(Value::as_u64)
        .map(|t| if t >= EPOCH_MS_FLOOR { t / 1000 } else { t });
    Some(RateLimitWindow {
        kind,
        utilization,
        resets_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `account/rateLimits/read` result for a ChatGPT Plus login, every field in
    /// the v2 `GetAccountRateLimitsResponse` shape.
    fn full_read() -> Value {
        json!({
            "ordinaryUsageAllowed": true,
            "rateLimits": {
                "limitId": "codex", "limitName": null, "normalModelSlug": null,
                "primary": { "usedPercent": 42, "windowDurationMins": 300, "resetsAt": 1785754200 },
                "secondary": { "usedPercent": 91, "windowDurationMins": 10080, "resetsAt": 1786000000 },
                "credits": { "hasCredits": false, "unlimited": false, "balance": null },
                "individualLimit": null, "spendControlReached": null,
                "planType": "plus", "rateLimitReachedType": null
            },
            "rateLimitsByLimitId": null, "rateLimitResetCredits": null,
            "accountId": "acct-1", "rateLimitUpsell": null
        })
    }

    fn windows_of(event: Option<SessionEvent>) -> (Option<RateLimitStatus>, Vec<RateLimitWindow>) {
        match event {
            Some(SessionEvent::RateLimitInfo { status, windows, .. }) => (status, windows),
            other => panic!("expected RateLimitInfo, got {other:?}"),
        }
    }

    fn window(kind: RateLimitWindowKind, utilization: f64, resets_at: u64) -> RateLimitWindow {
        RateLimitWindow {
            kind,
            utilization: Some(utilization),
            resets_at: Some(resets_at),
        }
    }

    #[test]
    fn read_request_sends_the_verified_method_and_params() {
        let frame = read_request();
        assert_eq!(frame["method"], "account/rateLimits/read");
        assert_eq!(frame["id"], READ_ID);
        assert_eq!(
            frame["params"],
            json!({ "supportsLunaReserve": false, "excludeResetCreditDetails": true })
        );
    }

    #[test]
    fn a_full_read_maps_both_windows_and_warns_at_ninety_percent() {
        let (status, windows) = windows_of(to_event(&full_read()["rateLimits"]));
        assert_eq!(status, Some(RateLimitStatus::AllowedWarning));
        assert_eq!(
            windows,
            vec![
                window(RateLimitWindowKind::FiveHour, 0.42, 1785754200),
                window(RateLimitWindowKind::SevenDay, 0.91, 1786000000),
            ]
        );
    }

    #[test]
    fn below_ninety_percent_is_allowed_and_a_reached_limit_is_rejected() {
        let mut snapshot = full_read()["rateLimits"].clone();
        snapshot["secondary"]["usedPercent"] = json!(89);
        assert_eq!(windows_of(to_event(&snapshot)).0, Some(RateLimitStatus::Allowed));
        snapshot["rateLimitReachedType"] = json!("rate_limit_reached");
        assert_eq!(windows_of(to_event(&snapshot)).0, Some(RateLimitStatus::Rejected));
    }

    #[test]
    fn a_sparse_update_keeps_what_it_does_not_carry() {
        let last = full_read()["rateLimits"].clone();
        let update = json!({
            "limitId": null, "limitName": null, "normalModelSlug": null,
            "primary": { "usedPercent": 55, "windowDurationMins": null, "resetsAt": null },
            "secondary": null, "credits": null, "individualLimit": null,
            "spendControlReached": null, "planType": null, "rateLimitReachedType": null
        });
        let merged = merge(&last, &update);
        assert_eq!(merged["planType"], "plus");
        let (_, windows) = windows_of(to_event(&merged));
        assert_eq!(
            windows,
            vec![
                window(RateLimitWindowKind::FiveHour, 0.55, 1785754200),
                window(RateLimitWindowKind::SevenDay, 0.91, 1786000000),
            ]
        );
    }

    #[test]
    fn an_update_for_another_limit_is_ignored() {
        let last = full_read()["rateLimits"].clone();
        let other = json!({ "limitId": "codex_other", "primary": { "usedPercent": 99 } });
        assert!(apply_update(&last, &other).is_none());
        let same = json!({ "limitId": "codex", "primary": { "usedPercent": 50 } });
        let merged = apply_update(&last, &same).expect("same limit merges");
        assert_eq!(merged["primary"]["usedPercent"], 50);
        let unnamed = json!({ "limitId": null, "primary": { "usedPercent": 60 } });
        assert_eq!(
            apply_update(&last, &unnamed).expect("unnamed merges")["primary"]["usedPercent"],
            60
        );
    }

    #[test]
    fn an_update_below_the_limit_without_a_reached_type_clears_rejected() {
        let mut last = full_read()["rateLimits"].clone();
        last["rateLimitReachedType"] = json!("rate_limit_reached");
        last["primary"]["usedPercent"] = json!(100);
        let still_full = json!({ "secondary": { "usedPercent": 95 }, "rateLimitReachedType": null });
        let kept = apply_update(&last, &still_full).expect("merges");
        assert_eq!(
            windows_of(to_event(&kept)).0,
            Some(RateLimitStatus::Rejected),
            "primary is still at 100%"
        );
        let mut spend_capped = last.clone();
        spend_capped["primary"]["usedPercent"] = json!(50);
        let no_windows = json!({ "credits": { "hasCredits": true }, "rateLimitReachedType": null });
        let kept = apply_update(&spend_capped, &no_windows).expect("merges");
        assert_eq!(
            windows_of(to_event(&kept)).0,
            Some(RateLimitStatus::Rejected),
            "no window in the update"
        );
        let recovered =
            json!({ "primary": { "usedPercent": 3, "resetsAt": 1785772200 }, "rateLimitReachedType": null });
        let cleared = apply_update(&last, &recovered).expect("merges");
        assert_eq!(windows_of(to_event(&cleared)).0, Some(RateLimitStatus::AllowedWarning));
    }

    #[test]
    fn an_update_before_any_read_stands_on_its_own() {
        let update = json!({ "primary": { "usedPercent": 10, "windowDurationMins": 300, "resetsAt": 1 } });
        let (_, windows) = windows_of(to_event(&merge(&Value::Null, &update)));
        assert_eq!(windows, vec![window(RateLimitWindowKind::FiveHour, 0.1, 1)]);
    }

    #[test]
    fn an_api_key_snapshot_emits_nothing() {
        let snapshot = json!({
            "limitId": null, "limitName": null, "normalModelSlug": null,
            "primary": null, "secondary": null, "credits": null, "individualLimit": null,
            "spendControlReached": null, "planType": null, "rateLimitReachedType": null
        });
        assert!(to_event(&snapshot).is_none());
        assert!(to_event(&Value::Null).is_none());
    }

    #[test]
    fn reset_times_in_milliseconds_become_seconds() {
        let snapshot = json!({ "primary": { "usedPercent": 1, "resetsAt": 1_785_754_200_000u64 } });
        let (_, windows) = windows_of(to_event(&snapshot));
        assert_eq!(windows[0].resets_at, Some(1_785_754_200));
        let seconds = json!({ "primary": { "usedPercent": 1, "resetsAt": 1_785_754_200u64 } });
        assert_eq!(windows_of(to_event(&seconds)).1[0].resets_at, Some(1_785_754_200));
    }

    #[test]
    fn windows_fall_back_by_position_and_unknown_durations_are_dropped() {
        let snapshot = json!({
            "primary": { "usedPercent": 20 },
            "secondary": { "usedPercent": 30, "windowDurationMins": 43200 },
            "planType": "pro"
        });
        let (_, windows) = windows_of(to_event(&snapshot));
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].kind, RateLimitWindowKind::FiveHour);
        let by_position = json!({ "primary": null, "secondary": { "usedPercent": 30 } });
        assert_eq!(
            windows_of(to_event(&by_position)).1[0].kind,
            RateLimitWindowKind::SevenDay
        );
    }
}

//! claude `rate_limit_event` → [`SessionEvent::RateLimitInfo`].
//!
//! Wire shape, from two sources:
//! - verified: tests/fixtures/claude_2.1.220_background_bash_turn.ndjsonl line 26 —
//!   `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed",
//!   "resetsAt":1785754200,"rateLimitType":"five_hour","overageStatus":"rejected",…}}`,
//!   with no `utilization` and no `unifiedWindows`.
//! - verified: the claude-code 2.1.301 binary's schema strings
//!   (`@anthropic-ai/claude-code/bin/claude.exe`): `status` is
//!   `allowed|allowed_warning|rejected`; optional `resetsAt` (int, epoch seconds),
//!   `rateLimitType` (`five_hour|seven_day|seven_day_opus|seven_day_sonnet|
//!   seven_day_overage_included|overage`), `utilization` (number; "the fraction of
//!   the window used (usually 0-1 … values above 1 o[ccur])"), `surpassedThreshold`
//!   (number), and `unifiedWindows.{five_hour,seven_day,seven_day_overage_included}
//!   .{utilization,resetsAt}`, which is "always absent for API-key, Bedrock, and
//!   Vertex sessions".
//!
//! Every field is read defensively: a missing, mistyped or unknown value becomes
//! `None` (or is skipped), never a panic.

use serde_json::Value;

use crate::event::{RateLimitStatus, RateLimitWindow, RateLimitWindowKind, SessionEvent};

/// Parse one `rate_limit_event` frame. A frame without a `rate_limit_info`
/// object carries nothing usable and stays opaque.
pub(super) fn parse_rate_limit_event(v: &Value) -> Vec<SessionEvent> {
    let Some(info) = v.get("rate_limit_info").filter(|info| info.is_object()) else {
        tracing::warn!("claude rate_limit_event without a rate_limit_info object; ignored");
        return vec![SessionEvent::AdapterSpecific {
            tag: "rate_limit_event".to_string(),
            payload: v.clone(),
        }];
    };
    let status = info.get("status").and_then(Value::as_str).and_then(status_from_wire);
    let rate_limit_type = info
        .get("rateLimitType")
        .and_then(Value::as_str)
        .and_then(kind_from_wire);
    // Only the two enums: the rest of the payload is account usage detail.
    tracing::debug!(?status, ?rate_limit_type, "claude rate_limit_event");
    vec![SessionEvent::RateLimitInfo {
        status,
        rate_limit_type,
        resets_at: epoch_seconds(info.get("resetsAt")),
        utilization: fraction(info.get("utilization")),
        windows: windows(info.get("unifiedWindows")),
        surpassed_threshold: fraction(info.get("surpassedThreshold")),
    }]
}

fn status_from_wire(s: &str) -> Option<RateLimitStatus> {
    match s {
        "allowed" => Some(RateLimitStatus::Allowed),
        "allowed_warning" => Some(RateLimitStatus::AllowedWarning),
        "rejected" => Some(RateLimitStatus::Rejected),
        _ => None,
    }
}

fn kind_from_wire(s: &str) -> Option<RateLimitWindowKind> {
    match s {
        "five_hour" => Some(RateLimitWindowKind::FiveHour),
        "seven_day" => Some(RateLimitWindowKind::SevenDay),
        "seven_day_opus" => Some(RateLimitWindowKind::SevenDayOpus),
        "seven_day_sonnet" => Some(RateLimitWindowKind::SevenDaySonnet),
        "seven_day_overage_included" => Some(RateLimitWindowKind::SevenDayOverageIncluded),
        "overage" => Some(RateLimitWindowKind::Overage),
        _ => None,
    }
}

fn epoch_seconds(v: Option<&Value>) -> Option<u64> {
    v.and_then(Value::as_u64)
}

/// A finite, non-negative number; anything else is not a usable fraction.
fn fraction(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|f| f.is_finite() && *f >= 0.0)
}

/// `unifiedWindows` entries with a known window name, in wire order of the
/// schema's own listing (stable for the renderer); unknown names are skipped.
fn windows(v: Option<&Value>) -> Vec<RateLimitWindow> {
    let Some(map) = v.and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut out: Vec<RateLimitWindow> = map
        .iter()
        .filter_map(|(name, w)| {
            Some(RateLimitWindow {
                kind: kind_from_wire(name)?,
                utilization: fraction(w.get("utilization")),
                resets_at: epoch_seconds(w.get("resetsAt")),
            })
        })
        .collect();
    out.sort_by_key(|w| w.kind as u8);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn only_event(v: &Value) -> SessionEvent {
        let mut events = parse_rate_limit_event(v);
        assert_eq!(events.len(), 1, "one frame → one event");
        events.remove(0)
    }

    #[test]
    fn recorded_2_1_220_frame_parses_status_type_and_reset_without_utilization() {
        let raw = include_str!("../../tests/fixtures/claude_2.1.220_background_bash_turn.ndjsonl");
        let line = raw.lines().nth(25).expect("fixture line 26");
        let v: Value = serde_json::from_str(line).unwrap();
        assert_eq!(v["type"], "rate_limit_event", "line 26 is the rate_limit_event frame");

        assert_eq!(
            only_event(&v),
            SessionEvent::RateLimitInfo {
                status: Some(RateLimitStatus::Allowed),
                rate_limit_type: Some(RateLimitWindowKind::FiveHour),
                resets_at: Some(1_785_754_200),
                utilization: None,
                windows: Vec::new(),
                surpassed_threshold: None,
            }
        );
    }

    #[test]
    fn frame_with_unified_windows_parses_every_known_window() {
        let v = json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed_warning",
                "resetsAt": 1_785_754_200,
                "rateLimitType": "seven_day",
                "utilization": 0.93,
                "surpassedThreshold": 0.9,
                "unifiedWindows": {
                    "seven_day": { "utilization": 0.93, "resetsAt": 1_786_000_000 },
                    "five_hour": { "utilization": 1.12, "resetsAt": 1_785_754_200 },
                    "seven_day_overage_included": { "utilization": 0.4, "resetsAt": 1_786_100_000 }
                },
                "overageStatus": "rejected",
                "isUsingOverage": false
            },
            "uuid": "u",
            "session_id": "s"
        });

        assert_eq!(
            only_event(&v),
            SessionEvent::RateLimitInfo {
                status: Some(RateLimitStatus::AllowedWarning),
                rate_limit_type: Some(RateLimitWindowKind::SevenDay),
                resets_at: Some(1_785_754_200),
                utilization: Some(0.93),
                windows: vec![
                    RateLimitWindow {
                        kind: RateLimitWindowKind::FiveHour,
                        utilization: Some(1.12),
                        resets_at: Some(1_785_754_200),
                    },
                    RateLimitWindow {
                        kind: RateLimitWindowKind::SevenDay,
                        utilization: Some(0.93),
                        resets_at: Some(1_786_000_000),
                    },
                    RateLimitWindow {
                        kind: RateLimitWindowKind::SevenDayOverageIncluded,
                        utilization: Some(0.4),
                        resets_at: Some(1_786_100_000),
                    },
                ],
                surpassed_threshold: Some(0.9),
            }
        );
    }

    #[test]
    fn garbage_fields_degrade_to_none_without_panicking() {
        let v = json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "brand_new_status",
                "resetsAt": "soon",
                "rateLimitType": 7,
                "utilization": -3,
                "surpassedThreshold": "high",
                "unifiedWindows": {
                    "future_window": { "utilization": 0.5, "resetsAt": 1 },
                    "five_hour": "not an object",
                    "seven_day": { "utilization": null, "resetsAt": -1 }
                }
            }
        });

        assert_eq!(
            only_event(&v),
            SessionEvent::RateLimitInfo {
                status: None,
                rate_limit_type: None,
                resets_at: None,
                utilization: None,
                windows: vec![
                    RateLimitWindow {
                        kind: RateLimitWindowKind::FiveHour,
                        utilization: None,
                        resets_at: None,
                    },
                    RateLimitWindow {
                        kind: RateLimitWindowKind::SevenDay,
                        utilization: None,
                        resets_at: None,
                    },
                ],
                surpassed_threshold: None,
            }
        );
    }

    #[test]
    fn frame_without_info_object_stays_opaque() {
        for v in [
            json!({ "type": "rate_limit_event" }),
            json!({ "type": "rate_limit_event", "rate_limit_info": "x" }),
            json!({ "type": "rate_limit_event", "rate_limit_info": null }),
        ] {
            assert!(matches!(
                only_event(&v),
                SessionEvent::AdapterSpecific { ref tag, .. } if tag == "rate_limit_event"
            ));
        }
    }
}

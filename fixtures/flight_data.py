"""Canonical schedules, source URLs, and observation builders for tests."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


SCHEMA_VERSION = "flightproof/v1"
ARRIVAL_TIME_DEFINITION = "GATE_IN"

SOURCE_PREFIXES = (
    "https://provider-a.flightproof.dev/observations/",
    "https://provider-b.flightproof.dev/observations/",
    "https://provider-c.flightproof.dev/observations/",
)

CARRIER_ICAO = "UAL"
FLIGHT_NUMBER = "123"
ORIGIN_ICAO = "KSFO"
DESTINATION_ICAO = "KJFK"
SCHEDULED_DEPARTURE_UNIX = 1_800_000_000
SCHEDULED_ARRIVAL_UNIX = SCHEDULED_DEPARTURE_UNIX + 5 * 60 * 60
FINALIZATION_GRACE_MINUTES = 180
REGISTRATION_DATETIME = "2026-08-09T00:00:00+00:00"


def build_flight_id(
    carrier_icao: str = CARRIER_ICAO,
    flight_number: str = FLIGHT_NUMBER,
    origin_icao: str = ORIGIN_ICAO,
    destination_icao: str = DESTINATION_ICAO,
    scheduled_departure_unix: int = SCHEDULED_DEPARTURE_UNIX,
    scheduled_arrival_unix: int = SCHEDULED_ARRIVAL_UNIX,
) -> str:
    return (
        f"{carrier_icao}-{flight_number}-{origin_icao}-{destination_icao}-"
        f"{scheduled_departure_unix}-{scheduled_arrival_unix}"
    )


FLIGHT_ID = build_flight_id()
EVIDENCE_SUFFIX = (
    f"{CARRIER_ICAO}/{FLIGHT_NUMBER}/{ORIGIN_ICAO}/{DESTINATION_ICAO}/"
    f"{SCHEDULED_DEPARTURE_UNIX}/{SCHEDULED_ARRIVAL_UNIX}"
)
EVIDENCE_URLS = tuple(f"{prefix}{EVIDENCE_SUFFIX}" for prefix in SOURCE_PREFIXES)


def iso_datetime(unix_timestamp: int) -> str:
    return datetime.fromtimestamp(unix_timestamp, timezone.utc).isoformat()


RESOLUTION_NOT_BEFORE_UNIX = (
    SCHEDULED_ARRIVAL_UNIX + FINALIZATION_GRACE_MINUTES * 60
)
RESOLUTION_DATETIME = iso_datetime(RESOLUTION_NOT_BEFORE_UNIX)


def observation(
    *,
    status: str = "ARRIVED",
    delay_minutes: int = 60,
    flight_id: str = FLIGHT_ID,
    scheduled_arrival_unix: int = SCHEDULED_ARRIVAL_UNIX,
    final: bool = True,
    **overrides: Any,
) -> dict[str, Any]:
    """Build a normalized provider response in the flightproof/v1 schema."""
    normalized_status = status.upper()
    if normalized_status == "CANCELLED":
        actual_arrival_unix = 0
    else:
        actual_arrival_unix = scheduled_arrival_unix + delay_minutes * 60

    payload: dict[str, Any] = {
        "schema": SCHEMA_VERSION,
        "flight_id": flight_id,
        "final": final,
        "status": normalized_status,
        "scheduled_arrival_unix": scheduled_arrival_unix,
        "actual_arrival_unix": actual_arrival_unix,
        "arrival_time_definition": ARRIVAL_TIME_DEFINITION,
        "cancelled": normalized_status == "CANCELLED",
        "diverted": normalized_status == "DIVERTED",
    }
    payload.update(overrides)
    return payload


def mock_response(
    payload: Any | None = None,
    *,
    status: int = 200,
    body: str | None = None,
) -> dict[str, Any]:
    """Return a flat gltest/GLSim web-response mock."""
    import json

    if body is None:
        body = json.dumps(payload)
    return {"method": "GET", "status": status, "body": body}

# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *
import json
from datetime import datetime
from typing import Any, NoReturn, cast


ERROR_EXPECTED = "[EXPECTED]"
ERROR_TRANSIENT = "[TRANSIENT]"

SCHEMA_VERSION = "flightproof/v1"
RESULT_SCHEMA_VERSION = "flightproof/result/v1"
ARRIVAL_TIME_DEFINITION = "GATE_IN"
STATUS_ARRIVED = "ARRIVED"
STATUS_CANCELLED = "CANCELLED"
STATUS_DIVERTED = "DIVERTED"
VALID_FINAL_STATUSES = (STATUS_ARRIVED, STATUS_CANCELLED, STATUS_DIVERTED)
MAX_SOURCE_PREFIX_LENGTH = 300
MAX_SOURCE_RESPONSE_BYTES = 100_000
MAXIMUM_ALLOWED_SOURCE_SPREAD_MINUTES = 180
MAXIMUM_ALLOWED_CONSENSUS_DRIFT_MINUTES = 60
MAXIMUM_CLOCK_SKEW_SECONDS = 5 * 60

def _expected(message: str) -> NoReturn:
    raise gl.vm.UserError(f"{ERROR_EXPECTED} {message}")


def _transient(message: str) -> NoReturn:
    raise gl.vm.UserError(f"{ERROR_TRANSIENT} {message}")


def _require_code(value: str, label: str, minimum: int, maximum: int) -> str:
    normalized = value.strip().upper()
    if len(normalized) < minimum or len(normalized) > maximum:
        _expected(f"invalid_{label}")
    if not normalized.isascii() or not normalized.isalnum():
        _expected(f"invalid_{label}")
    return normalized


def _require_flight_number(value: str) -> str:
    normalized = _require_code(value, "flight_number", 1, 6)
    if len(normalized) > 1 and normalized.startswith("0"):
        _expected("invalid_flight_number")
    return normalized


def _build_flight_id(
    carrier_icao: str,
    flight_number: str,
    origin_icao: str,
    destination_icao: str,
    scheduled_departure_unix: int,
    scheduled_arrival_unix: int,
) -> str:
    return (
        f"{carrier_icao}-{flight_number}-{origin_icao}-{destination_icao}-"
        f"{scheduled_departure_unix}-{scheduled_arrival_unix}"
    )


def _build_evidence_suffix(registration: dict[str, Any]) -> str:
    return (
        f"{registration['carrier_icao']}/{registration['flight_number']}/"
        f"{registration['origin_icao']}/{registration['destination_icao']}/"
        f"{registration['scheduled_departure_unix']}/"
        f"{registration['scheduled_arrival_unix']}"
    )


def _transaction_unix() -> int:
    raw = str(gl.message_raw["datetime"])
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            _expected("invalid_transaction_datetime")
        return int(parsed.timestamp())
    except (ValueError, TypeError, OverflowError):
        _expected("invalid_transaction_datetime")


def _canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _parse_json_object(raw: str, error_name: str) -> dict[str, Any]:
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        _expected(error_name)
    if not isinstance(parsed, dict):
        _expected(error_name)
    return cast(dict[str, Any], parsed)


def _normalize_observation(
    payload: Any,
    expected_flight_id: str,
    scheduled_departure_unix: int,
    scheduled_arrival_unix: int,
) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    observation = cast(dict[str, Any], payload)
    if observation.get("schema") != SCHEMA_VERSION:
        return None
    if observation.get("flight_id") != expected_flight_id:
        return None
    if observation.get("final") is not True:
        return None

    status = str(observation.get("status", "")).strip().upper()
    if status not in VALID_FINAL_STATUSES:
        return None

    source_scheduled_arrival_value = observation.get("scheduled_arrival_unix")
    actual_arrival_value = observation.get("actual_arrival_unix")
    if (
        type(source_scheduled_arrival_value) is not int
        or type(actual_arrival_value) is not int
    ):
        return None
    source_scheduled_arrival = source_scheduled_arrival_value
    actual_arrival = actual_arrival_value

    if source_scheduled_arrival != scheduled_arrival_unix:
        return None

    cancelled_value = observation.get("cancelled")
    diverted_value = observation.get("diverted")
    if type(cancelled_value) is not bool or type(diverted_value) is not bool:
        return None
    cancelled = cancelled_value is True
    diverted = diverted_value is True
    if cancelled != (status == STATUS_CANCELLED):
        return None
    if diverted != (status == STATUS_DIVERTED):
        return None

    if status in (STATUS_ARRIVED, STATUS_DIVERTED):
        if observation.get("arrival_time_definition") != ARRIVAL_TIME_DEFINITION:
            return None
        if actual_arrival < scheduled_departure_unix:
            return None
        if actual_arrival > scheduled_arrival_unix + (7 * 24 * 60 * 60):
            return None
    else:
        if actual_arrival != 0:
            return None

    return {
        "status": status,
        "actual_arrival_unix": actual_arrival,
    }


def _aggregate_observations(
    observations: list[dict[str, Any]],
    flight_id: str,
    scheduled_arrival_unix: int,
    minimum_sources: int,
    maximum_spread_minutes: int,
    consensus_drift_minutes: int,
) -> dict[str, Any]:
    counts: dict[str, int] = {
        STATUS_ARRIVED: 0,
        STATUS_CANCELLED: 0,
        STATUS_DIVERTED: 0,
    }
    for observation in observations:
        counts[observation["status"]] += 1

    selected_status = ""
    selected_count = 0
    tied = False
    for candidate in VALID_FINAL_STATUSES:
        count = counts[candidate]
        if count > selected_count:
            selected_status = candidate
            selected_count = count
            tied = False
        elif count > 0 and count == selected_count:
            tied = True

    if selected_count < minimum_sources or tied:
        _transient("insufficient_source_agreement")

    raw_lower_delay = 0
    raw_upper_delay = 0
    actual_lower = 0
    actual_upper = 0

    if selected_status in (STATUS_ARRIVED, STATUS_DIVERTED):
        arrival_times: list[int] = []
        for observation in observations:
            if observation["status"] == selected_status:
                arrival = int(observation["actual_arrival_unix"])
                if arrival > 0:
                    arrival_times.append(arrival)

        if len(arrival_times) < minimum_sources:
            _transient("insufficient_arrival_evidence")

        arrival_times.sort()
        actual_lower = arrival_times[0]
        actual_upper = arrival_times[len(arrival_times) - 1]
        spread_seconds = actual_upper - actual_lower
        if spread_seconds > maximum_spread_minutes * 60:
            _transient("arrival_sources_too_far_apart")

        raw_lower_delay = (actual_lower - scheduled_arrival_unix) // 60
        raw_upper_delay = (actual_upper - scheduled_arrival_unix) // 60

    return {
        "schema": RESULT_SCHEMA_VERSION,
        "flight_id": flight_id,
        "status": selected_status,
        "arrival_time_definition": ARRIVAL_TIME_DEFINITION,
        "scheduled_arrival_unix": scheduled_arrival_unix,
        "actual_arrival_lower_unix": actual_lower,
        "actual_arrival_upper_unix": actual_upper,
        "delay_lower_bound_minutes": raw_lower_delay - consensus_drift_minutes,
        "delay_upper_bound_minutes": raw_upper_delay + consensus_drift_minutes,
        "source_count": selected_count,
    }


class FlightProof(gl.Contract):
    owner: Address
    source_policy_version: u256
    minimum_sources: u256
    maximum_source_spread_minutes: u256
    consensus_drift_minutes: u256
    finalization_grace_minutes: u256
    source_prefix_1: str
    source_prefix_2: str
    source_prefix_3: str
    registrations: TreeMap[str, str]
    registration_exists: TreeMap[str, bool]
    resolutions: TreeMap[str, str]
    resolution_exists: TreeMap[str, bool]
    resolution_ids: DynArray[str]

    def __init__(
        self,
        source_policy_version: u256,
        minimum_sources: u256,
        maximum_source_spread_minutes: u256,
        consensus_drift_minutes: u256,
        finalization_grace_minutes: u256,
        source_prefix_1: str,
        source_prefix_2: str,
        source_prefix_3: str,
    ):
        prefixes = [
            source_prefix_1,
            source_prefix_2,
            source_prefix_3,
        ]
        active_prefixes: list[str] = []
        active_authorities: list[str] = []
        for prefix in prefixes:
            if not prefix:
                continue
            authority_end = prefix.find("/", len("https://"))
            if not prefix.startswith("https://") or not prefix.endswith("/"):
                _expected("source_prefix_must_be_https_and_end_with_slash")
            if (
                authority_end <= len("https://")
                or len(prefix) > MAX_SOURCE_PREFIX_LENGTH
                or not prefix.isascii()
                or " " in prefix
                or "\t" in prefix
                or "\r" in prefix
                or "\n" in prefix
                or ".." in prefix
                or "%" in prefix
                or "?" in prefix
                or "#" in prefix
                or "@" in prefix
                or "\\" in prefix
            ):
                _expected("unsafe_source_prefix")
            if prefix in active_prefixes:
                _expected("duplicate_source_prefix")
            authority = prefix[:authority_end].lower()
            if authority in active_authorities:
                _expected("duplicate_source_authority")
            for other in active_prefixes:
                if prefix.startswith(other) or other.startswith(prefix):
                    _expected("overlapping_source_prefix")
            active_prefixes.append(prefix)
            active_authorities.append(authority)

        if int(source_policy_version) <= 0:
            _expected("invalid_source_policy_version")
        if int(minimum_sources) < 2 or int(minimum_sources) > len(active_prefixes):
            _expected("invalid_minimum_sources")
        if (
            int(maximum_source_spread_minutes) <= 0
            or int(maximum_source_spread_minutes)
            > MAXIMUM_ALLOWED_SOURCE_SPREAD_MINUTES
        ):
            _expected("invalid_maximum_source_spread")
        if (
            int(consensus_drift_minutes)
            > MAXIMUM_ALLOWED_CONSENSUS_DRIFT_MINUTES
        ):
            _expected("invalid_consensus_drift")
        if int(finalization_grace_minutes) > 7 * 24 * 60:
            _expected("invalid_finalization_grace")

        self.owner = gl.message.sender_address
        self.source_policy_version = source_policy_version
        self.minimum_sources = minimum_sources
        self.maximum_source_spread_minutes = maximum_source_spread_minutes
        self.consensus_drift_minutes = consensus_drift_minutes
        self.finalization_grace_minutes = finalization_grace_minutes
        self.source_prefix_1 = prefixes[0]
        self.source_prefix_2 = prefixes[1]
        self.source_prefix_3 = prefixes[2]

    @gl.public.write
    def register_flight(
        self,
        carrier_icao: str,
        flight_number: str,
        origin_icao: str,
        destination_icao: str,
        scheduled_departure_unix: u256,
        scheduled_arrival_unix: u256,
    ) -> str:
        carrier = _require_code(carrier_icao, "carrier_icao", 3, 3)
        number = _require_flight_number(flight_number)
        origin = _require_code(origin_icao, "origin_icao", 4, 4)
        destination = _require_code(destination_icao, "destination_icao", 4, 4)
        departure = int(scheduled_departure_unix)
        arrival = int(scheduled_arrival_unix)

        if origin == destination:
            _expected("origin_equals_destination")
        if departure <= 0 or arrival <= departure:
            _expected("invalid_schedule")
        if arrival - departure > 48 * 60 * 60:
            _expected("schedule_duration_too_long")

        flight_id = _build_flight_id(
            carrier,
            number,
            origin,
            destination,
            departure,
            arrival,
        )
        registration_core = {
            "flight_id": flight_id,
            "carrier_icao": carrier,
            "flight_number": number,
            "origin_icao": origin,
            "destination_icao": destination,
            "scheduled_departure_unix": departure,
            "scheduled_arrival_unix": arrival,
        }

        if self.registration_exists.get(flight_id, False):
            existing = _parse_json_object(
                self.registrations[flight_id], "invalid_stored_registration"
            )
            for field in registration_core:
                if existing.get(field) != registration_core[field]:
                    _expected("flight_registration_conflict")
            return flight_id

        registration = registration_core
        registration["registered_at"] = str(gl.message_raw["datetime"])
        encoded = _canonical_json(registration)
        self.registrations[flight_id] = encoded
        self.registration_exists[flight_id] = True
        return flight_id

    @gl.public.write
    def resolve_flight(self, flight_id: str) -> None:
        if not self.registration_exists.get(flight_id, False):
            _expected("flight_not_registered")
        if self.resolution_exists.get(flight_id, False):
            _expected("flight_already_resolved")

        registration = _parse_json_object(
            self.registrations[flight_id], "invalid_stored_registration"
        )
        prefixes = [
            self.source_prefix_1,
            self.source_prefix_2,
            self.source_prefix_3,
        ]
        minimum_sources = int(self.minimum_sources)
        suffix = _build_evidence_suffix(registration)
        evidence_urls: list[str] = []
        for prefix in prefixes:
            if prefix:
                evidence_urls.append(prefix + suffix)

        expected_flight_id = registration["flight_id"]
        scheduled_departure = int(registration["scheduled_departure_unix"])
        scheduled_arrival = int(registration["scheduled_arrival_unix"])
        maximum_spread = int(self.maximum_source_spread_minutes)
        consensus_drift = int(self.consensus_drift_minutes)
        transaction_unix = _transaction_unix()
        resolution_not_before = scheduled_arrival + (
            int(self.finalization_grace_minutes) * 60
        )
        if transaction_unix < resolution_not_before:
            _expected("resolution_window_not_open")

        def leader_fn() -> dict[str, Any]:
            observations: list[dict[str, Any]] = []
            for url in evidence_urls:
                try:
                    response = gl.nondet.web.get(
                        url,
                        headers={"Accept": "application/json"},
                    )
                    if response.status != 200 or response.body is None:
                        continue
                    if len(response.body) > MAX_SOURCE_RESPONSE_BYTES:
                        continue
                    payload = json.loads(response.body.decode("utf-8"))
                    normalized = _normalize_observation(
                        payload,
                        expected_flight_id,
                        scheduled_departure,
                        scheduled_arrival,
                    )
                except Exception:
                    continue

                if normalized is not None:
                    observations.append(normalized)

            if len(observations) < minimum_sources:
                _transient("insufficient_valid_sources")

            return _aggregate_observations(
                observations,
                expected_flight_id,
                scheduled_arrival,
                minimum_sources,
                maximum_spread,
                consensus_drift,
            )

        def validator_fn(
            leaders_res: gl.vm.Result[dict[str, Any]],
        ) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                if not isinstance(leaders_res, gl.vm.UserError):
                    return False
                try:
                    leader_fn()
                    return False
                except gl.vm.UserError as validator_error:
                    leader_message = leaders_res.message
                    validator_message = validator_error.message
                    if leader_message.startswith(ERROR_TRANSIENT):
                        return validator_message.startswith(ERROR_TRANSIENT)
                    return validator_message == leader_message
                except Exception:
                    return False

            try:
                validator_result = leader_fn()
                leader_result = leaders_res.calldata
                if not isinstance(  # pyright: ignore[reportUnnecessaryIsInstance]
                    leader_result, dict
                ):
                    return False
                required_fields = (
                    "schema",
                    "flight_id",
                    "status",
                    "arrival_time_definition",
                    "scheduled_arrival_unix",
                    "actual_arrival_lower_unix",
                    "actual_arrival_upper_unix",
                    "delay_lower_bound_minutes",
                    "delay_upper_bound_minutes",
                    "source_count",
                )
                if len(leader_result) != len(required_fields):
                    return False
                for field in required_fields:
                    if field not in leader_result:
                        return False
                numeric_fields = (
                    "scheduled_arrival_unix",
                    "actual_arrival_lower_unix",
                    "actual_arrival_upper_unix",
                    "delay_lower_bound_minutes",
                    "delay_upper_bound_minutes",
                    "source_count",
                )
                for field in numeric_fields:
                    if type(leader_result[field]) is not int:
                        return False
                if leader_result.get("schema") != RESULT_SCHEMA_VERSION:
                    return False
                if leader_result.get("flight_id") != validator_result["flight_id"]:
                    return False
                if leader_result.get("status") != validator_result["status"]:
                    return False
                if (
                    leader_result.get("arrival_time_definition")
                    != ARRIVAL_TIME_DEFINITION
                ):
                    return False
                if (
                    leader_result.get("scheduled_arrival_unix")
                    != validator_result["scheduled_arrival_unix"]
                ):
                    return False
                leader_source_count = int(leader_result["source_count"])
                if (
                    leader_source_count < minimum_sources
                    or leader_source_count > len(evidence_urls)
                    or leader_source_count
                    != int(validator_result["source_count"])
                ):
                    return False
                return leader_result == validator_result
            except Exception:
                return False

        canonical_outcome = gl.vm.run_nondet_unsafe(  # pyright: ignore[reportUnknownMemberType]
            leader_fn, validator_fn
        )
        outcome = dict(canonical_outcome)
        if (
            int(outcome["actual_arrival_upper_unix"]) > 0
            and int(outcome["actual_arrival_upper_unix"])
            > transaction_unix + MAXIMUM_CLOCK_SKEW_SECONDS
        ):
            _expected("actual_arrival_is_in_future")
        outcome["source_policy_version"] = int(self.source_policy_version)
        outcome["evidence_urls"] = evidence_urls
        outcome["resolved_at"] = str(gl.message_raw["datetime"])

        self.resolutions[flight_id] = _canonical_json(outcome)
        self.resolution_exists[flight_id] = True
        self.resolution_ids.append(flight_id)

    @gl.public.view  # pyright: ignore[reportUnknownMemberType]
    def build_flight_id(
        self,
        carrier_icao: str,
        flight_number: str,
        origin_icao: str,
        destination_icao: str,
        scheduled_departure_unix: u256,
        scheduled_arrival_unix: u256,
    ) -> str:
        carrier = _require_code(carrier_icao, "carrier_icao", 3, 3)
        number = _require_flight_number(flight_number)
        origin = _require_code(origin_icao, "origin_icao", 4, 4)
        destination = _require_code(destination_icao, "destination_icao", 4, 4)
        departure = int(scheduled_departure_unix)
        arrival = int(scheduled_arrival_unix)
        if origin == destination:
            _expected("origin_equals_destination")
        if departure <= 0 or arrival <= departure:
            _expected("invalid_schedule")
        if arrival - departure > 48 * 60 * 60:
            _expected("schedule_duration_too_long")
        return _build_flight_id(
            carrier,
            number,
            origin,
            destination,
            departure,
            arrival,
        )

    @gl.public.view  # pyright: ignore[reportUnknownMemberType]
    def get_registration(self, flight_id: str) -> dict[str, Any]:
        if not self.registration_exists.get(flight_id, False):
            _expected("flight_not_registered")
        return _parse_json_object(
            self.registrations[flight_id], "invalid_stored_registration"
        )

    @gl.public.view  # pyright: ignore[reportUnknownMemberType]
    def get_resolution(self, flight_id: str) -> dict[str, Any]:
        if not self.resolution_exists.get(flight_id, False):
            _expected("flight_not_resolved")
        return _parse_json_object(
            self.resolutions[flight_id], "invalid_stored_resolution"
        )

    @gl.public.view  # pyright: ignore[reportUnknownMemberType]
    def is_resolved(self, flight_id: str) -> bool:
        return self.resolution_exists.get(flight_id, False)

    @gl.public.view  # pyright: ignore[reportUnknownMemberType]
    def evaluate_delay(self, flight_id: str, threshold_minutes: u256) -> str:
        if not self.resolution_exists.get(flight_id, False):
            return "PENDING"
        outcome = _parse_json_object(
            self.resolutions[flight_id], "invalid_stored_resolution"
        )
        if outcome["status"] != STATUS_ARRIVED:
            return "NOT_APPLICABLE"

        threshold = int(threshold_minutes)
        lower = int(outcome["delay_lower_bound_minutes"])
        upper = int(outcome["delay_upper_bound_minutes"])
        if lower >= threshold:
            return "TRUE"
        if upper < threshold:
            return "FALSE"
        return "INCONCLUSIVE"

    @gl.public.view  # pyright: ignore[reportUnknownMemberType]
    def evaluate_cancellation(self, flight_id: str) -> str:
        if not self.resolution_exists.get(flight_id, False):
            return "PENDING"
        outcome = _parse_json_object(
            self.resolutions[flight_id], "invalid_stored_resolution"
        )
        return "TRUE" if outcome["status"] == STATUS_CANCELLED else "FALSE"

    @gl.public.view  # pyright: ignore[reportUnknownMemberType]
    def get_policy(self) -> dict[str, Any]:
        return {
            "owner": str(self.owner),
            "source_policy_version": int(self.source_policy_version),
            "minimum_sources": int(self.minimum_sources),
            "maximum_source_spread_minutes": int(
                self.maximum_source_spread_minutes
            ),
            "consensus_drift_minutes": int(self.consensus_drift_minutes),
            "finalization_grace_minutes": int(
                self.finalization_grace_minutes
            ),
            "source_prefixes": [
                self.source_prefix_1,
                self.source_prefix_2,
                self.source_prefix_3,
            ],
        }

    @gl.public.view  # pyright: ignore[reportUnknownMemberType]
    def get_resolution_count(self) -> u256:
        return u256(len(self.resolution_ids))

    @gl.public.view  # pyright: ignore[reportUnknownMemberType]
    def get_resolution_id(self, index: u256) -> str:
        position = int(index)
        if position < 0 or position >= len(self.resolution_ids):
            _expected("resolution_index_out_of_bounds")
        return self.resolution_ids[position]

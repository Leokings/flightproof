"""Direct tests for deterministic evidence, finality, and decision views."""

from __future__ import annotations

import json
import re

import pytest

from fixtures.flight_data import (
    EVIDENCE_URLS,
    FLIGHT_ID,
    RESOLUTION_DATETIME,
    RESOLUTION_NOT_BEFORE_UNIX,
    SCHEDULED_ARRIVAL_UNIX,
    iso_datetime,
    mock_response,
    observation,
)


def _install_responses(direct_vm, responses):
    assert len(responses) == len(EVIDENCE_URLS)
    for url, response in zip(EVIDENCE_URLS, responses):
        if isinstance(response, dict) and {"method", "status", "body"} <= set(
            response
        ):
            mock = response
        else:
            mock = mock_response(response)
        direct_vm.mock_web(re.escape(url), mock)


def _resolve(direct_vm, contract, flight_id, responses):
    direct_vm.warp(RESOLUTION_DATETIME)
    _install_responses(direct_vm, responses)
    contract.resolve_flight(flight_id)


def _two_arrivals_one_disagreement():
    return [
        observation(delay_minutes=60),
        observation(delay_minutes=61),
        observation(status="CANCELLED"),
    ]


def test_arrival_resolution_uses_derived_urls_and_delay_boundaries(
    registered_flight, direct_vm
):
    contract, flight_id = registered_flight
    _resolve(direct_vm, contract, flight_id, _two_arrivals_one_disagreement())

    outcome = contract.get_resolution(flight_id)
    assert outcome["schema"] == "flightproof/result/v1"
    assert outcome["flight_id"] == FLIGHT_ID
    assert outcome["status"] == "ARRIVED"
    assert outcome["arrival_time_definition"] == "GATE_IN"
    assert outcome["source_count"] == 2
    assert outcome["source_policy_version"] == 1
    assert outcome["evidence_urls"] == list(EVIDENCE_URLS)
    assert outcome["delay_lower_bound_minutes"] == 58
    assert outcome["delay_upper_bound_minutes"] == 63
    assert outcome["resolved_at"] == RESOLUTION_DATETIME

    assert contract.is_resolved(flight_id) is True
    assert contract.evaluate_delay(flight_id, 58) == "TRUE"
    assert contract.evaluate_delay(flight_id, 59) == "INCONCLUSIVE"
    assert contract.evaluate_delay(flight_id, 63) == "INCONCLUSIVE"
    assert contract.evaluate_delay(flight_id, 64) == "FALSE"
    assert contract.evaluate_cancellation(flight_id) == "FALSE"
    assert contract.get_resolution_count() == 1
    assert contract.get_resolution_id(0) == flight_id


def test_explicit_two_source_cancellation_is_final(
    registered_flight, direct_vm
):
    contract, flight_id = registered_flight
    _resolve(
        direct_vm,
        contract,
        flight_id,
        [
            observation(status="CANCELLED"),
            observation(status="CANCELLED"),
            observation(),
        ],
    )

    outcome = contract.get_resolution(flight_id)
    assert outcome["status"] == "CANCELLED"
    assert outcome["source_count"] == 2
    assert contract.evaluate_cancellation(flight_id) == "TRUE"
    assert contract.evaluate_delay(flight_id, 0) == "NOT_APPLICABLE"


def test_diversion_requires_two_bounded_gate_in_times(
    registered_flight, direct_vm
):
    contract, flight_id = registered_flight
    _resolve(
        direct_vm,
        contract,
        flight_id,
        [
            observation(status="DIVERTED", delay_minutes=60),
            observation(status="DIVERTED", delay_minutes=61),
            observation(status="CANCELLED"),
        ],
    )

    outcome = contract.get_resolution(flight_id)
    assert outcome["status"] == "DIVERTED"
    assert outcome["arrival_time_definition"] == "GATE_IN"
    assert outcome["actual_arrival_lower_unix"] > 0
    assert contract.evaluate_delay(flight_id, 60) == "NOT_APPLICABLE"
    assert contract.evaluate_cancellation(flight_id) == "FALSE"


@pytest.mark.parametrize(
    "invalid_payload",
    [
        observation(schema="flightproof/v0"),
        observation(flight_id="wrong-flight"),
        observation(final=False),
        observation(status="UNKNOWN"),
        observation(scheduled_arrival_unix=SCHEDULED_ARRIVAL_UNIX + 1),
        observation(status="ARRIVED", cancelled=True),
        observation(status="ARRIVED", arrival_time_definition="RUNWAY_ON"),
        observation(status="DIVERTED", arrival_time_definition="RUNWAY_ON"),
        observation(status="DIVERTED", actual_arrival_unix=0),
        observation(actual_arrival_unix=True),
    ],
)
def test_malformed_third_source_is_ignored_when_two_valid_sources_agree(
    registered_flight, direct_vm, invalid_payload
):
    contract, flight_id = registered_flight
    _resolve(
        direct_vm,
        contract,
        flight_id,
        [observation(delay_minutes=60), observation(delay_minutes=61), invalid_payload],
    )

    assert contract.get_resolution(flight_id)["source_count"] == 2


def test_nonfinite_json_number_is_isolated_to_one_source(
    registered_flight, direct_vm
):
    contract, flight_id = registered_flight
    malformed = observation(delay_minutes=62)
    body = json.dumps(malformed).replace(
        str(malformed["actual_arrival_unix"]), "1e309"
    )
    _resolve(
        direct_vm,
        contract,
        flight_id,
        [
            observation(delay_minutes=60),
            observation(delay_minutes=61),
            mock_response(body=body),
        ],
    )

    assert contract.get_resolution(flight_id)["source_count"] == 2


def test_oversized_source_body_is_ignored(
    registered_flight, direct_vm
):
    contract, flight_id = registered_flight
    oversized_body = json.dumps({"padding": "x" * 100_001})
    _resolve(
        direct_vm,
        contract,
        flight_id,
        [
            observation(delay_minutes=60),
            observation(delay_minutes=61),
            mock_response(body=oversized_body),
        ],
    )

    assert contract.get_resolution(flight_id)["source_count"] == 2


def test_http_failure_and_malformed_body_cannot_supply_quorum(
    registered_flight, direct_vm
):
    contract, flight_id = registered_flight
    direct_vm.warp(RESOLUTION_DATETIME)
    responses = [
        mock_response(observation(delay_minutes=60)),
        mock_response(status=503, body="temporarily unavailable"),
        mock_response(body="not-json"),
    ]
    _install_responses(direct_vm, responses)

    with direct_vm.expect_revert("insufficient_valid_sources"):
        contract.resolve_flight(flight_id)

    assert contract.is_resolved(flight_id) is False


def test_404_is_not_treated_as_cancellation(registered_flight, direct_vm):
    contract, flight_id = registered_flight
    direct_vm.warp(RESOLUTION_DATETIME)
    _install_responses(
        direct_vm,
        [
            observation(status="CANCELLED"),
            mock_response(status=404, body="not found"),
            mock_response(status=404, body="not found"),
        ],
    )

    with direct_vm.expect_revert("insufficient_valid_sources"):
        contract.resolve_flight(flight_id)

    assert contract.evaluate_cancellation(flight_id) == "PENDING"


def test_status_tie_cannot_finalize(registered_flight, direct_vm):
    contract, flight_id = registered_flight
    direct_vm.warp(RESOLUTION_DATETIME)
    _install_responses(
        direct_vm,
        [observation(), observation(status="CANCELLED"), mock_response(body="bad")],
    )

    with direct_vm.expect_revert("insufficient_source_agreement"):
        contract.resolve_flight(flight_id)

    assert contract.is_resolved(flight_id) is False


def test_arrival_sources_at_maximum_spread_can_finalize(
    registered_flight, direct_vm
):
    contract, flight_id = registered_flight
    _resolve(
        direct_vm,
        contract,
        flight_id,
        [
            observation(delay_minutes=60),
            observation(delay_minutes=75),
            observation(status="CANCELLED"),
        ],
    )

    outcome = contract.get_resolution(flight_id)
    assert outcome["delay_lower_bound_minutes"] == 58
    assert outcome["delay_upper_bound_minutes"] == 77


def test_arrival_sources_outside_maximum_spread_cannot_finalize(
    registered_flight, direct_vm
):
    contract, flight_id = registered_flight
    direct_vm.warp(RESOLUTION_DATETIME)
    _install_responses(
        direct_vm,
        [
            observation(delay_minutes=60),
            observation(delay_minutes=76),
            observation(status="CANCELLED"),
        ],
    )

    with direct_vm.expect_revert("arrival_sources_too_far_apart"):
        contract.resolve_flight(flight_id)

    assert contract.is_resolved(flight_id) is False


def test_resolution_window_is_closed_until_grace_period_elapses(
    registered_flight, direct_vm
):
    contract, flight_id = registered_flight
    direct_vm.warp(iso_datetime(RESOLUTION_NOT_BEFORE_UNIX - 1))

    with direct_vm.expect_revert("resolution_window_not_open"):
        contract.resolve_flight(flight_id)

    assert contract.is_resolved(flight_id) is False


def test_resolution_window_opens_at_exact_grace_boundary(
    registered_flight, direct_vm
):
    contract, flight_id = registered_flight
    _resolve(direct_vm, contract, flight_id, _two_arrivals_one_disagreement())

    assert contract.is_resolved(flight_id) is True


def test_future_actual_arrival_cannot_be_committed(
    registered_flight, direct_vm
):
    contract, flight_id = registered_flight
    direct_vm.warp(RESOLUTION_DATETIME)
    _install_responses(
        direct_vm,
        [
            observation(delay_minutes=186),
            observation(delay_minutes=187),
            observation(status="CANCELLED"),
        ],
    )

    with direct_vm.expect_revert("actual_arrival_is_in_future"):
        contract.resolve_flight(flight_id)

    assert contract.is_resolved(flight_id) is False


def test_resolution_is_immutable_and_indexed_once(
    registered_flight, direct_vm
):
    contract, flight_id = registered_flight
    _resolve(direct_vm, contract, flight_id, _two_arrivals_one_disagreement())
    original = contract.get_resolution(flight_id)

    with direct_vm.expect_revert("flight_already_resolved"):
        contract.resolve_flight(flight_id)

    assert contract.get_resolution(flight_id) == original
    assert contract.get_resolution_count() == 1
    with direct_vm.expect_revert("resolution_index_out_of_bounds"):
        contract.get_resolution_id(1)


def test_unregistered_flight_cannot_be_resolved(flightproof, direct_vm):
    with direct_vm.expect_revert("flight_not_registered"):
        flightproof.resolve_flight("missing")

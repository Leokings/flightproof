"""Direct manual tests for independent source re-fetch and result validation."""

from __future__ import annotations

import re

from fixtures.flight_data import (
    EVIDENCE_URLS,
    RESOLUTION_DATETIME,
    mock_response,
    observation,
)


CANONICAL_FIELDS = (
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


def _install(direct_vm, responses):
    assert len(responses) == len(EVIDENCE_URLS)
    for url, response in zip(EVIDENCE_URLS, responses):
        if isinstance(response, dict) and {"method", "status", "body"} <= set(
            response
        ):
            mock = response
        else:
            mock = mock_response(response)
        direct_vm.mock_web(re.escape(url), mock)


def _leader_payload(direct_vm):
    stored = direct_vm._captured_validators[-1][0]
    return {field: stored[field] for field in CANONICAL_FIELDS}


def _resolve_and_capture(registered_flight, direct_vm):
    contract, flight_id = registered_flight
    direct_vm.warp(RESOLUTION_DATETIME)
    _install(
        direct_vm,
        [
            observation(delay_minutes=60),
            observation(delay_minutes=61),
            observation(status="CANCELLED"),
        ],
    )
    contract.resolve_flight(flight_id)
    return contract, flight_id, _leader_payload(direct_vm)


def test_validator_independently_refetches_and_agrees(
    registered_flight, direct_vm
):
    _, _, leader = _resolve_and_capture(registered_flight, direct_vm)

    assert direct_vm.run_validator(leader_result=leader) is True


def test_validator_requires_exact_canonical_result_even_for_small_drift(
    registered_flight, direct_vm
):
    _, _, leader = _resolve_and_capture(registered_flight, direct_vm)
    direct_vm.clear_mocks()
    _install(
        direct_vm,
        [
            observation(delay_minutes=61),
            observation(delay_minutes=61),
            observation(status="CANCELLED"),
        ],
    )

    assert direct_vm.run_validator(leader_result=leader) is False


def test_validator_rejects_materially_different_delay_result(
    registered_flight, direct_vm
):
    _, _, leader = _resolve_and_capture(registered_flight, direct_vm)
    direct_vm.clear_mocks()
    _install(
        direct_vm,
        [
            observation(delay_minutes=70),
            observation(delay_minutes=71),
            observation(status="CANCELLED"),
        ],
    )

    assert direct_vm.run_validator(leader_result=leader) is False


def test_validator_rejects_different_final_status(
    registered_flight, direct_vm
):
    _, _, leader = _resolve_and_capture(registered_flight, direct_vm)
    direct_vm.clear_mocks()
    _install(
        direct_vm,
        [
            observation(status="CANCELLED"),
            observation(status="CANCELLED"),
            observation(),
        ],
    )

    assert direct_vm.run_validator(leader_result=leader) is False


def test_validator_rejects_malformed_or_unavailable_refetch(
    registered_flight, direct_vm
):
    _, _, leader = _resolve_and_capture(registered_flight, direct_vm)
    direct_vm.clear_mocks()
    _install(
        direct_vm,
        [
            mock_response(status=500, body="upstream unavailable"),
            mock_response(body="not-json"),
            mock_response(status=404, body="missing"),
        ],
    )

    assert direct_vm.run_validator(leader_result=leader) is False


def test_validator_matches_independently_reproduced_transient_error(
    registered_flight, direct_vm
):
    _resolve_and_capture(registered_flight, direct_vm)
    direct_vm.clear_mocks()
    _install(
        direct_vm,
        [mock_response(status=503, body="down")] * 3,
    )

    assert direct_vm.run_validator(
        leader_error=RuntimeError("[TRANSIENT] upstream timeout")
    ) is True
    assert direct_vm.run_validator(
        leader_error=RuntimeError("[EXPECTED] forged input error")
    ) is False


def test_validator_rejects_identity_status_and_quorum_tampering(
    registered_flight, direct_vm
):
    _, _, leader = _resolve_and_capture(registered_flight, direct_vm)

    assert direct_vm.run_validator(
        leader_result=dict(leader, flight_id="wrong-flight")
    ) is False
    assert direct_vm.run_validator(
        leader_result=dict(leader, status="CANCELLED")
    ) is False
    assert direct_vm.run_validator(
        leader_result=dict(leader, source_count=1)
    ) is False
    assert direct_vm.run_validator(
        leader_result=dict(leader, source_count=3)
    ) is False


def test_validator_rejects_numeric_strings_booleans_and_extra_fields(
    registered_flight, direct_vm
):
    _, _, leader = _resolve_and_capture(registered_flight, direct_vm)

    assert direct_vm.run_validator(
        leader_result=dict(leader, source_count="2")
    ) is False
    assert direct_vm.run_validator(
        leader_result=dict(leader, source_count=True)
    ) is False
    assert direct_vm.run_validator(
        leader_result=dict(leader, delay_lower_bound_minutes="58")
    ) is False
    assert direct_vm.run_validator(
        leader_result={**leader, "untrusted": "extra"}
    ) is False


def test_validator_rejects_missing_required_field(
    registered_flight, direct_vm
):
    _, _, leader = _resolve_and_capture(registered_flight, direct_vm)
    leader.pop("arrival_time_definition")

    assert direct_vm.run_validator(leader_result=leader) is False


def test_validator_rejects_decision_changing_interval_tamper(
    registered_flight, direct_vm
):
    _, _, leader = _resolve_and_capture(registered_flight, direct_vm)
    assert leader["delay_lower_bound_minutes"] == 58
    assert leader["delay_upper_bound_minutes"] == 63

    tampered = dict(
        leader,
        delay_lower_bound_minutes=60,
        delay_upper_bound_minutes=61,
    )
    assert direct_vm.run_validator(leader_result=tampered) is False

def test_validator_rejects_internally_inconsistent_actual_and_delay_fields(
    registered_flight, direct_vm
):
    _, _, leader = _resolve_and_capture(registered_flight, direct_vm)
    tampered = dict(
        leader,
        actual_arrival_lower_unix=leader["actual_arrival_lower_unix"] + 60,
    )

    assert direct_vm.run_validator(leader_result=tampered) is False

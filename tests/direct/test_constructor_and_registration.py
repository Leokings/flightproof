"""Direct tests for policy construction and canonical flight registration."""

from __future__ import annotations

import pytest

from fixtures.flight_data import (
    CARRIER_ICAO,
    DESTINATION_ICAO,
    FINALIZATION_GRACE_MINUTES,
    FLIGHT_ID,
    FLIGHT_NUMBER,
    ORIGIN_ICAO,
    REGISTRATION_DATETIME,
    SCHEDULED_ARRIVAL_UNIX,
    SCHEDULED_DEPARTURE_UNIX,
    SOURCE_PREFIXES,
)
from tests.conftest import CONTRACT_PATH, DIRECT_SDK_VERSION


def _constructor_args(**overrides):
    values = {
        "source_policy_version": 1,
        "minimum_sources": 2,
        "maximum_source_spread_minutes": 15,
        "consensus_drift_minutes": 2,
        "finalization_grace_minutes": FINALIZATION_GRACE_MINUTES,
        "source_prefix_1": SOURCE_PREFIXES[0],
        "source_prefix_2": SOURCE_PREFIXES[1],
        "source_prefix_3": SOURCE_PREFIXES[2],
    }
    values.update(overrides)
    return list(values.values())


def _registration_args(**overrides):
    values = {
        "carrier_icao": CARRIER_ICAO,
        "flight_number": FLIGHT_NUMBER,
        "origin_icao": ORIGIN_ICAO,
        "destination_icao": DESTINATION_ICAO,
        "scheduled_departure_unix": SCHEDULED_DEPARTURE_UNIX,
        "scheduled_arrival_unix": SCHEDULED_ARRIVAL_UNIX,
    }
    values.update(overrides)
    return list(values.values())


def test_constructor_persists_immutable_source_policy(
    flightproof, direct_alice
):
    policy = flightproof.get_policy()
    owner = policy.pop("owner")

    assert owner.lower() == "0x" + bytes(direct_alice).hex()
    assert policy == {
        "source_policy_version": 1,
        "minimum_sources": 2,
        "maximum_source_spread_minutes": 15,
        "consensus_drift_minutes": 2,
        "finalization_grace_minutes": FINALIZATION_GRACE_MINUTES,
        "source_prefixes": list(SOURCE_PREFIXES),
    }


@pytest.mark.parametrize(
    ("overrides", "error"),
    [
        ({"source_policy_version": 0}, "invalid_source_policy_version"),
        ({"minimum_sources": 1}, "invalid_minimum_sources"),
        ({"minimum_sources": 4}, "invalid_minimum_sources"),
        ({"maximum_source_spread_minutes": 0}, "invalid_maximum_source_spread"),
        ({"maximum_source_spread_minutes": 181}, "invalid_maximum_source_spread"),
        ({"consensus_drift_minutes": 61}, "invalid_consensus_drift"),
        ({"finalization_grace_minutes": 10_081}, "invalid_finalization_grace"),
        (
            {"source_prefix_1": "http://fixtures.flightproof.dev/provider-a/"},
            "source_prefix_must_be_https_and_end_with_slash",
        ),
        (
            {"source_prefix_1": "https://fixtures.flightproof.dev/provider-a"},
            "source_prefix_must_be_https_and_end_with_slash",
        ),
        ({"source_prefix_2": SOURCE_PREFIXES[0]}, "duplicate_source_prefix"),
        (
            {
                "source_prefix_1": "https://shared.flightproof.dev/provider/",
                "source_prefix_2": "https://shared.flightproof.dev/other/",
            },
            "duplicate_source_authority",
        ),
        (
            {
                "source_prefix_1": "https://SHARED.flightproof.dev/provider/",
                "source_prefix_2": "https://shared.flightproof.dev/other/",
            },
            "duplicate_source_authority",
        ),
        (
            {"source_prefix_1": " https://provider-a.flightproof.dev/observations/"},
            "source_prefix_must_be_https_and_end_with_slash",
        ),
        (
            {"source_prefix_1": "https://fixtures.flightproof.dev/../escape/"},
            "unsafe_source_prefix",
        ),
        (
            {"source_prefix_1": "https://fixtures.flightproof.dev/%2e%2e/escape/"},
            "unsafe_source_prefix",
        ),
        (
            {"source_prefix_1": "https://fixtures.flightproof.dev/base/?q=/"},
            "unsafe_source_prefix",
        ),
        (
            {"source_prefix_1": "https://fixtures.flightproof.dev/base/#fragment/"},
            "unsafe_source_prefix",
        ),
        (
            {"source_prefix_1": "https://user@fixtures.flightproof.dev/base/"},
            "unsafe_source_prefix",
        ),
        (
            {"source_prefix_1": "https://fixtures.flightproof.dev/base\\escape/"},
            "unsafe_source_prefix",
        ),
        (
            {"source_prefix_1": "https://fixtures.flightproof.dev/prøvider/"},
            "unsafe_source_prefix",
        ),
        (
            {"source_prefix_1": "https://fixtures.flightproof.dev/" + "x" * 280 + "/"},
            "unsafe_source_prefix",
        ),
        (
            {"source_prefix_2": "", "source_prefix_3": ""},
            "invalid_minimum_sources",
        ),
    ],
)
def test_constructor_rejects_unsafe_policy(
    direct_vm, direct_deploy, overrides, error
):
    with direct_vm.expect_revert(error):
        direct_deploy(
            str(CONTRACT_PATH),
            *_constructor_args(**overrides),
            sdk_version=DIRECT_SDK_VERSION,
        )


def test_build_flight_id_normalizes_codes(flightproof):
    result = flightproof.build_flight_id(
        " ual ",
        "123",
        "ksfo",
        "kjfk",
        SCHEDULED_DEPARTURE_UNIX,
        SCHEDULED_ARRIVAL_UNIX,
    )

    assert result == FLIGHT_ID


def test_registration_is_canonical_and_readable(flightproof):
    flight_id = flightproof.register_flight(*_registration_args())
    registration = flightproof.get_registration(flight_id)

    assert flight_id == FLIGHT_ID
    assert registration == {
        "flight_id": FLIGHT_ID,
        "carrier_icao": CARRIER_ICAO,
        "flight_number": FLIGHT_NUMBER,
        "origin_icao": ORIGIN_ICAO,
        "destination_icao": DESTINATION_ICAO,
        "scheduled_departure_unix": SCHEDULED_DEPARTURE_UNIX,
        "scheduled_arrival_unix": SCHEDULED_ARRIVAL_UNIX,
        "registered_at": REGISTRATION_DATETIME,
    }
    assert flightproof.is_resolved(flight_id) is False
    assert flightproof.evaluate_delay(flight_id, 60) == "PENDING"
    assert flightproof.evaluate_cancellation(flight_id) == "PENDING"


def test_registration_is_idempotent_for_original_registrant(flightproof):
    first = flightproof.register_flight(*_registration_args())
    second = flightproof.register_flight(*_registration_args())

    assert first == second == FLIGHT_ID


def test_repeat_registration_by_another_account_is_idempotent(
    flightproof, direct_vm, direct_bob
):
    flight_id = flightproof.register_flight(*_registration_args())
    original = flightproof.get_registration(flight_id)

    with direct_vm.prank(direct_bob):
        repeated = flightproof.register_flight(*_registration_args())

    assert repeated == flight_id
    assert flightproof.get_registration(flight_id) == original


def test_arrival_is_part_of_identity_and_prevents_schedule_poisoning(flightproof):
    first_id = flightproof.register_flight(*_registration_args())
    alternate_arrival = SCHEDULED_ARRIVAL_UNIX + 30 * 60
    second_id = flightproof.register_flight(
        *_registration_args(scheduled_arrival_unix=alternate_arrival)
    )

    assert first_id != second_id
    assert second_id.endswith(f"-{SCHEDULED_DEPARTURE_UNIX}-{alternate_arrival}")
    assert flightproof.get_registration(first_id)["scheduled_arrival_unix"] == (
        SCHEDULED_ARRIVAL_UNIX
    )
    assert flightproof.get_registration(second_id)["scheduled_arrival_unix"] == (
        alternate_arrival
    )


@pytest.mark.parametrize(
    ("overrides", "error"),
    [
        ({"carrier_icao": "UA"}, "invalid_carrier_icao"),
        ({"carrier_icao": "U@L"}, "invalid_carrier_icao"),
        ({"carrier_icao": "UÅL"}, "invalid_carrier_icao"),
        ({"flight_number": ""}, "invalid_flight_number"),
        ({"flight_number": "1234567"}, "invalid_flight_number"),
        ({"flight_number": "0123"}, "invalid_flight_number"),
        ({"flight_number": "12-3"}, "invalid_flight_number"),
        ({"flight_number": "１２３"}, "invalid_flight_number"),
        ({"origin_icao": "SFO"}, "invalid_origin_icao"),
        ({"destination_icao": "J!FK"}, "invalid_destination_icao"),
        ({"destination_icao": ORIGIN_ICAO}, "origin_equals_destination"),
        ({"scheduled_departure_unix": 0}, "invalid_schedule"),
        (
            {"scheduled_arrival_unix": SCHEDULED_DEPARTURE_UNIX},
            "invalid_schedule",
        ),
        (
            {
                "scheduled_arrival_unix": (
                    SCHEDULED_DEPARTURE_UNIX + 48 * 60 * 60 + 1
                )
            },
            "schedule_duration_too_long",
        ),
    ],
)
def test_registration_rejects_invalid_identity_or_schedule(
    flightproof, direct_vm, overrides, error
):
    with direct_vm.expect_revert(error):
        flightproof.register_flight(*_registration_args(**overrides))


def test_missing_records_revert(flightproof, direct_vm):
    with direct_vm.expect_revert("flight_not_registered"):
        flightproof.get_registration("missing")

    with direct_vm.expect_revert("flight_not_resolved"):
        flightproof.get_resolution("missing")

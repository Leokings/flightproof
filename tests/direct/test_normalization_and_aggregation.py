"""Direct unit coverage for source normalization and quorum aggregation."""

from __future__ import annotations

import json
from pathlib import Path
import sys

import pytest

from fixtures.flight_data import (
    FLIGHT_ID,
    SCHEDULED_ARRIVAL_UNIX,
    SCHEDULED_DEPARTURE_UNIX,
    observation,
)


@pytest.fixture
def contract_module(flightproof):
    instance = object.__getattribute__(flightproof, "_instance")
    return sys.modules[type(instance).__module__]


@pytest.mark.parametrize(
    ("status", "expected_actual"),
    [
        ("ARRIVED", SCHEDULED_ARRIVAL_UNIX + 60 * 60),
        ("CANCELLED", 0),
        ("DIVERTED", SCHEDULED_ARRIVAL_UNIX + 60 * 60),
    ],
)
def test_normalize_accepts_explicit_final_states(
    contract_module, status, expected_actual
):
    normalized = contract_module._normalize_observation(
        observation(status=status),
        FLIGHT_ID,
        SCHEDULED_DEPARTURE_UNIX,
        SCHEDULED_ARRIVAL_UNIX,
    )

    assert normalized == {
        "status": status,
        "actual_arrival_unix": expected_actual,
    }


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        observation(schema="flightproof/v0"),
        observation(flight_id="UAL-999-KSFO-KJFK-1800000000"),
        observation(final=False),
        observation(status="UNKNOWN"),
        observation(scheduled_arrival_unix=SCHEDULED_ARRIVAL_UNIX + 60),
        observation(status="ARRIVED", cancelled=True),
        observation(status="ARRIVED", cancelled=0),
        observation(status="CANCELLED", cancelled=False),
        observation(status="DIVERTED", diverted=False),
        observation(status="DIVERTED", diverted=1),
        observation(status="ARRIVED", arrival_time_definition="RUNWAY_ON"),
        observation(status="DIVERTED", arrival_time_definition="RUNWAY_ON"),
        observation(status="DIVERTED", actual_arrival_unix=0),
        observation(
            status="ARRIVED",
            actual_arrival_unix=SCHEDULED_DEPARTURE_UNIX - 1,
        ),
        observation(
            status="ARRIVED",
            actual_arrival_unix=SCHEDULED_ARRIVAL_UNIX + 8 * 24 * 60 * 60,
        ),
        observation(status="CANCELLED", actual_arrival_unix=1),
        observation(actual_arrival_unix="not-an-integer"),
        observation(actual_arrival_unix=True),
        observation(actual_arrival_unix=float("inf")),
        observation(scheduled_arrival_unix=True),
    ],
)
def test_normalize_rejects_malformed_or_nonfinal_payloads(
    contract_module, payload
):
    assert (
        contract_module._normalize_observation(
            payload,
            FLIGHT_ID,
            SCHEDULED_DEPARTURE_UNIX,
            SCHEDULED_ARRIVAL_UNIX,
        )
        is None
    )


def test_aggregate_builds_conservative_delay_interval(contract_module):
    observations = [
        {
            "status": "ARRIVED",
            "actual_arrival_unix": SCHEDULED_ARRIVAL_UNIX + 60 * 60,
        },
        {
            "status": "ARRIVED",
            "actual_arrival_unix": SCHEDULED_ARRIVAL_UNIX + 61 * 60,
        },
        {"status": "CANCELLED", "actual_arrival_unix": 0},
    ]

    result = contract_module._aggregate_observations(
        observations,
        FLIGHT_ID,
        SCHEDULED_ARRIVAL_UNIX,
        2,
        15,
        2,
    )

    assert result == {
        "schema": "flightproof/result/v1",
        "flight_id": FLIGHT_ID,
        "status": "ARRIVED",
        "arrival_time_definition": "GATE_IN",
        "scheduled_arrival_unix": SCHEDULED_ARRIVAL_UNIX,
        "actual_arrival_lower_unix": SCHEDULED_ARRIVAL_UNIX + 60 * 60,
        "actual_arrival_upper_unix": SCHEDULED_ARRIVAL_UNIX + 61 * 60,
        "delay_lower_bound_minutes": 58,
        "delay_upper_bound_minutes": 63,
        "source_count": 2,
    }


def test_aggregate_accepts_spread_at_exact_policy_boundary(contract_module):
    result = contract_module._aggregate_observations(
        [
            {
                "status": "ARRIVED",
                "actual_arrival_unix": SCHEDULED_ARRIVAL_UNIX + 60 * 60,
            },
            {
                "status": "ARRIVED",
                "actual_arrival_unix": SCHEDULED_ARRIVAL_UNIX + 75 * 60,
            },
        ],
        FLIGHT_ID,
        SCHEDULED_ARRIVAL_UNIX,
        2,
        15,
        0,
    )

    assert result["delay_lower_bound_minutes"] == 60
    assert result["delay_upper_bound_minutes"] == 75


def test_aggregate_rejects_arrival_spread_beyond_policy(
    contract_module, direct_vm
):
    with direct_vm.expect_revert("arrival_sources_too_far_apart"):
        contract_module._aggregate_observations(
            [
                {
                    "status": "ARRIVED",
                    "actual_arrival_unix": SCHEDULED_ARRIVAL_UNIX + 60 * 60,
                },
                {
                    "status": "ARRIVED",
                    "actual_arrival_unix": SCHEDULED_ARRIVAL_UNIX + 76 * 60,
                },
            ],
            FLIGHT_ID,
            SCHEDULED_ARRIVAL_UNIX,
            2,
            15,
            2,
        )


def test_aggregate_rejects_tie_or_subquorum(contract_module, direct_vm):
    with direct_vm.expect_revert("insufficient_source_agreement"):
        contract_module._aggregate_observations(
            [
                {"status": "ARRIVED", "actual_arrival_unix": 1},
                {"status": "CANCELLED", "actual_arrival_unix": 0},
            ],
            FLIGHT_ID,
            SCHEDULED_ARRIVAL_UNIX,
            2,
            15,
            2,
        )


def test_public_demo_fixtures_match_schema_and_documented_interval(
    contract_module,
):
    project_root = Path(__file__).resolve().parents[2]
    suffix = Path("BAW/75/EGLL/DNMM/1781268000/1781298600")
    payloads = [
        json.loads(
            (project_root / "fixtures" / "demo" / provider / suffix).read_text(
                encoding="utf-8"
            )
        )
        for provider in ("provider-a", "provider-b")
    ]
    flight_id = "BAW-75-EGLL-DNMM-1781268000-1781298600"
    normalized = [
        contract_module._normalize_observation(
            payload,
            flight_id,
            1781268000,
            1781298600,
        )
        for payload in payloads
    ]

    assert normalized == [
        {"status": "ARRIVED", "actual_arrival_unix": 1781302440},
        {"status": "ARRIVED", "actual_arrival_unix": 1781302560},
    ]

    result = contract_module._aggregate_observations(
        normalized,
        flight_id,
        1781298600,
        2,
        15,
        2,
    )
    assert result["delay_lower_bound_minutes"] == 62
    assert result["delay_upper_bound_minutes"] == 68

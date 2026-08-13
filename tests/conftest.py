"""Shared FlightProof test fixtures."""

from __future__ import annotations

from pathlib import Path
import sys

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fixtures.flight_data import (
    CARRIER_ICAO,
    DESTINATION_ICAO,
    FINALIZATION_GRACE_MINUTES,
    FLIGHT_NUMBER,
    ORIGIN_ICAO,
    REGISTRATION_DATETIME,
    SCHEDULED_ARRIVAL_UNIX,
    SCHEDULED_DEPARTURE_UNIX,
    SOURCE_PREFIXES,
)
from tests.gltest_windows_compat import install_windows_direct_compatibility


CONTRACT_PATH = PROJECT_ROOT / "contracts" / "flight_proof.py"
DIRECT_SDK_VERSION = "v0.2.16"


install_windows_direct_compatibility()


@pytest.fixture
def flightproof(direct_vm, direct_deploy, direct_alice):
    """Deploy the standard 2-of-3 source policy as Alice."""
    direct_vm.sender = direct_alice
    direct_vm.warp(REGISTRATION_DATETIME)
    return direct_deploy(
        str(CONTRACT_PATH),
        1,
        2,
        15,
        2,
        FINALIZATION_GRACE_MINUTES,
        *SOURCE_PREFIXES,
        sdk_version=DIRECT_SDK_VERSION,
    )


@pytest.fixture
def registered_flight(flightproof):
    """Return a standard deployed contract and its registered flight ID."""
    flight_id = flightproof.register_flight(
        CARRIER_ICAO,
        FLIGHT_NUMBER,
        ORIGIN_ICAO,
        DESTINATION_ICAO,
        SCHEDULED_DEPARTURE_UNIX,
        SCHEDULED_ARRIVAL_UNIX,
    )
    return flightproof, flight_id

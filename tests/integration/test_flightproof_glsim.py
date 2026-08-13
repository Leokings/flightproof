"""GLSim consensus tests with deterministic multi-provider responses."""

from __future__ import annotations

import json
from pathlib import Path

from gltest import get_contract_factory, get_validator_factory
from gltest.assertions import tx_execution_failed, tx_execution_succeeded
from gltest.types import TransactionStatus
from gltest.utils import extract_contract_address

from fixtures.flight_data import (
    CARRIER_ICAO,
    DESTINATION_ICAO,
    EVIDENCE_URLS,
    FINALIZATION_GRACE_MINUTES,
    FLIGHT_ID,
    FLIGHT_NUMBER,
    ORIGIN_ICAO,
    RESOLUTION_DATETIME,
    SCHEDULED_ARRIVAL_UNIX,
    SCHEDULED_DEPARTURE_UNIX,
    SOURCE_PREFIXES,
    mock_response,
    observation,
)


def _receipt_dump(receipt):
    return json.dumps(receipt, indent=2, sort_keys=True, default=str)


def _validator_context(payloads):
    web_responses = {
        url: mock_response(payload)
        for url, payload in zip(EVIDENCE_URLS, payloads)
    }
    validators = get_validator_factory().batch_create_mock_validators(
        5,
        mock_web_response={"nondet_web_request": web_responses},
    )
    return {
        "validators": [validator.to_dict() for validator in validators],
        "genvm_datetime": RESOLUTION_DATETIME,
    }


def _deploy_contract():
    contract_path = Path(__file__).resolve().parents[2] / "contracts" / "flight_proof.py"
    factory = get_contract_factory(contract_file_path=contract_path)
    receipt = factory.deploy_contract_tx(
        args=[
            1,
            2,
            15,
            2,
            FINALIZATION_GRACE_MINUTES,
            *SOURCE_PREFIXES,
        ],
        wait_transaction_status=TransactionStatus.FINALIZED,
    )
    assert tx_execution_succeeded(receipt), _receipt_dump(receipt)
    address = extract_contract_address(receipt)
    return factory.build_contract(address)


def _register(contract):
    receipt = contract.register_flight(
        args=[
            CARRIER_ICAO,
            FLIGHT_NUMBER,
            ORIGIN_ICAO,
            DESTINATION_ICAO,
            SCHEDULED_DEPARTURE_UNIX,
            SCHEDULED_ARRIVAL_UNIX,
        ]
    ).transact(wait_transaction_status=TransactionStatus.FINALIZED)
    assert tx_execution_succeeded(receipt), _receipt_dump(receipt)


def test_glsim_consensus_finalizes_arrival_and_persists_decision():
    contract = _deploy_contract()
    _register(contract)
    context = _validator_context(
        [
            observation(delay_minutes=60),
            observation(delay_minutes=61),
            observation(status="CANCELLED"),
        ]
    )

    receipt = contract.resolve_flight(args=[FLIGHT_ID]).transact(
        transaction_context=context,
        wait_transaction_status=TransactionStatus.FINALIZED,
    )
    assert tx_execution_succeeded(receipt), _receipt_dump(receipt)

    outcome = contract.get_resolution(args=[FLIGHT_ID]).call()
    assert outcome["schema"] == "flightproof/result/v1"
    assert outcome["status"] == "ARRIVED"
    assert outcome["source_count"] == 2
    assert outcome["evidence_urls"] == list(EVIDENCE_URLS)
    assert outcome["delay_lower_bound_minutes"] == 58
    assert outcome["delay_upper_bound_minutes"] == 63
    assert contract.evaluate_delay(args=[FLIGHT_ID, 60]).call() == "INCONCLUSIVE"
    assert contract.evaluate_cancellation(args=[FLIGHT_ID]).call() == "FALSE"


def test_glsim_consensus_requires_explicit_cancellation_evidence():
    contract = _deploy_contract()
    _register(contract)
    context = _validator_context(
        [
            observation(status="CANCELLED"),
            observation(status="CANCELLED"),
            observation(),
        ]
    )

    receipt = contract.resolve_flight(args=[FLIGHT_ID]).transact(
        transaction_context=context,
        wait_transaction_status=TransactionStatus.FINALIZED,
    )
    assert tx_execution_succeeded(receipt), _receipt_dump(receipt)

    assert contract.get_resolution(args=[FLIGHT_ID]).call()["status"] == "CANCELLED"
    assert contract.evaluate_cancellation(args=[FLIGHT_ID]).call() == "TRUE"
    assert contract.evaluate_delay(args=[FLIGHT_ID, 60]).call() == "NOT_APPLICABLE"


def test_glsim_failed_source_quorum_does_not_persist_resolution():
    contract = _deploy_contract()
    _register(contract)
    web_responses = {
        EVIDENCE_URLS[0]: mock_response(observation(delay_minutes=60)),
        EVIDENCE_URLS[1]: mock_response(status=503, body="upstream down"),
        EVIDENCE_URLS[2]: mock_response(body="not-json"),
    }
    validators = get_validator_factory().batch_create_mock_validators(
        5,
        mock_web_response={"nondet_web_request": web_responses},
    )
    context = {
        "validators": [validator.to_dict() for validator in validators],
        "genvm_datetime": RESOLUTION_DATETIME,
    }

    receipt = contract.resolve_flight(args=[FLIGHT_ID]).transact(
        transaction_context=context,
        wait_transaction_status=TransactionStatus.FINALIZED,
    )
    assert tx_execution_failed(receipt), _receipt_dump(receipt)
    assert contract.is_resolved(args=[FLIGHT_ID]).call() is False

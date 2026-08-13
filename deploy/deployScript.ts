import { readFileSync } from "node:fs";
import path from "node:path";

import { localnet } from "genlayer-js/chains";
import {
  type DecodedDeployData,
  ExecutionResult,
  type GenLayerChain,
  type GenLayerClient,
  type TransactionHash,
  TransactionStatus,
} from "genlayer-js/types";

function validatePrefix(name: string, value: string): string {
  if (!value.startsWith("https://") || !value.endsWith("/")) {
    throw new Error(`${name} must be an HTTPS prefix ending in /`);
  }
  const authorityEnd = value.indexOf("/", "https://".length);
  if (
    authorityEnd <= "https://".length ||
    value.length > 300 ||
    /[^\x20-\x7e]/.test(value) ||
    /[\s%?#@\\]/.test(value) ||
    value.includes("..")
  ) {
    throw new Error(`${name} contains an unsafe URL prefix`);
  }
  return value;
}

function requiredPrefix(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return validatePrefix(name, value);
}

function optionalPrefix(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  return value ? validatePrefix(name, value) : "";
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export default async function main(client: GenLayerClient<GenLayerChain>) {
  const prefix1 = requiredPrefix("FLIGHTPROOF_SOURCE_PREFIX_1");
  const prefix2 = requiredPrefix("FLIGHTPROOF_SOURCE_PREFIX_2");
  const prefix3 = optionalPrefix("FLIGHTPROOF_SOURCE_PREFIX_3");
  const prefixes = [prefix1, prefix2, prefix3].filter(Boolean);
  if (new Set(prefixes).size !== prefixes.length) {
    throw new Error("Source prefixes must be unique");
  }
  const authorities = prefixes.map((prefix) => new URL(prefix).origin.toLowerCase());
  if (new Set(authorities).size !== authorities.length) {
    throw new Error("Each source prefix must use a different URL authority");
  }
  for (const prefix of prefixes) {
    for (const other of prefixes) {
      if (prefix !== other && (prefix.startsWith(other) || other.startsWith(prefix))) {
        throw new Error("Source prefixes must not overlap");
      }
    }
  }

  const sourcePolicyVersion = positiveInteger(
    "FLIGHTPROOF_SOURCE_POLICY_VERSION",
    1,
  );
  const minimumSources = positiveInteger("FLIGHTPROOF_MINIMUM_SOURCES", 2);
  const maximumSpread = positiveInteger(
    "FLIGHTPROOF_MAXIMUM_SOURCE_SPREAD_MINUTES",
    15,
  );
  const consensusDrift = nonNegativeInteger(
    "FLIGHTPROOF_CONSENSUS_DRIFT_MINUTES",
    2,
  );
  if (maximumSpread > 180) {
    throw new Error("Maximum source spread cannot exceed 180 minutes");
  }
  if (consensusDrift > 60) {
    throw new Error("Consensus drift cannot exceed 60 minutes");
  }
  const finalizationGrace = nonNegativeInteger(
    "FLIGHTPROOF_FINALIZATION_GRACE_MINUTES",
    60,
  );
  if (finalizationGrace > 7 * 24 * 60) {
    throw new Error("Finalization grace cannot exceed seven days");
  }
  if (minimumSources < 2 || minimumSources > prefixes.length) {
    throw new Error("Minimum sources must be between 2 and active source count");
  }
  const receiptRetries = positiveInteger(
    "FLIGHTPROOF_RECEIPT_RETRIES",
    1_440,
  );
  const receiptIntervalMs = positiveInteger(
    "FLIGHTPROOF_RECEIPT_INTERVAL_MS",
    5_000,
  );
  if (receiptRetries > 10_000) {
    throw new Error("Receipt retries cannot exceed 10000");
  }
  if (receiptIntervalMs < 1_000 || receiptIntervalMs > 60_000) {
    throw new Error("Receipt interval must be between 1000 and 60000 ms");
  }

  const contractPath = path.resolve(
    process.cwd(),
    "contracts/flight_proof.py",
  );
  const code = new Uint8Array(readFileSync(contractPath));

  await client.initializeConsensusSmartContract();
  const hash = await client.deployContract({
    code,
    args: [
      sourcePolicyVersion,
      minimumSources,
      maximumSpread,
      consensusDrift,
      finalizationGrace,
      prefix1,
      prefix2,
      prefix3,
    ],
  });
  console.log(`Transaction: ${hash}`);

  const receipt = await client.waitForTransactionReceipt({
    hash: hash as TransactionHash,
    status: TransactionStatus.FINALIZED,
    retries: receiptRetries,
    interval: receiptIntervalMs,
  });

  if (
    receipt.statusName !== "FINALIZED" &&
    receipt.status !== TransactionStatus.FINALIZED
  ) {
    throw new Error(`Deployment did not succeed: ${JSON.stringify(receipt)}`);
  }
  if (receipt.txExecutionResultName !== ExecutionResult.FINISHED_WITH_RETURN) {
    throw new Error(
      `Deployment finalized but GenVM execution failed: ${receipt.txExecutionResultName}`,
    );
  }

  const address =
    (client.chain as GenLayerChain).id === localnet.id
      ? receipt.data?.contract_address
      : (receipt.txDataDecoded as DecodedDeployData | undefined)?.contractAddress;
  if (!address) {
    throw new Error(
      `Deployment reached ${receipt.statusName ?? receipt.status} without a contract address`,
    );
  }

  console.log(`FlightProof deployed at ${address}`);
  return { address, hash };
}

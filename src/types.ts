// Public result types. All byte strings are lower-case hex. Integers that the ledger encodes as
// unbounded or 64-bit values (lovelace, asset quantities, slots, epochs, execution units,
// metadata and Plutus integers) are `bigint`; use `toJson()` to get a JSON-safe copy.

/** Ledger era of a block, as identified by the hard-fork-combinator wrapper tag. */
export type Era =
  | "byron-ebb"
  | "byron"
  | "shelley"
  | "allegra"
  | "mary"
  | "alonzo"
  | "babbage"
  | "conway"
  /** A future era tag; decoded best-effort with the latest (Conway) rules. */
  | "unknown";

export type ShelleyEra = "shelley" | "allegra" | "mary" | "alonzo" | "babbage" | "conway" | "unknown";

/** Exact rational number (unit intervals, prices, margins). */
export interface Rational {
  numerator: bigint;
  denominator: bigint;
}

export interface Credential {
  type: "key" | "script";
  /** 28-byte key hash or script hash. */
  hash: string;
}

export interface Address {
  /** Raw address bytes. */
  hex: string;
  /** Bech32 form (CIP-19) for Shelley addresses: `addr…`, `addr_test…`, `stake…`, `stake_test…`. */
  bech32?: string;
  /** Base58 form for Byron (bootstrap) addresses. */
  base58?: string;
  type: "base" | "pointer" | "enterprise" | "reward" | "byron" | "unknown";
  /** Address type nibble (header bits 7–4); 8 for Byron. */
  typeId: number;
  /** Network id from the header (1 = mainnet, 0 = testnets). Absent for Byron. */
  networkId?: number;
  paymentCredential?: Credential;
  stakeCredential?: Credential;
  pointer?: { slot: bigint; txIndex: bigint; certIndex: bigint };
}

export interface Asset {
  policyId: string;
  /** Asset name bytes (hex). */
  assetName: string;
  /** Asset name as UTF-8 when it decodes to printable text. */
  assetNameUtf8?: string;
  /** CIP-14 asset fingerprint (`asset1…`). */
  fingerprint: string;
  /** Quantity (negative values only occur in `mint`, meaning burn). */
  quantity: bigint;
}

export interface Value {
  lovelace: bigint;
  assets: Asset[];
}

export interface TxInput {
  txId: string;
  index: number;
}

export type PlutusData =
  | { constructor: number | bigint; fields: PlutusData[] }
  | { map: Array<{ k: PlutusData; v: PlutusData }> }
  | { list: PlutusData[] }
  | { int: bigint }
  | { bytes: string };

export interface Datum {
  /** blake2b-256 of the datum CBOR. */
  hash: string;
  /** Original CBOR (hex). */
  cbor: string;
  /** Detailed-schema JSON of the Plutus data. */
  json: PlutusData;
}

export type NativeScript =
  | { type: "sig"; keyHash: string }
  | { type: "all"; scripts: NativeScript[] }
  | { type: "any"; scripts: NativeScript[] }
  | { type: "atLeast"; required: bigint; scripts: NativeScript[] }
  /** `invalid_before`: valid from this slot on. */
  | { type: "after"; slot: bigint }
  /** `invalid_hereafter`: valid strictly before this slot. */
  | { type: "before"; slot: bigint };

export type Script =
  | { language: "native"; hash: string; size: number; cbor: string; script: NativeScript }
  | { language: "plutusV1" | "plutusV2" | "plutusV3"; hash: string; size: number; cbor: string }
  | { language: "unknown"; languageId: number; cbor: string };

export interface TxOutput {
  index: number;
  address: Address;
  value: Value;
  /** `legacy` = array encoding (all eras), `map` = post-Alonzo map encoding. */
  format: "legacy" | "map";
  datumHash?: string;
  inlineDatum?: Datum;
  scriptRef?: Script;
}

export interface Anchor {
  url: string;
  dataHash: string;
}

export type DRep =
  | { type: "key" | "script"; hash: string; id: string }
  | { type: "alwaysAbstain" }
  | { type: "alwaysNoConfidence" };

export type Relay =
  | { type: "singleHostAddr"; port: number | null; ipv4: string | null; ipv6: string | null }
  | { type: "singleHostName"; port: number | null; dnsName: string }
  | { type: "multiHostName"; dnsName: string };

export interface PoolParams {
  operator: string;
  /** CIP-5 `pool1…` id. */
  poolId: string;
  vrfKeyHash: string;
  pledge: bigint;
  cost: bigint;
  margin: Rational;
  rewardAccount: Address;
  owners: string[];
  relays: Relay[];
  metadata: Anchor | null;
}

export type Certificate =
  | { type: "stakeRegistration"; credential: Credential }
  | { type: "stakeDeregistration"; credential: Credential }
  | { type: "stakeDelegation"; credential: Credential; poolId: string; pool: string }
  | ({ type: "poolRegistration" } & PoolParams)
  | { type: "poolRetirement"; pool: string; poolId: string; epoch: bigint }
  | { type: "genesisKeyDelegation"; genesisHash: string; genesisDelegateHash: string; vrfKeyHash: string }
  | {
      type: "moveInstantaneousRewards";
      pot: "reserves" | "treasury";
      rewards?: Array<{ credential: Credential; amount: bigint }>;
      /** Transfer to the other pot (Alonzo+). */
      otherPot?: bigint;
    }
  | { type: "registration"; credential: Credential; deposit: bigint }
  | { type: "unregistration"; credential: Credential; refund: bigint }
  | { type: "voteDelegation"; credential: Credential; drep: DRep }
  | { type: "stakeVoteDelegation"; credential: Credential; pool: string; poolId: string; drep: DRep }
  | { type: "stakeRegistrationDelegation"; credential: Credential; pool: string; poolId: string; deposit: bigint }
  | { type: "voteRegistrationDelegation"; credential: Credential; drep: DRep; deposit: bigint }
  | {
      type: "stakeVoteRegistrationDelegation";
      credential: Credential;
      pool: string;
      poolId: string;
      drep: DRep;
      deposit: bigint;
    }
  | { type: "committeeHotAuthorization"; coldCredential: Credential; hotCredential: Credential; coldId: string; hotId: string }
  | { type: "committeeColdResignation"; coldCredential: Credential; coldId: string; anchor: Anchor | null }
  | { type: "drepRegistration"; credential: Credential; drepId: string; deposit: bigint; anchor: Anchor | null }
  | { type: "drepUnregistration"; credential: Credential; drepId: string; refund: bigint }
  | { type: "drepUpdate"; credential: Credential; drepId: string; anchor: Anchor | null }
  | { type: "unknown"; tag: number; cbor: string };

export interface Withdrawal {
  rewardAccount: Address;
  amount: bigint;
}

export interface GovActionId {
  txId: string;
  index: number;
  /** CIP-129 `gov_action1…` id. */
  id: string;
}

export interface ExUnits {
  memory: bigint;
  steps: bigint;
}

/**
 * Protocol parameter update. Known keys are named (see README); keys this library does not know
 * appear as `unknown_<n>` with their CBOR hex.
 */
export type ProtocolParamUpdate = Record<string, unknown>;

export type GovAction =
  | { type: "parameterChange"; prevActionId: GovActionId | null; update: ProtocolParamUpdate; policyHash: string | null }
  | { type: "hardForkInitiation"; prevActionId: GovActionId | null; protocolVersion: { major: number; minor: number } }
  | { type: "treasuryWithdrawals"; withdrawals: Withdrawal[]; policyHash: string | null }
  | { type: "noConfidence"; prevActionId: GovActionId | null }
  | {
      type: "updateCommittee";
      prevActionId: GovActionId | null;
      removed: Credential[];
      added: Array<{ credential: Credential; expiresEpoch: bigint }>;
      quorum: Rational;
    }
  | { type: "newConstitution"; prevActionId: GovActionId | null; constitution: { anchor: Anchor; scriptHash: string | null } }
  | { type: "info" }
  | { type: "unknown"; tag: number; cbor: string };

export interface ProposalProcedure {
  deposit: bigint;
  rewardAccount: Address;
  govAction: GovAction;
  anchor: Anchor;
}

export type VoterRole =
  | "constitutionalCommitteeHotKey"
  | "constitutionalCommitteeHotScript"
  | "drepKey"
  | "drepScript"
  | "stakePoolKey";

export interface Voter {
  role: VoterRole;
  hash: string;
  /** CIP-129 (`cc_hot1…`, `drep1…`) or CIP-5 (`pool1…`) id. */
  id: string;
}

export interface VotingProcedures {
  voter: Voter;
  votes: Array<{ govActionId: GovActionId; vote: "no" | "yes" | "abstain"; anchor: Anchor | null }>;
}

export interface Update {
  proposals: Array<{ genesisKeyHash: string; parameters: ProtocolParamUpdate }>;
  epoch: bigint;
}

export interface VkeyWitness {
  vkey: string;
  /** blake2b-224 of the verification key (matches required signers / payment key hashes). */
  keyHash: string;
  signature: string;
}

export interface BootstrapWitness {
  vkey: string;
  signature: string;
  chainCode: string;
  attributes: string;
}

export type RedeemerTag = "spend" | "mint" | "cert" | "reward" | "vote" | "propose" | "unknown";

export interface Redeemer {
  tag: RedeemerTag;
  tagId: number;
  index: number;
  data: PlutusData;
  dataCbor: string;
  exUnits: ExUnits;
}

export interface Witnesses {
  vkeys: VkeyWitness[];
  bootstraps: BootstrapWitness[];
  /** Native and Plutus scripts included in the witness set, with their script hashes. */
  scripts: Script[];
  datums: Datum[];
  redeemers: Redeemer[];
  /** Witness-set keys this library does not know, as CBOR hex. */
  unknown?: Array<{ key: number; cbor: string }>;
}

export type Metadatum =
  | { int: bigint }
  | { bytes: string }
  | { string: string }
  | { list: Metadatum[] }
  | { map: Array<{ k: Metadatum; v: Metadatum }> };

export interface AuxiliaryData {
  /** blake2b-256 of the auxiliary data CBOR (compare with `auxiliaryDataHash`). */
  hash: string;
  format: "shelley" | "shelley-ma" | "alonzo";
  /** Transaction metadata (CIP-10 labels), in encoding order. */
  metadata: Array<{ label: bigint; value: Metadatum }>;
  scripts: Script[];
  cbor?: string;
}

export interface Transaction {
  /** Position in the block. */
  index: number;
  /** Transaction id: blake2b-256 of the transaction body CBOR. */
  id: string;
  /** `false` for Alonzo+ transactions listed as invalid (phase-2 failure; only collateral is consumed). */
  valid: boolean;
  /**
   * Transaction size in bytes as the ledger measures it for fees: the CBOR of
   * `[body, witnesses, auxiliaryData / null]` (the Alonzo+ `isValid` flag is not counted).
   */
  size: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  fee: bigint;
  /** Sum of lovelace in `outputs`. */
  outputLovelace: bigint;
  ttl?: bigint;
  validityStart?: bigint;
  certificates?: Certificate[];
  withdrawals?: Withdrawal[];
  update?: Update;
  auxiliaryDataHash?: string;
  mint?: Asset[];
  scriptDataHash?: string;
  collateral?: TxInput[];
  requiredSigners?: string[];
  networkId?: number;
  collateralReturn?: TxOutput;
  totalCollateral?: bigint;
  referenceInputs?: TxInput[];
  votingProcedures?: VotingProcedures[];
  proposalProcedures?: ProposalProcedure[];
  currentTreasuryValue?: bigint;
  donation?: bigint;
  /** Body keys this library does not know, as CBOR hex. */
  unknownFields?: Array<{ key: number; cbor: string }>;
  witnesses: Witnesses;
  auxiliaryData?: AuxiliaryData;
  /** Present with `includeCbor: true`. */
  cbor?: { body: string; witnesses: string; auxiliaryData?: string };
}

export interface VrfCert {
  output: string;
  proof: string;
}

export interface BlockHeader {
  blockNumber: bigint;
  slot: bigint;
  /** Hash of the previous block, `null` for the first block after genesis. */
  prevHash: string | null;
  issuerVkey: string;
  /** blake2b-224 of the issuer cold key (pool key hash). */
  issuerPoolHash: string;
  /** CIP-5 `pool1…` id of the issuer. */
  issuerPoolId: string;
  vrfVkey: string;
  /** Praos (Babbage+): single VRF result. */
  vrfResult?: VrfCert;
  /** TPraos (Shelley–Alonzo): nonce VRF. */
  nonceVrf?: VrfCert;
  /** TPraos (Shelley–Alonzo): leader VRF. */
  leaderVrf?: VrfCert;
  bodySize: number;
  bodyHash: string;
  operationalCert: { hotVkey: string; sequenceNumber: bigint; kesPeriod: bigint; sigma: string };
  protocolVersion: { major: number; minor: number };
  kesSignature: string;
  /** Size of the header CBOR in bytes. */
  size: number;
}

export interface BlockIntegrity {
  /** Header field `bodyHash` equals the hash recomputed from the body segments. */
  bodyHashValid: boolean;
  computedBodyHash: string;
  /** Header field `bodySize` equals the byte length of the body segments. */
  bodySizeValid: boolean;
  computedBodySize: number;
  /** Every transaction with auxiliary data has a matching `auxiliaryDataHash`. */
  auxiliaryDataHashesValid: boolean;
}

export interface BlockStats {
  transactionCount: number;
  invalidTransactionCount: number;
  totalFees: bigint;
  totalOutputLovelace: bigint;
  /** Sum of the sizes of all transactions. */
  totalTxSize: number;
}

export interface ShelleyBlock {
  era: ShelleyEra;
  /** Hard-fork-combinator era tag (2 = Shelley … 7 = Conway). */
  eraTag: number;
  /** Block (header) hash: blake2b-256 of the header CBOR. */
  hash: string;
  slot: bigint;
  blockNumber: bigint;
  /** Size of the era block CBOR in bytes. */
  size: number;
  header: BlockHeader;
  transactions: Transaction[];
  /** Indices of transactions that failed phase-2 validation (Alonzo+). */
  invalidTransactions: number[];
  stats: BlockStats;
  integrity: BlockIntegrity;
  /** Non-fatal anomalies (unknown fields, unexpected encodings). */
  warnings: string[];
  /** Raw era block CBOR (hex); present with `includeCbor: true`. */
  cbor?: string;
}

export interface ByronTxOutput {
  index: number;
  address: Address;
  lovelace: bigint;
}

export interface ByronTransaction {
  index: number;
  /** blake2b-256 of the transaction CBOR. */
  id: string;
  /** Size of the transaction CBOR (without witnesses). */
  size: number;
  inputs: Array<TxInput & { type: number }>;
  outputs: ByronTxOutput[];
  outputLovelace: bigint;
  attributes: string;
  witnesses: Array<{ type: "pk" | "script" | "redeem" | "unknown"; typeId: number; cbor: string; vkey?: string; signature?: string }>;
  cbor?: string;
}

export interface ByronBlock {
  era: "byron";
  eraTag: 1;
  hash: string;
  /** Absolute slot (`epoch * slotsPerEpoch + slotInEpoch`). */
  slot: bigint;
  epoch: bigint;
  slotInEpoch: bigint;
  /** Chain difficulty, i.e. the block number. */
  blockNumber: bigint;
  size: number;
  header: {
    protocolMagic: number;
    prevHash: string;
    issuerVkey: string;
    bodyProof: string;
    signature: string;
    protocolVersion: { major: number; minor: number; alt: number } | null;
    softwareVersion: { name: string; version: number } | null;
    size: number;
  };
  transactions: ByronTransaction[];
  /** Other body payloads (shared seed computation, delegation, update), as CBOR hex. */
  payloads: { ssc: string; delegation: string; update: string };
  stats: { transactionCount: number; totalOutputLovelace: bigint; totalTxSize: number };
  warnings: string[];
  cbor?: string;
}

export interface ByronEpochBoundaryBlock {
  era: "byron-ebb";
  eraTag: 0;
  hash: string;
  slot: bigint;
  epoch: bigint;
  blockNumber: bigint;
  size: number;
  header: { protocolMagic: number; prevHash: string; bodyProof: string; size: number };
  /** Stakeholder ids listed in the boundary block body. */
  stakeholders: string[];
  transactions: [];
  warnings: string[];
  cbor?: string;
}

export type DecodedBlock = ShelleyBlock | ByronBlock | ByronEpochBoundaryBlock;

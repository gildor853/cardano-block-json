/**
 * Machine-readable error codes thrown by this library.
 *
 * - `INVALID_ARGUMENT` – a caller-supplied option is malformed (relay, point, network, timeout…).
 * - `CBOR_DECODE` – the bytes are not well-formed CBOR (truncated, invalid header, limits exceeded).
 * - `BLOCK_DECODE` – the CBOR is well formed but does not match any supported block structure.
 * - `CONNECTION` – TCP connection failed, was reset or closed early.
 * - `TIMEOUT` – the overall operation exceeded `timeoutMs`.
 * - `HANDSHAKE_REFUSED` – the relay refused all proposed node-to-node versions (wrong network magic, …).
 * - `PROTOCOL` – the relay sent an unexpected or malformed mini-protocol message.
 * - `NO_BLOCKS` – the relay answered `MsgNoBlocks`: it does not have the requested point.
 * - `BLOCK_MISMATCH` – the relay returned a block whose slot or hash differs from the requested point.
 * - `ABORTED` – the caller's `AbortSignal` fired.
 */
export type CardanoBlockErrorCode =
  | "INVALID_ARGUMENT"
  | "CBOR_DECODE"
  | "BLOCK_DECODE"
  | "CONNECTION"
  | "TIMEOUT"
  | "HANDSHAKE_REFUSED"
  | "PROTOCOL"
  | "NO_BLOCKS"
  | "BLOCK_MISMATCH"
  | "ABORTED";

/** The single error class thrown by this library. Inspect `code` for programmatic handling. */
export class CardanoBlockError extends Error {
  override readonly name = "CardanoBlockError";
  readonly code: CardanoBlockErrorCode;
  /** Optional structured details (e.g. refuse reason, offsets). JSON-safe. */
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: CardanoBlockErrorCode, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message);
    this.code = code;
    this.details = details;
    if (options && "cause" in options) {
      Object.defineProperty(this, "cause", { value: options.cause, enumerable: false, configurable: true, writable: true });
    }
  }
}

/** Type guard for {@link CardanoBlockError}, optionally narrowed to one code. */
export function isCardanoBlockError(err: unknown, code?: CardanoBlockErrorCode): err is CardanoBlockError {
  return err instanceof CardanoBlockError && (code === undefined || err.code === code);
}

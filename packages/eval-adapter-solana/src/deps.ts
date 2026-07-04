import {
  getProtocolConfig,
  getProtocolProgramId,
  SolanaPaymentStrategy,
  type PaymentRequestData,
} from '@elisym/sdk';
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  getBase58Encoder,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
} from '@solana/kit';
import { SolanaPaymentAdapter, type SolanaAdapterDeps } from './adapter.js';

export interface SolanaAdapterConfig {
  /** base58-encoded 64-byte keypair (solana-keygen format) or the raw bytes. */
  payerSecretKey: string | Uint8Array;
  /** Default https://api.devnet.solana.com. */
  rpcUrl?: string;
  /** Quote validity window in seconds. */
  expirySecs?: number;
}

const DEVNET_RPC_URL = 'https://api.devnet.solana.com';

/**
 * Production wiring over the elisym Solana rail: @elisym/sdk payment strategy
 * + @solana/kit rpc/signing, mirroring the send path used by @elisym/mcp
 * (buildTransaction -> sendAndConfirmTransactionFactory at `confirmed`).
 */
export async function createSolanaAdapter(
  config: SolanaAdapterConfig,
): Promise<SolanaPaymentAdapter> {
  const rpcUrl = config.rpcUrl ?? DEVNET_RPC_URL;
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, 'ws'));
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  const secretBytes =
    typeof config.payerSecretKey === 'string'
      ? new Uint8Array(getBase58Encoder().encode(config.payerSecretKey))
      : config.payerSecretKey;
  const signer = await createKeyPairSignerFromBytes(secretBytes);

  const strategy = new SolanaPaymentStrategy();
  const programId = getProtocolProgramId('devnet');
  // @solana/kit brands addresses; re-brand the chain-neutral string config.
  const brandedConfig = (config: { feeBps: number; treasury: string }) => ({
    feeBps: config.feeBps,
    treasury: address(config.treasury),
  });
  type SendableTransaction = Parameters<typeof sendAndConfirm>[0];

  const deps: SolanaAdapterDeps = {
    now: () => Date.now(),
    async getProtocolConfig() {
      const protocolConfig = await getProtocolConfig(rpc, programId);
      return { feeBps: protocolConfig.feeBps, treasury: protocolConfig.treasury.toString() };
    },
    createPaymentRequest(payee, amount, protocolConfig, options) {
      return strategy.createPaymentRequest(payee, amount, brandedConfig(protocolConfig), options);
    },
    async sendPayment(request: PaymentRequestData) {
      const protocolConfig = await getProtocolConfig(rpc, programId);
      const signed = (await strategy.buildTransaction(
        request,
        signer,
        rpc,
        protocolConfig,
      )) as SendableTransaction;
      await sendAndConfirm(signed, { commitment: 'confirmed' });
      return { signature: getSignatureFromTransaction(signed) };
    },
    async verifyPayment(request: PaymentRequestData, txSignature?: string) {
      const protocolConfig = await getProtocolConfig(rpc, programId);
      return strategy.verifyPayment(
        rpc,
        request,
        protocolConfig,
        txSignature !== undefined ? { txSignature } : undefined,
      );
    },
    async getBalance(walletAddress: string) {
      const { value } = await rpc.getBalance(address(walletAddress)).send();
      return BigInt(value);
    },
  };

  return new SolanaPaymentAdapter(deps, {
    payerAddress: signer.address.toString(),
    ...(config.expirySecs !== undefined ? { expirySecs: config.expirySecs } : {}),
  });
}

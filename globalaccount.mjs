import { PublicKey } from "@solana/web3.js";
import * as coral from '@coral-xyz/borsh';
const { struct, bool, u64, publicKey, Layout } = coral;

export class GlobalAccount {
  constructor(
    discriminator,
    initialized,
    authority,
    feeRecipient,
    initialVirtualTokenReserves,
    initialVirtualSolReserves,
    initialRealTokenReserves,
    tokenTotalSupply,
    feeBasisPoints
  ) {
    this.discriminator = BigInt(discriminator);
    this.initialized = initialized;
    this.authority = new PublicKey(authority);
    this.feeRecipient = new PublicKey(feeRecipient);
    this.initialVirtualTokenReserves = BigInt(initialVirtualTokenReserves);
    this.initialVirtualSolReserves = BigInt(initialVirtualSolReserves);
    this.initialRealTokenReserves = BigInt(initialRealTokenReserves);
    this.tokenTotalSupply = BigInt(tokenTotalSupply);
    this.feeBasisPoints = BigInt(feeBasisPoints);
  }

  getInitialBuyPrice(amount) {
    amount = BigInt(amount);
    if (amount <= 0n) {
      return 0n;
    }

    const n = this.initialVirtualSolReserves * this.initialVirtualTokenReserves;
    const i = this.initialVirtualSolReserves + amount;
    const r = n / i + 1n;
    const s = this.initialVirtualTokenReserves - r;
    return s < this.initialRealTokenReserves ? s : this.initialRealTokenReserves;
  }

  static fromBuffer(buffer) {
    const structure = struct([
      u64("discriminator"),
      bool("initialized"),
      publicKey("authority"),
      publicKey("feeRecipient"),
      u64("initialVirtualTokenReserves"),
      u64("initialVirtualSolReserves"),
      u64("initialRealTokenReserves"),
      u64("tokenTotalSupply"),
      u64("feeBasisPoints"),
    ]);

    const value = structure.decode(buffer);
    return new GlobalAccount(
      value.discriminator,
      value.initialized,
      value.authority,
      value.feeRecipient,
      value.initialVirtualTokenReserves,
      value.initialVirtualSolReserves,
      value.initialRealTokenReserves,
      value.tokenTotalSupply,
      value.feeBasisPoints
    );
  }
}

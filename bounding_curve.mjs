import { struct, bool, u64 } from "@coral-xyz/borsh";

export class BondingCurveAccount {
  constructor(
    discriminator,
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete
  ) {
    this.discriminator = discriminator;
    this.virtualTokenReserves = virtualTokenReserves;
    this.virtualSolReserves = virtualSolReserves;
    this.realTokenReserves = realTokenReserves;
    this.realSolReserves = realSolReserves;
    this.tokenTotalSupply = tokenTotalSupply;
    this.complete = complete;
  }

  getBuyPrice(amount) {
    amount = BigInt(amount)
    if (this.complete) {
      throw new Error("Curve is complete");
    }

    if (amount <= 0n) {
      return 0n;
    }

    const n = this.virtualSolReserves * this.virtualTokenReserves;
    const i = this.virtualSolReserves + amount;
    const r = n / i + 1n;
    const s = this.virtualTokenReserves - r;

    return s < this.realTokenReserves ? s : this.realTokenReserves;
  }

  getSellPrice(amount, feeBasisPoints) {
    if (this.complete) {
      throw new Error("Curve is complete");
    }

    if (amount <= 0n) {
      return 0n;
    }

    const n = (amount * this.virtualSolReserves) / (this.virtualTokenReserves + amount);
    const a = (n * feeBasisPoints) / 10000n;

    return n - a;
  }

  getMarketCapSOL() {
    if (this.virtualTokenReserves === 0n) {
      return 0n;
    }

    return (this.tokenTotalSupply * this.virtualSolReserves) / this.virtualTokenReserves;
  }

  getFinalMarketCapSOL(feeBasisPoints) {
    const totalSellValue = this.getBuyOutPrice(this.realTokenReserves, feeBasisPoints);
    const totalVirtualValue = this.virtualSolReserves + totalSellValue;
    const totalVirtualTokens = this.virtualTokenReserves - this.realTokenReserves;

    if (totalVirtualTokens === 0n) {
      return 0n;
    }

    return (this.tokenTotalSupply * totalVirtualValue) / totalVirtualTokens;
  }

  getBuyOutPrice(amount, feeBasisPoints) {
    const solTokens = amount < this.realSolReserves ? this.realSolReserves : amount;
    const totalSellValue = (solTokens * this.virtualSolReserves) / (this.virtualTokenReserves - solTokens) + 1n;
    const fee = (totalSellValue * feeBasisPoints) / 10000n;
  
    return totalSellValue + fee;
  }

  static fromBuffer(buffer) {
    const structure = struct([
      u64("discriminator"),
      u64("virtualTokenReserves"),
      u64("virtualSolReserves"),
      u64("realTokenReserves"),
      u64("realSolReserves"),
      u64("tokenTotalSupply"),
      bool("complete"),
    ]);

    const value = structure.decode(buffer);

    return new BondingCurveAccount(
      BigInt(value.discriminator),
      BigInt(value.virtualTokenReserves),
      BigInt(value.virtualSolReserves),
      BigInt(value.realTokenReserves),
      BigInt(value.realSolReserves),
      BigInt(value.tokenTotalSupply),
      value.complete
    );
  }
}

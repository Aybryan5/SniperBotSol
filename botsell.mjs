import fs from 'fs';
import {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import * as anchor from '@project-serum/anchor';
import { BN } from 'bn.js';
import {
  getMint,
  TOKEN_PROGRAM_ID,
  AccountLayout,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { BondingCurveAccount } from './bonding_curve.mjs';
import 'dotenv/config';
import WebSocket from 'ws';

const { web3 } = anchor;

const DEFAULT_COMMITMENT = 'confirmed';
const GLOBAL_ACCOUNT_SEED = 'global';
const BONDING_CURVE_SEED = 'bonding-curve';

async function main() {
  try {
    const walletsJson = JSON.parse(fs.readFileSync('wallets.json'));
    const walletKeyPairs = walletsJson.map(wallet => Keypair.fromSecretKey(Uint8Array.from(Buffer.from(wallet.privateKey, 'base64'))));

    walletKeyPairs.forEach((walletKeyPair, index) => {
      console.log(`Wallet ${index + 1} public key: ${walletKeyPair.publicKey.toBase58()}`);
    });

    const connection = new Connection(process.env.SOLANA_RPC_NODE_1, {
      wsEndpoint: process.env.SOLANA_WSS_NODE_1,
      WebSocket,
    });

    console.log('Using RPC endpoint:', process.env.SOLANA_RPC_NODE_1);

    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(walletKeyPairs[0]), {
      commitment: DEFAULT_COMMITMENT,
    });

    const idl = JSON.parse(fs.readFileSync('./idl.json'));
    const programId = new PublicKey(idl.metadata.address);
    const program = new anchor.Program(idl, programId, provider);

    const CONTRACT_ADDRESS = new PublicKey('2yFVKn98Sred2fVDHaiJyCqB3zCDadurJ4D8yTyspump');
    const mintInfo = await getMint(connection, CONTRACT_ADDRESS);
    console.log('Mint Information:', mintInfo);

    async function getFirstHolder(tokenMintPubKey, connection) {
      const tokenAccounts = await connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
        filters: [
          { dataSize: AccountLayout.span },
          { memcmp: { offset: AccountLayout.offsetOf('mint'), bytes: tokenMintPubKey.toBase58() } },
        ],
      });

      console.log(`Found ${tokenAccounts.length} token accounts.`);

      if (tokenAccounts.length === 0) {
        console.log('No holders found.');
        return null;
      }

      tokenAccounts.sort((a, b) => {
        const balanceA = BigInt(a.account.data.parsed.info.tokenAmount.amount);
        const balanceB = BigInt(b.account.data.parsed.info.tokenAmount.amount);
        return balanceB > balanceA ? 1 : balanceB < balanceA ? -1 : 0;
      });

      const firstHolderAccount = tokenAccounts[0].account.data.parsed.info;
      const firstHolderAddress = new PublicKey(firstHolderAccount.owner);

      return firstHolderAddress;
    }

    function getBondingCurvePDA(CONTRACT_ADDRESS, programId) {
      return PublicKey.findProgramAddressSync(
        [Buffer.from(BONDING_CURVE_SEED), CONTRACT_ADDRESS.toBuffer()],
        programId
      )[0];
    }

    async function getBondingCurveAccount(CONTRACT_ADDRESS, connection, programId, commitment = DEFAULT_COMMITMENT) {
      const tokenAccount = await connection.getAccountInfo(getBondingCurvePDA(CONTRACT_ADDRESS, programId), commitment);
      if (!tokenAccount) {
        return null;
      }
      return BondingCurveAccount.fromBuffer(tokenAccount.data);
    }

    const associatedBondingCurve = await getAssociatedTokenAddress(
      CONTRACT_ADDRESS,
      getBondingCurvePDA(CONTRACT_ADDRESS, programId),
      true
    );

    async function ensureAssociatedTokenAccountExists(connection, walletKeyPair, CONTRACT_ADDRESS) {
      const associatedTokenAddress = await getAssociatedTokenAddress(
        CONTRACT_ADDRESS,
        walletKeyPair.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      const accountInfo = await connection.getAccountInfo(associatedTokenAddress);

      if (!accountInfo) {
        console.log('Creating associated token account...');
        const instruction = createAssociatedTokenAccountInstruction(
          walletKeyPair.publicKey,
          associatedTokenAddress,
          walletKeyPair.publicKey,
          CONTRACT_ADDRESS,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );

        const transaction = new web3.Transaction().add(instruction);
        const signature = await web3.sendAndConfirmTransaction(connection, transaction, [walletKeyPair]);
        console.log('Associated token account created:', signature);
      } else {
        console.log('Associated token account already exists.');
      }

      return associatedTokenAddress;
    }

    async function ensureAssociatedTokenAccountsExistForAll(walletKeyPairs, CONTRACT_ADDRESS) {
      const promises = walletKeyPairs.map(walletKeyPair =>
        ensureAssociatedTokenAccountExists(connection, walletKeyPair, CONTRACT_ADDRESS)
      );
      return Promise.all(promises);
    }

    const associatedUsers = await ensureAssociatedTokenAccountsExistForAll(walletKeyPairs, CONTRACT_ADDRESS);
    associatedUsers.forEach((associatedUser, index) => {
      console.log(`Associated user ${index + 1}: ${associatedUser.toBase58()}`);
    });

    async function getGlobalAccount(connection, program, commitment = DEFAULT_COMMITMENT) {
      const [globalAccountPDA] = PublicKey.findProgramAddressSync([Buffer.from(GLOBAL_ACCOUNT_SEED)], programId);
      const tokenAccount = await connection.getAccountInfo(globalAccountPDA, commitment);

      if (!tokenAccount) {
        throw new Error('Global account not found');
      }

      return globalAccountPDA;
    }

    async function buyTokens(tokenAddress, connection, program, walletKeyPair, associatedUser) {
      const lamports = 0.020 * LAMPORTS_PER_SOL;
      const solAmount = new BN(lamports.toString());

      console.log('solAmount:', solAmount.toString());

      let bondingCurveAccount = await getBondingCurveAccount(CONTRACT_ADDRESS, connection, programId, 'confirmed');
      if (!bondingCurveAccount) {
        throw new Error('BondingCurveAccount is undefined');
      }

      let buyAmount = new BN(bondingCurveAccount.getBuyPrice(solAmount.toString()));

      const PRIORITY_RATE = new BN(400000);

      console.log('solAmount:', solAmount.toString());
      console.log('Price:', buyAmount.toString());

      const firstHolder = await getFirstHolder(CONTRACT_ADDRESS, connection);
      if (!firstHolder) {
        throw new Error('No first holder found.');
      }

      const PRIORITY_FEE_INSTRUCTIONS = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_RATE });

      const globalAccount = await getGlobalAccount(connection, program);

      try {
        if (!associatedBondingCurve) throw new Error('associatedBondingCurve is undefined');
        if (!associatedUser) throw new Error('associatedUser is undefined');
        if (!CONTRACT_ADDRESS) throw new Error('CONTRACT_ADDRESS is undefined');
        if (!firstHolder) throw new Error('firstHolder is undefined');
        if (!programId) throw new Error('programId is undefined');
        if (!globalAccount) throw new Error('globalAccount is undefined');

        const solAmountBN = new BN(solAmount.toString());
        const BuyAmountBN = new BN(buyAmount.toString());

        const buyInstruction = program.instruction.buy(
          BuyAmountBN,
          solAmountBN,
          {
            accounts: {
              global: globalAccount,
              feeRecipient: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
              associatedBondingCurve: associatedBondingCurve,
              associatedUser: associatedUser,
              mint: CONTRACT_ADDRESS,
              bondingCurve: firstHolder,
              user: walletKeyPair.publicKey,
              systemProgram: SystemProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
              rent: anchor.web3.SYSVAR_RENT_PUBKEY,
              eventAuthority: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'),
              program: programId,
            },
            remainingAccounts: [],
            signers: [walletKeyPair.publicKey],
          }
        );

        const instructions = [buyInstruction, PRIORITY_FEE_INSTRUCTIONS];

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

        const message = new TransactionMessage({
          payerKey: walletKeyPair.publicKey,
          recentBlockhash: blockhash,
          lastValidBlockHeight: lastValidBlockHeight,
          instructions,
        }).compileToV0Message();

        const transaction = new VersionedTransaction(message);
        transaction.sign([walletKeyPair]);

        const serializedTransaction = transaction.serialize();
        const txId = await connection.sendRawTransaction(serializedTransaction, { skipPreflight: true });

        console.log('Transaction successful with txId:', txId);
        return txId;
      } catch (error) {
        console.error('Error in buyTokens:', error);
        throw error;
      }
    }

    async function sellAllTokens(tokenAddress, connection, program, walletKeyPair) {
      try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletKeyPair.publicKey, { programId: TOKEN_PROGRAM_ID });

        if (tokenAccounts.value.length === 0) {
          console.log('No token accounts found to sell.');
          return;
        }

        const globalAccount = await getGlobalAccount(connection, program);
        const firstHolder = await getFirstHolder(CONTRACT_ADDRESS, connection);

        if (!firstHolder) {
          console.error('No first holder found.');
          return;
        }

        for (const account of tokenAccounts.value) {
          try {
            const accountInfo = account.account.data.parsed.info;

            if (!accountInfo || !accountInfo.tokenAmount || !accountInfo.tokenAmount.amount) {
              console.log(`Skipping account ${account.pubkey} because token amount is undefined or 0.`);
              continue;
            }

            const amountToSell = new BN(accountInfo.tokenAmount.amount);

            if (amountToSell.isZero()) {
              console.log(`Skipping account ${account.pubkey} because amount to sell is 0.`);
              continue;
            }

            const amountToSell1 = new BN(accountInfo.tokenAmount.amount - 1000);
            const PRIORITY_RATE = new BN(400000);
            const PRIORITY_FEE_INSTRUCTIONS = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_RATE });
            const minsol = new BN(0);

            const sellInstruction = program.instruction.sell(
              amountToSell1,
              minsol,
              {
                accounts: {
                  global: globalAccount,
                  feeRecipient: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
                  associatedBondingCurve: associatedBondingCurve,
                  associatedUser: associatedUser,
                  mint: CONTRACT_ADDRESS,
                  bondingCurve: firstHolder,
                  user: walletKeyPair.publicKey,
                  systemProgram: SystemProgram.programId,
                  associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                  tokenProgram: TOKEN_PROGRAM_ID,
                  rent: anchor.web3.SYSVAR_RENT_PUBKEY,
                  eventAuthority: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'),
                  program: programId,
                },
                remainingAccounts: [],
                signers: [walletKeyPair.publicKey],
              }
            );

            const instructions = [sellInstruction, PRIORITY_FEE_INSTRUCTIONS];

            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

            const message = new TransactionMessage({
              payerKey: walletKeyPair.publicKey,
              recentBlockhash: blockhash,
              lastValidBlockHeight: lastValidBlockHeight,
              instructions,
            }).compileToV0Message();

            const transaction = new VersionedTransaction(message);
            transaction.sign([walletKeyPair]);

            const serializedTransaction = transaction.serialize();
            const txId = await connection.sendRawTransaction(serializedTransaction, { skipPreflight: true });

            console.log('Transaction successful with txId:', txId);

          } catch (error) {
            if (error.name === 'TransactionExpiredTimeoutError') {
              console.error('Transaction expired, retrying...');
              throw error;
            } else {
              console.error('Error in sellAllTokens:', error);
              throw error;
            }
          }
        }
      } catch (error) {
        console.error('Error in sellAllTokens:', error);
        throw error;
      }
    }

    async function getLatestTokens(walletToMonitor) {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletToMonitor, { programId: TOKEN_PROGRAM_ID });
      return tokenAccounts.value.map(account => ({
        address: account.pubkey,
        createdAt: account.account.data.parsed.info.tokenAmount.uiAmount,
      }));
    }

    async function startSniperBot(walletToMonitor, walletKeyPairs, associatedUsers) {
      const startDate = new Date();

      while (true) {
        const tokens = await getLatestTokens(walletToMonitor);

        for (const token of tokens) {
          const createdAt = new Date(token.createdAt);

          if (createdAt > startDate) {
            console.log("New token found:", token.address.toBase58());
            const sellPromises = walletKeyPairs.map((walletKeyPair, index) =>
              sellAllTokens(token.address, connection, program, walletKeyPair, associatedUsers[index])
            );
            await Promise.all(sellPromises);
          }
        }

        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
      }
    }

    

  } catch (error) {
    console.error('Error running program:', error);
  }
}

main();

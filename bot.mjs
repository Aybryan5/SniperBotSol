import fs from 'fs';
import {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { BN } from 'bn.js';
import {
  TOKEN_PROGRAM_ID,
  AccountLayout,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { BondingCurveAccount } from './bounding_curve.mjs'; // Assurez-vous que ce chemin est correct
import 'dotenv/config';
import WebSocket from 'ws';
import * as anchor from '@project-serum/anchor';

const { web3 } = anchor;

const DEFAULT_COMMITMENT = 'confirmed';
const GLOBAL_ACCOUNT_SEED = 'global';
const BONDING_CURVE_SEED = 'bonding-curve';
let mintAddress = null; // Variable globale pour stocker l'adresse du Mint

async function main() {
  try {
    // Chargement des clés privées depuis wallet.json
    const walletsJson = JSON.parse(fs.readFileSync('wallet.json', 'utf8'));

    if (!Array.isArray(walletsJson)) {
      throw new Error('wallet.json devrait être un tableau d\'objets de portefeuille');
    }

    // Création des keypairs à partir des clés privées
    const walletKeyPairs = walletsJson.map(wallet => {
      const keypair = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(wallet.privateKey, 'base64')));
      console.log('Portefeuille chargé :', keypair.publicKey.toBase58());
      return keypair;
    });

    // Connexion au nœud Solana
    const connection = new Connection(process.env.SOLANA_RPC_NODE_1, {
      wsEndpoint: process.env.SOLANA_WSS_NODE_1,
      WebSocket,
    });

    console.log('Endpoint RPC utilisé :', process.env.SOLANA_RPC_NODE_1);

    // Initialisation du provider Anchor
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(walletKeyPairs[0]), {
      commitment: DEFAULT_COMMITMENT,
    });

    // Chargement du programme Anchor depuis idl.json
    const idl = JSON.parse(fs.readFileSync('./idl.json', 'utf8'));
    const programId = new PublicKey(idl.metadata.address);
    const program = new anchor.Program(idl, programId, provider);

    console.log(`Clé publique du portefeuille : ${walletKeyPairs[0].publicKey.toBase58()}`);

    // Fonction pour récupérer les informations sur le Mint d'un token
    async function getMintInfo(tokenAddress, connection) {
      const mintInfo = await connection.getTokenSupply(tokenAddress);
      console.log('Informations sur le Mint :', mintInfo);
      return mintInfo;
    }

    // Fonction pour récupérer le premier détenteur d'un token
    async function getFirstHolder(tokenMintPubKey, connection) {
      const tokenAccounts = await connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
        filters: [
          {
            dataSize: AccountLayout.span,
          },
          {
            memcmp: {
              offset: AccountLayout.offsetOf('mint'),
              bytes: tokenMintPubKey.toBuffer(),
            },
          },
        ],
      });

      console.log(`Trouvé ${tokenAccounts.length} comptes de tokens.`);

      if (tokenAccounts.length === 0) {
        console.log('Aucun détenteur trouvé.');
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

    // Fonction pour obtenir l'adresse PDA de la courbe de bonding
    function getBondingCurvePDA(tokenAddress, programId) {
      return PublicKey.findProgramAddressSync(
        [Buffer.from(BONDING_CURVE_SEED), tokenAddress.toBuffer()],
        programId
      )[0];
    }

    // Fonction pour récupérer le compte de la courbe de bonding
    async function getBondingCurveAccount(tokenAddress, connection, programId, commitment = DEFAULT_COMMITMENT) {
      const tokenAccount = await connection.getAccountInfo(getBondingCurvePDA(tokenAddress, programId), commitment);
      if (!tokenAccount) {
        return null;
      }
      return BondingCurveAccount.fromBuffer(tokenAccount.data);
    }

    // Fonction pour s'assurer qu'un compte de token associé existe
    async function ensureAssociatedTokenAccountExists(connection, walletKeyPair, tokenAddress) {
      const associatedTokenAddress = await getAssociatedTokenAddress(
        tokenAddress,
        walletKeyPair.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      const accountInfo = await connection.getAccountInfo(associatedTokenAddress);

      if (!accountInfo) {
        console.log('Création du compte de token associé...');
        const instruction = createAssociatedTokenAccountInstruction(
          walletKeyPair.publicKey,
          associatedTokenAddress,
          walletKeyPair.publicKey,
          tokenAddress,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );

        const transaction = new web3.Transaction().add(instruction);
        const signature = await web3.sendAndConfirmTransaction(connection, transaction, [walletKeyPair]);
        console.log('Compte de token associé créé :', signature);
      } else {
        console.log('Le compte de token associé existe déjà.');
      }

      return associatedTokenAddress;
    }

    // Fonction pour s'assurer que tous les comptes de token associés existent pour tous les portefeuilles
    async function ensureAssociatedTokenAccountsExistForAll(walletKeyPairs, tokenAddress) {
      const promises = walletKeyPairs.map(walletKeyPair =>
        ensureAssociatedTokenAccountExists(connection, walletKeyPair, tokenAddress)
      );
      return Promise.all(promises);
    }

    // Fonction pour obtenir le compte global
    async function getGlobalAccount(connection, program, commitment = DEFAULT_COMMITMENT) {
      const [globalAccountPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from(GLOBAL_ACCOUNT_SEED)],
        programId
      );

      const tokenAccount = await connection.getAccountInfo(globalAccountPDA, commitment);

      if (!tokenAccount) {
        throw new Error('Le compte global n\'a pas été trouvé');
      }

      return globalAccountPDA;
    }

    // Fonction pour acheter des tokens
    async function buyTokens(tokenAddress, connection, program, walletKeyPair, associatedUser) {
      const lamports = 0.020 * LAMPORTS_PER_SOL;
      const solAmount = new BN(lamports.toString());

      console.log('solAmount :', solAmount.toString());

      let bondingCurveAccount = await getBondingCurveAccount(tokenAddress, connection, program.programId, 'confirmed');
      if (!bondingCurveAccount) {
        throw new Error('Le compte de la courbe de bonding est indéfini');
      }

      let buyAmount = new BN(bondingCurveAccount.getBuyPrice(solAmount.toString()));

      const PRIORITY_RATE = new BN(400000);

      console.log('solAmount :', solAmount.toString());
      console.log('Prix :', buyAmount.toString());

      const firstHolder = await getFirstHolder(tokenAddress, connection);
      if (!firstHolder) {
        throw new Error('Aucun premier détenteur trouvé.');
      }

      const PRIORITY_FEE_INSTRUCTIONS = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_RATE });

      const globalAccount = await getGlobalAccount(connection, program);

      try {
        const solAmountBN = new BN(solAmount.toString() + 20000);
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
              mint: tokenAddress,
              bondingCurve: firstHolder,
              user: walletKeyPair.publicKey,
              systemProgram: SystemProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
              rent: anchor.web3.SYSVAR_RENT_PUBKEY,
              eventAuthority: new PublicKey('Ce6TQqeHC9p8KetsNjmVUp4A7HHe1C7jbTgXoHDSu3C'),
            },
            signers: [walletKeyPair],
            instructions: [buyInstruction],
          }
        );

        console.log('Instruction d\'achat :', buyInstruction);

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

        const transaction = new web3.Transaction({ recentBlockhash: blockhash, feePayer: walletKeyPair.publicKey });
        transaction.add(buyInstruction);
        transaction.add(PRIORITY_FEE_INSTRUCTIONS);

        const signature = await web3.sendAndConfirmTransaction(connection, transaction, [walletKeyPair]);
        console.log('Transaction réussie avec la signature :', signature);
        return signature;
      } catch (error) {
        console.error('Erreur dans buyTokens :', error);
        throw error;
      }
    }

    // Fonction pour obtenir l'adresse du Mint à partir du compte de token associé
    async function getMintAddressFromAssociatedToken(tokenAddress, connection) {
      try {
        // Obtenir les informations sur le compte de token associé
        const tokenAccountInfo = await connection.getAccountInfo(tokenAddress);
        if (!tokenAccountInfo) {
          throw new Error(`Informations sur le compte de token non trouvées pour ${tokenAddress}`);
        }

        // Utiliser SPL Token pour obtenir l'adresse du Mint à partir des données du compte
        const associatedTokenAddress = new PublicKey(tokenAddress);
        const associatedTokenInfo = await getAssociatedTokenAccountInfo(associatedTokenAddress);

        if (!associatedTokenInfo) {
          throw new Error(`Informations sur le compte de token associé non trouvées pour ${tokenAddress}`);
        }

        // Récupérer l'adresse du Mint à partir des informations du compte de token associé
        mintAddress = associatedTokenInfo.mint;
        console.log('Adresse du Mint associé mise à jour :', mintAddress.toBase58());

        return mintAddress;
      } catch (error) {
        console.error(`Erreur lors de la récupération de l'adresse du Mint : ${error}`);
        throw error;
      }
    }

    // Fonction pour obtenir les informations sur le compte de token associé
    async function getAssociatedTokenAccountInfo(associatedTokenAddress) {
      try {
        const accountInfo = await connection.getAccountInfo(associatedTokenAddress);

        if (!accountInfo) {
          return null;
        }

        const data = Buffer.from(accountInfo.data);
        const parsed = AccountLayout.decode(data);

        return {
          mint: new PublicKey(parsed.mint),
          owner: new PublicKey(parsed.owner),
          amount: new BN(parsed.amount, 10, 'le')
        };
      } catch (error) {
        console.error(`Erreur lors de la récupération des informations sur le compte de token associé : ${error}`);
        throw error;
      }
    }

    // Fonction pour démarrer le bot de sniper
   // Fonction pour démarrer le bot de sniper
async function startSniperBot(walletToMonitor, walletKeyPairs, connection, program) {
  let seenTokens = new Set(); // Utilisation d'un ensemble pour stocker les tokens déjà vus

  while (true) {
    try {
      const tokenAddresses = await getLatestTokens(walletToMonitor, connection);

      if (tokenAddresses.length > 0) {
        console.log(`Trouvé ${tokenAddresses.length} tokens`);

        for (const token of tokenAddresses) {
          if (!seenTokens.has(token.address.toBase58())) {
            console.log(`Nouveau token trouvé : ${token.address.toBase58()}`);

            const associatedUsers = await ensureAssociatedTokenAccountExists(connection, walletKeyPairs[0], token.address);
            const buyPromises = walletKeyPairs.map((walletKeyPair, index) =>
              buyTokens(token.address, connection, program, walletKeyPair, associatedUsers[index])
            );
            await Promise.all(buyPromises);

            seenTokens.add(token.address.toBase58()); // Ajouter le nouveau token à la liste des tokens vus
          }
        }
      }
    } catch (error) {
      console.error('Erreur dans startSniperBot :', error);
    }

    await new Promise(resolve => setTimeout(resolve, 1000)); // Attendre 1 seconde avant de vérifier à nouveau
  }
}

    // Fonction pour obtenir les derniers tokens d'un portefeuille
    async function getLatestTokens(walletToMonitor, connection) {
      try {
        const ownerPublicKey = new PublicKey(walletToMonitor);

        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(ownerPublicKey, {
          programId: TOKEN_PROGRAM_ID,
        });

        console.log(`Trouvé ${tokenAccounts.length} comptes de tokens pour le portefeuille ${walletToMonitor}`);

        const tokens = await Promise.all(
          tokenAccounts.value.map(async account => {
            try {
              const tokenAddress = account.pubkey;
              const mintAddress = await getMintAddressFromAssociatedToken(tokenAddress, connection);

              const associatedTokenAddress = await getAssociatedTokenAddress(
                mintAddress,
                ownerPublicKey,
                false, // Vous ne voulez pas créer de nouveau compte associé
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
              );

              return {
                address: associatedTokenAddress,
                createdAt: account.account.data.parsed.info.tokenAmount.ui64 ? new Date(account.account.data.parsed.info.tokenAmount.ui64) : null,
              };
            } catch (error) {
              console.error(`Erreur lors de la récupération du token : ${error}`);
              return null;
            }
          })
        );

        return tokens.filter(token => token && token.address && token.createdAt); // Filtrer les tokens avec createdAt non défini ou nul
      } catch (error) {
        console.error('Erreur lors de la récupération des comptes de tokens :', error);
        throw error;
      }
    }

    // Portefeuille à surveiller
    const walletToMonitor = 'HWb6gg8AkwHgkUFeSgSo2iaWuG63nWp8LLBuaUBr3rrU';
    await startSniperBot(walletToMonitor, walletKeyPairs, connection, program);
  } catch (error) {
    console.error('Erreur principale :', error);
  }
}

main().then(() => process.exit()).catch(err => {
  console.error(err);
  process.exit(-1);
});

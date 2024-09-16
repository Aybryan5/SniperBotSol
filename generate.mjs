import fs from 'fs';
import { Keypair } from '@solana/web3.js';

// Générer une nouvelle paire de clés
const wallet = Keypair.generate();

// Enregistrer la clé privée dans un fichier (au format base64)
const privateKey = Buffer.from(wallet.secretKey).toString('base64');
fs.writeFileSync('wallet.json', JSON.stringify({ privateKey }));

console.log(`Wallet public key: ${wallet.publicKey.toBase58()}`);

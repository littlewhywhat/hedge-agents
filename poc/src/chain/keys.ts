import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { toClientCardanoSigner } from "@x402/cardano";

const NETWORK = "cardano:preprod";
const OFFLINE = { blockfrost: { baseUrl: "https://cardano-preprod.blockfrost.io/api/v0", projectId: "offline" } };

export const newMnemonic = (): string => {
  return generateMnemonic(wordlist, 256);
};

export const addressOf = (mnemonic: string): string => {
  return toClientCardanoSigner({ mnemonic, network: NETWORK, provider: OFFLINE }).getAddress();
};

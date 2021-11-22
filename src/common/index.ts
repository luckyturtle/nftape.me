import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { programs } from '@metaplex/js';
import { findSigner, removeItemOnce } from './util';
import { INFTData, PriceMethod } from '@/common/types';
import { calcPaperDiamondHands } from '@/common/paperhands';
import { triageTxByExchange } from '@/common/marketplaces/mpTransactions';
import { fetchAndCalcStats } from '@/common/marketplaces/mpPrices';
import { fetchNFTMetadata } from '@/common/metadata';

const {
  metaplex: { Store, AuctionManager },
  metadata: { Metadata },
  auction: { Auction },
  vault: { Vault },
} = programs;

export class NFTHandler {
  conn: Connection;

  currentNFTMints: string[] = [];

  allNFTs: INFTData[] = [];

  spent = 0;

  earned = 0;

  constructor(conn: Connection) {
    this.conn = conn;
  }

  // --------------------------------------- helpers

  findOrCreateNFTEntry(mint: string, props: any) {
    this.allNFTs.forEach((nft) => {
      if (nft.mint === mint) {
        for (const [key, value] of Object.entries(props)) {
          (nft as any)[key] = value;
        }
      }
    });
    this.allNFTs.push({
      mint,
      ...props,
    });
  }

  // --------------------------------------- get tx history

  parseTx(tx: any, owner: string, exchange: string) {
    // identify the token through postTokenBalances
    const tokenMint = tx.meta.preTokenBalances[0].mint;
    // there's only one signer = the buyer, that's the acc we need
    const [buyerIdx, buyerAcc] = findSigner(tx.transaction.message.accountKeys)!;
    const { preBalances } = tx.meta;
    const { postBalances } = tx.meta;
    const buyerSpent = (preBalances[buyerIdx] - postBalances[buyerIdx]) / LAMPORTS_PER_SOL;
    if (buyerAcc.toBase58() === owner) {
      console.log(`Bought ${tokenMint} for ${buyerSpent} SOL on ${exchange}`);
      this.spent += buyerSpent;
      this.currentNFTMints.push(tokenMint);
      this.findOrCreateNFTEntry(tokenMint, { boughtAt: buyerSpent });
    } else {
      console.log(`Sold ${tokenMint} for ${buyerSpent} SOL on ${exchange}`);
      this.earned += buyerSpent;
      this.currentNFTMints = removeItemOnce(this.currentNFTMints, tokenMint);
      this.findOrCreateNFTEntry(tokenMint, { soldAt: buyerSpent });
    }
  }

  async getTxHistory(address: string) {
    let txInfos = await this.conn.getSignaturesForAddress(new PublicKey(address));
    console.log(`got ${txInfos.length} txs to process`);

    // reverse the array, we want to start with historic transactions not other way around
    txInfos = txInfos.reverse();

    const sigs = txInfos.map((i) => i.signature);

    let i = 1;
    while (true) {
      const sigsToProcess = sigs.splice(0, 220);
      if (!sigsToProcess.length) {
        console.log('no more sigs to process!');
        break;
      }

      console.log(`processing another ${sigsToProcess.length} sigs`);
      const txs = await this.conn.getParsedConfirmedTransactions(sigsToProcess);
      console.log('got txs');
      // console.log(txs)
      // writeTxsToDisk('txs', txs)
      txs.forEach((tx) => {
        try {
          console.log(`triaging ${i} of ${txInfos.length}`);
          // console.log('selected tx', t)
          const exchange = triageTxByExchange(tx);
          if (exchange) {
            this.parseTx(tx, address, exchange);
          }
        } catch (e) {
          console.log('uh oh', e);
        } finally {
          i += 1;
        }
      });
    }

    console.log('FINALS:');
    console.log('inventory:', this.currentNFTMints);
    // console.log('all NFTs:', allNFTs)
    console.log('spent:', this.spent);
    console.log('earned:', this.earned);
    console.log('profit:', this.earned - this.spent);
  }

  // --------------------------------------- fetch prices

  async populateNFTsWithPriceStats() {
    const promises: any[] = [];
    this.allNFTs.forEach((nft) =>
      promises.push(fetchAndCalcStats(nft.onchainMetadata.data.creators[0].address))
    );
    const responses = await Promise.all(promises);
    responses.forEach((r, i) => {
      this.allNFTs[i].currentPrices = r;
    });
    console.log('Price Stats populated!');
  }

  // --------------------------------------- get NFT metadata

  async populateNFTsWithMetadata() {
    const promises: any[] = [];
    this.allNFTs.forEach((nft) => promises.push(fetchNFTMetadata(nft.mint, this.conn)));
    const responses = await Promise.all(promises);
    responses.forEach((r, i) => {
      this.allNFTs[i].onchainMetadata = r.onchainMetadata;
      this.allNFTs[i].externalMetadata = r.externalMetadata;
    });
    console.log('Metadata populated!');
  }

  // --------------------------------------- calc paperhands

  populateNFTsWithPapersAndDiamonds(method: PriceMethod) {
    for (const nft of this.allNFTs) {
      if (!nft.currentPrices) {
        continue;
      }
      const [paper, diamond] = calcPaperDiamondHands(nft, method);
      nft.paperhanded = paper;
      nft.diamondhanded = diamond;
    }
  }

  // --------------------------------------- play

  async analyzeAddress(address: string) {
    await this.getTxHistory(address);
    await this.populateNFTsWithMetadata();
    await this.populateNFTsWithPriceStats();
    this.populateNFTsWithPapersAndDiamonds(PriceMethod.median);
    console.log(this.allNFTs);
  }
}

// play();

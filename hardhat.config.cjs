// Local fork of X Layer mainnet with the real TapeOut contracts: `npm run fork`, then
// `node scripts/demo.js --fork http://127.0.0.1:8545`. Nothing is broadcast to X Layer.
module.exports = {
  networks: {
    hardhat: {
      chainId: 196, // TapeOut's ERC-6551 accounts are derived with the chain id
      forking: process.env.NO_FORK ? undefined : { url: process.env.FORK_URL || 'https://rpc.xlayer.tech' },
      hardfork: 'cancun',
      chains: { 196: { hardforkHistory: { cancun: 0 } } },
      blockGasLimit: Number(process.env.BLOCK_GAS_LIMIT || 210_000_000), // X Layer's; raise it only to measure a direct eval that does not fit
      allowUnlimitedContractSize: false,
      accounts: { count: 6, accountsBalance: '10000000000000000000000' },
    },
  },
  solidity: '0.8.28',
};

// Contract addresses and network config for Arc Testnet
//
// Marketplace migration history (newest first):
//   V6 — 0xCeF77E14dB17aE0272510ddbDa97075e7Eb6EbF3 (deployed 2026-05-07, §B1+§S1+§S5 fixed, EMPTY)
//   v4 — 0x048363A325A5B188b7FF157d725C5e329f0171D3 (CURRENT canonical, ~36k USDC liquidity)
//   v3 — 0xD1cf6E7864Bc4CbBE52aA94369dF08B106927559 (deprecated, frontend pointed here pre-fix)
//
// To cutover to V6 after migration: change `marketplace` below AND replace
// `frontend/abis/AgentLiquidityMarketplace.json` with the V6 ABI.
export const ADDRESSES = {
    marketplace: '0x048363A325A5B188b7FF157d725C5e329f0171D3',  // v4 canonical
    registry:    '0x741C03c0d95d2c15E479CE1c7E69B3196d86faD7',
    reputation:  '0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F',
    validationRegistry: '0xD97AeE70866b0feF43A4544475A5De4c061eCcea',
    usdc:        '0xf2807051e292e945751A25616705a9aadfb39895',
};

export const ARC_TESTNET = {
    chainId:       5042002,
    chainIdHex:    '0x4CE212',
    chainName:     'Arc Testnet',
    rpcUrl:        'https://arc-testnet.drpc.org',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: ['https://testnet.arcscan.app'],
};

export const USDC_DECIMALS = 6;
export const LOAN_STATES   = ['Requested', 'Active', 'Repaid', 'Defaulted'];

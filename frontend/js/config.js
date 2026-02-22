// Contract addresses and network config for Arc Testnet
export const ADDRESSES = {
    marketplace: '0xD1cf6E7864Bc4CbBE52aA94369dF08B106927559',
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

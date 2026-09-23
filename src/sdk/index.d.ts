/**
 * Specular SDK — type definitions.
 *
 * The runtime entry (src/sdk/index.js) re-exports lower-level utility modules
 * (nonce, gas, walletPersist, duration, receipt). For the high-level developer
 * surface, import the named classes directly:
 *
 *   import { SpecularQuickstart } from '@specular/sdk/SpecularQuickstart';
 *   import { SpecularX402Client, SpecularX402Server } from '@specular/sdk/x402';
 */

export {
    SpecularQuickstart,
    SpecularNetwork,
    OnboardResult,
    BorrowResult,
    CreditInfo,
    LoanRecord,
    LoanState,
} from './SpecularQuickstart';

export * from './x402';

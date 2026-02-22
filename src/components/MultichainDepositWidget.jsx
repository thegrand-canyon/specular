/**
 * Multichain Deposit Widget
 * Allows users to deposit USDC from any supported chain to Arc pools
 */

import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { CircleGatewayIntegration } from '../gateway/CircleGatewayIntegration';

export function MultichainDepositWidget({ agentId, agentName, onSuccess }) {
    const [amount, setAmount] = useState('');
    const [currentChain, setCurrentChain] = useState(null);
    const [supportedChains, setSupportedChains] = useState([]);
    const [isDepositing, setIsDepositing] = useState(false);
    const [progress, setProgress] = useState(null);
    const [estimate, setEstimate] = useState(null);
    const [gateway, setGateway] = useState(null);

    // Initialize gateway
    useEffect(() => {
        const initGateway = async () => {
            const gw = new CircleGatewayIntegration({
                environment: 'testnet',
                contracts: {
                    depositRouter: '0xD1cf6E7864Bc4CbBE52aA94369dF08B106927559', // Arc
                    bridges: {
                        sepolia: '0x...', // Deploy CCTPBridge on Sepolia
                        // Add other chains
                    }
                }
            });

            await gw.initialize();
            setGateway(gw);
            setSupportedChains(gw.getSupportedChains());

            // Detect current chain
            if (window.ethereum) {
                const provider = new ethers.BrowserProvider(window.ethereum);
                const chain = await gw.detectChain(provider);
                setCurrentChain(chain);
            }
        };

        initGateway();
    }, []);

    // Update estimate when amount changes
    useEffect(() => {
        const updateEstimate = async () => {
            if (!amount || !currentChain || !gateway) return;

            try {
                const est = await gateway.estimateDeposit({
                    amount,
                    sourceChain: currentChain,
                    destinationChain: 'arc'
                });
                setEstimate(est);
            } catch (error) {
                console.error('Error estimating:', error);
            }
        };

        updateEstimate();
    }, [amount, currentChain, gateway]);

    // Handle deposit
    const handleDeposit = async () => {
        if (!window.ethereum || !gateway) {
            alert('Please connect your wallet');
            return;
        }

        setIsDepositing(true);
        setProgress({ step: 0, message: 'Connecting wallet...' });

        try {
            const provider = new ethers.BrowserProvider(window.ethereum);
            const signer = await provider.getSigner();

            const result = await gateway.depositToArcPool({
                provider,
                signer,
                amount,
                agentId,
                onProgress: (p) => setProgress(p)
            });

            // Success!
            setProgress({ step: 5, message: '✅ Deposit successful!' });
            onSuccess?.(result);

            // Reset form
            setTimeout(() => {
                setAmount('');
                setIsDepositing(false);
                setProgress(null);
            }, 3000);

        } catch (error) {
            console.error('Deposit failed:', error);
            setProgress({ step: -1, message: `❌ Error: ${error.message}` });
            setIsDepositing(false);
        }
    };

    return (
        <div className="multichain-deposit-widget">
            <div className="widget-header">
                <h3>Deposit to {agentName}'s Pool</h3>
                <p>Supply liquidity from any chain</p>
            </div>

            {/* Chain Indicator */}
            <div className="chain-indicator">
                <span className="label">Current Chain:</span>
                <span className={`chain-badge ${currentChain}`}>
                    {currentChain ? gateway?.getChainInfo(currentChain).name : 'Not connected'}
                </span>
                {currentChain && currentChain !== 'arc' && (
                    <span className="route-info">→ Routes to Arc</span>
                )}
            </div>

            {/* Amount Input */}
            <div className="amount-input">
                <label>Amount (USDC)</label>
                <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="10000"
                    disabled={isDepositing}
                />
            </div>

            {/* Estimate Display */}
            {estimate && (
                <div className="estimate">
                    <h4>Transfer Details</h4>
                    <div className="estimate-row">
                        <span>From:</span>
                        <span>{estimate.sourceChain.toUpperCase()}</span>
                    </div>
                    <div className="estimate-row">
                        <span>To:</span>
                        <span>ARC</span>
                    </div>
                    <div className="estimate-row">
                        <span>Source Amount:</span>
                        <span>{estimate.sourceAmount} USDC</span>
                    </div>
                    {estimate.bridgeFee !== '0.0' && (
                        <div className="estimate-row">
                            <span>Bridge Fee:</span>
                            <span>{estimate.bridgeFee} USDC</span>
                        </div>
                    )}
                    <div className="estimate-row total">
                        <span>You'll Deposit:</span>
                        <span>{estimate.destinationAmount} USDC</span>
                    </div>
                    <div className="estimate-row">
                        <span>Estimated Time:</span>
                        <span>{estimate.estimatedTime}</span>
                    </div>

                    {/* Steps */}
                    {currentChain !== 'arc' && (
                        <div className="steps">
                            <p className="steps-label">Process:</p>
                            {estimate.steps.map((step, i) => (
                                <div key={i} className="step">{step}</div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Progress Display */}
            {progress && (
                <div className="progress">
                    <div className="progress-bar">
                        <div
                            className="progress-fill"
                            style={{ width: `${(progress.step / 5) * 100}%` }}
                        />
                    </div>
                    <p className="progress-message">{progress.message}</p>
                    {progress.nonce && (
                        <p className="nonce">Bridge Nonce: {progress.nonce}</p>
                    )}
                </div>
            )}

            {/* Deposit Button */}
            <button
                className="deposit-button"
                onClick={handleDeposit}
                disabled={!amount || isDepositing || !currentChain}
            >
                {isDepositing
                    ? 'Processing...'
                    : currentChain === 'arc'
                    ? 'Deposit to Pool'
                    : 'Bridge & Deposit to Arc'
                }
            </button>

            {/* Supported Chains Info */}
            <div className="supported-chains">
                <p className="info-label">💡 Supported Chains:</p>
                <div className="chain-list">
                    {supportedChains.map((chain) => (
                        <span key={chain.name} className="chain-tag">
                            {chain.displayName}
                        </span>
                    ))}
                </div>
                <p className="info-text">
                    All deposits automatically route to Arc Network where your liquidity earns interest.
                </p>
            </div>

            <style jsx>{`
                .multichain-deposit-widget {
                    max-width: 500px;
                    margin: 0 auto;
                    padding: 24px;
                    background: white;
                    border-radius: 12px;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                }

                .widget-header {
                    margin-bottom: 24px;
                }

                .widget-header h3 {
                    margin: 0 0 8px 0;
                    font-size: 24px;
                    color: #1a1a1a;
                }

                .widget-header p {
                    margin: 0;
                    color: #666;
                    font-size: 14px;
                }

                .chain-indicator {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 16px;
                    padding: 12px;
                    background: #f5f5f5;
                    border-radius: 8px;
                }

                .chain-badge {
                    padding: 4px 12px;
                    border-radius: 16px;
                    font-size: 14px;
                    font-weight: 600;
                    background: #4CAF50;
                    color: white;
                }

                .chain-badge.sepolia { background: #6366F1; }
                .chain-badge.base { background: #0052FF; }
                .chain-badge.arbitrum { background: #28A0F0; }
                .chain-badge.arc { background: #FF6B35; }

                .route-info {
                    color: #666;
                    font-size: 14px;
                }

                .amount-input {
                    margin-bottom: 16px;
                }

                .amount-input label {
                    display: block;
                    margin-bottom: 8px;
                    font-weight: 600;
                    color: #333;
                }

                .amount-input input {
                    width: 100%;
                    padding: 12px;
                    border: 2px solid #e0e0e0;
                    border-radius: 8px;
                    font-size: 16px;
                    box-sizing: border-box;
                }

                .amount-input input:focus {
                    outline: none;
                    border-color: #FF6B35;
                }

                .estimate {
                    margin: 16px 0;
                    padding: 16px;
                    background: #f9f9f9;
                    border-radius: 8px;
                    border: 1px solid #e0e0e0;
                }

                .estimate h4 {
                    margin: 0 0 12px 0;
                    font-size: 16px;
                }

                .estimate-row {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 8px;
                    font-size: 14px;
                }

                .estimate-row.total {
                    margin-top: 8px;
                    padding-top: 8px;
                    border-top: 1px solid #e0e0e0;
                    font-weight: 600;
                }

                .steps {
                    margin-top: 12px;
                    padding-top: 12px;
                    border-top: 1px solid #e0e0e0;
                }

                .steps-label {
                    font-weight: 600;
                    margin-bottom: 8px;
                    font-size: 14px;
                }

                .step {
                    font-size: 13px;
                    color: #666;
                    margin-bottom: 4px;
                }

                .progress {
                    margin: 16px 0;
                }

                .progress-bar {
                    width: 100%;
                    height: 8px;
                    background: #e0e0e0;
                    border-radius: 4px;
                    overflow: hidden;
                }

                .progress-fill {
                    height: 100%;
                    background: #FF6B35;
                    transition: width 0.3s ease;
                }

                .progress-message {
                    margin-top: 8px;
                    font-size: 14px;
                    color: #333;
                }

                .nonce {
                    font-size: 12px;
                    color: #666;
                    font-family: monospace;
                }

                .deposit-button {
                    width: 100%;
                    padding: 16px;
                    background: #FF6B35;
                    color: white;
                    border: none;
                    border-radius: 8px;
                    font-size: 16px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: background 0.2s;
                }

                .deposit-button:hover:not(:disabled) {
                    background: #E55A2B;
                }

                .deposit-button:disabled {
                    background: #ccc;
                    cursor: not-allowed;
                }

                .supported-chains {
                    margin-top: 24px;
                    padding-top: 24px;
                    border-top: 1px solid #e0e0e0;
                }

                .info-label {
                    font-weight: 600;
                    margin-bottom: 8px;
                    font-size: 14px;
                }

                .chain-list {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                    margin-bottom: 12px;
                }

                .chain-tag {
                    padding: 4px 12px;
                    background: #f0f0f0;
                    border-radius: 12px;
                    font-size: 13px;
                    color: #666;
                }

                .info-text {
                    font-size: 13px;
                    color: #666;
                    line-height: 1.5;
                }
            `}</style>
        </div>
    );
}

export default MultichainDepositWidget;

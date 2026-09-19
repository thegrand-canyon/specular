/**
 * Webhook Client SDK
 *
 * Subscribe to Specular credit events and receive real-time notifications
 */

const { ethers } = require('ethers');
const crypto = require('crypto');

class WebhookClient {
    constructor({ webhookServerUrl, wallet }) {
        this.webhookServerUrl = webhookServerUrl;
        this.wallet = wallet;
    }

    /**
     * Subscribe to webhook events
     */
    async subscribe(webhookUrl, events, secret) {
        const body = {
            webhookUrl,
            events,
            secret: secret || undefined
        };

        // Sign the request
        const signature = await this.signRequest(body);

        const response = await fetch(`${this.webhookServerUrl}/subscribe`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Agent-Address': this.wallet.address,
                'X-Signature': signature
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Subscription failed');
        }

        return await response.json();
    }

    /**
     * Get current subscription
     */
    async getSubscription() {
        const signature = await this.signRequest({});

        const response = await fetch(`${this.webhookServerUrl}/subscribe`, {
            method: 'GET',
            headers: {
                'X-Agent-Address': this.wallet.address,
                'X-Signature': signature
            }
        });

        if (response.status === 404) {
            return null;
        }

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to get subscription');
        }

        return await response.json();
    }

    /**
     * Unsubscribe from webhooks
     */
    async unsubscribe() {
        const signature = await this.signRequest({});

        const response = await fetch(`${this.webhookServerUrl}/subscribe`, {
            method: 'DELETE',
            headers: {
                'X-Agent-Address': this.wallet.address,
                'X-Signature': signature
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Unsubscribe failed');
        }

        return await response.json();
    }

    /**
     * List available event types
     */
    async getAvailableEvents() {
        const response = await fetch(`${this.webhookServerUrl}/events`);
        return await response.json();
    }

    /**
     * Sign a request
     */
    async signRequest(body) {
        const message = JSON.stringify(body);
        return await this.wallet.signMessage(message);
    }

    /**
     * Verify webhook signature (for webhook endpoint)
     */
    static verifySignature(payload, signature, secret) {
        const hmac = crypto.createHmac('sha256', secret);
        hmac.update(JSON.stringify(payload));
        const expected = hmac.digest('hex');

        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expected)
        );
    }

    /**
     * Create an Express webhook receiver
     */
    static createReceiver(secret, handlers) {
        const express = require('express');
        const app = express();

        app.use(express.json());

        app.post('/webhook', (req, res) => {
            const signature = req.headers['x-specular-signature'];
            const event = req.headers['x-specular-event'];

            // Verify signature
            if (!WebhookClient.verifySignature(req.body, signature, secret)) {
                return res.status(403).json({ error: 'Invalid signature' });
            }

            // Handle event
            const handler = handlers[event];
            if (handler) {
                try {
                    handler(req.body);
                    res.json({ received: true });
                } catch (error) {
                    console.error('Handler error:', error);
                    res.status(500).json({ error: 'Handler error' });
                }
            } else {
                console.warn('No handler for event:', event);
                res.json({ received: true, warning: 'No handler' });
            }
        });

        return app;
    }
}

module.exports = { WebhookClient };

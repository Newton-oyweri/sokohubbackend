import express from 'express';
import axios from 'axios';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

const PORT = process.env.PORT || 5000;

// Initialize Admin Supabase Client (bypasses RLS for secure background processing)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper function to format Safaricom timestamps (YYYYMMDDHHmmss)
const getTimestamp = () => {
    const now = new Date();
    return now.getFullYear() +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0') +
        String(now.getHours()).padStart(2, '0') +
        String(now.getMinutes()).padStart(2, '0') +
        String(now.getSeconds()).padStart(2, '0');
};

// Helper function to format phone number for M-Pesa
const formatPhoneForMpesa = (phone) => {
    let cleaned = phone.replace(/[\s+\-()]/g, '');
    
    if (cleaned.startsWith('0')) {
        cleaned = '254' + cleaned.substring(1);
    } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
        cleaned = '254' + cleaned;
    } else if (cleaned.startsWith('254')) {
        // Already in correct format
    } else {
        cleaned = '254' + cleaned;
    }
    
    return cleaned;
};

// Middleware: Safaricom Authentication Handler
const generateToken = async (req, res, next) => {
    const secret = process.env.MPESA_CONSUMER_SECRET?.trim();
    const key = process.env.MPESA_CONSUMER_KEY?.trim();
    
    if (!secret || !key) {
        return res.status(500).json({ error: "Safaricom authentication keys are missing in your environment config." });
    }

    const auth = Buffer.from(`${key}:${secret}`).toString('base64');

    try {
        const response = await axios.get(
            'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
            { headers: { Authorization: `Basic ${auth}` } }
        );
        req.token = response.data.access_token;
        next();
    } catch (error) {
        console.error("M-Pesa Access Token Error:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to authenticate with Safaricom system gateway." });
    }
};

// home page
 app.get('/', (req, res) => {
    res.send('Welcome to Wonderbakes Payment Gateway API');
});

/**
 * Route: Initiates Lipa na M-Pesa STK Push
 * Expects JSON payload: { "userId": "UUID-HERE", "amount": 100, "phone": "254792625043" }
 */
app.post('/api/stk-push', generateToken, async (req, res) => {
    const { userId, amount, phone } = req.body;

    console.log('=== STK PUSH REQUEST ===');
    console.log('User ID:', userId);
    console.log('Amount:', amount);
    console.log('Phone received:', phone);

    // Validate required fields
    if (!userId || !amount) {
        return res.status(400).json({ error: "Both userId and amount parameter keys are strictly mandatory." });
    }

    if (!phone) {
        return res.status(400).json({ error: "Phone number is required. Please ensure your profile has a phone number." });
    }

    try {
        // Step 1: Get the user's wallet ID - Check both user_id and id fields
        let walletId = null;
        
        // First try to find wallet using user_id
        const { data: walletByUserId, error: walletErr1 } = await supabase
            .from('wallets')
            .select('id')
            .eq('user_id', userId)
            .maybeSingle();

        if (walletByUserId) {
            walletId = walletByUserId.id;
            console.log('Found wallet by user_id:', walletId);
        } else {
            console.log('No wallet found by user_id, trying id...');
            
            // Try to find wallet using id (since wallet.id might equal user_id in some setups)
            const { data: walletById, error: walletErr2 } = await supabase
                .from('wallets')
                .select('id')
                .eq('id', userId)
                .maybeSingle();
            
            if (walletById) {
                walletId = walletById.id;
                console.log('Found wallet by id:', walletId);
            }
        }

        // If no wallet found, create one
        if (!walletId) {
            console.log('No wallet found, creating new wallet for user:', userId);
            
            const { data: newWallet, error: createWalletErr } = await supabase
                .from('wallets')
                .insert([{
                    user_id: userId,
                    balance: 0,
                    currency: 'KES'
                }])
                .select('id')
                .single();

            if (createWalletErr) {
                console.error('Wallet creation error:', createWalletErr);
                return res.status(500).json({ 
                    error: "Failed to create wallet", 
                    details: createWalletErr.message 
                });
            }

            walletId = newWallet.id;
            console.log('Created new wallet with ID:', walletId);
        }

        // Step 2: Format the phone number for M-Pesa
        const formattedPhone = formatPhoneForMpesa(phone);
        console.log('Formatted phone for M-Pesa:', formattedPhone);

        // Step 3: Configure M-Pesa parameters
        const shortcode = parseInt(process.env.MPESA_SHORTCODE, 10);
        const passkey = process.env.MPESA_PASSKEY;
        const timestamp = getTimestamp();
        const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

        const stkData = {
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerPayBillOnline",
            Amount: parseInt(amount, 10),
            PartyA: parseInt(formattedPhone, 10),
            PartyB: shortcode,
            PhoneNumber: parseInt(formattedPhone, 10),
            CallBackURL: process.env.CALLBACK_URL,
            AccountReference: "Wonderbakes",
            TransactionDesc: `Wallet Deposit`
        };

        console.log('STK Data being sent to Safaricom:', {
            ...stkData,
            Password: '***HIDDEN***'
        });

        // Step 4: Trigger payment gateway request
        const safaricomRes = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            stkData,
            { headers: { Authorization: `Bearer ${req.token}` } }
        );

        console.log('Safaricom response:', safaricomRes.data);

        const { CheckoutRequestID } = safaricomRes.data;

        // Step 5: Record a transaction entry marked as PENDING
        const { error: txError } = await supabase
            .from('wallet_transactions')
            .insert([{
                wallet_id: walletId,
                amount: parseFloat(amount),
                type: 'DEPOSIT',
                status: 'PENDING',
                checkout_request_id: CheckoutRequestID,
                description: 'M-Pesa Wallet Deposit'
            }]);

        if (txError) {
            console.error('Transaction insert error:', txError);
            throw txError;
        }

        return res.status(200).json(safaricomRes.data);

    } catch (error) {
        console.error("STK Push Execution Processing Error:", error.response?.data || error.message);
        return res.status(500).json({ 
            error: "Gateway operation routing failed.", 
            details: error.response?.data || error.message 
        });
    }
});

/**
 * Route: Receives and updates payment status dynamically via Safaricom
 */
app.post('/api/stk-callback', async (req, res) => {
    const { stkCallback } = req.body.Body;
    
    console.log("--- New Incoming M-Pesa Callback Payload Verified ---");
    console.log(JSON.stringify(stkCallback, null, 2));

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = stkCallback;

    try {
        // Step 1: Look up our matching entry in the database
        const { data: transaction, error: fetchTxErr } = await supabase
            .from('wallet_transactions')
            .select('id, wallet_id, amount, status')
            .eq('checkout_request_id', CheckoutRequestID)
            .single();

        if (fetchTxErr || !transaction) {
            console.error(`Transaction record lookup aborted. Reference token ID not identified: ${CheckoutRequestID}`);
            return res.status(200).json({ ResultCode: 0, ResultDesc: "Callback parsed but log reference instance omitted." });
        }

        // Avoid double-processing if callback retries occur
        if (transaction.status !== 'PENDING') {
            return res.status(200).json({ ResultCode: 0, ResultDesc: "Process skipped. Transaction is already settled." });
        }

        // Step 2: Handle transaction outcome
        if (ResultCode === 0) {
            // Extract metadata fields from array
            const items = CallbackMetadata.Item;
            const receiptItem = items.find(i => i.Name === 'MpesaReceiptNumber');
            const mpesaReceipt = receiptItem ? receiptItem.Value : `TXT-${Date.now()}`;

            // Use an administrative transaction chain: Update status and credit wallet balance
            const { error: updateTxErr } = await supabase
                .from('wallet_transactions')
                .update({ status: 'SUCCESS', reference: mpesaReceipt, description: 'M-Pesa Deposit Completed' })
                .eq('id', transaction.id);

            if (updateTxErr) throw updateTxErr;

            // Fetch the active current balance first
            const { data: wallet } = await supabase
                .from('wallets')
                .select('balance')
                .eq('id', transaction.wallet_id)
                .single();

            const currentBalance = parseFloat(wallet?.balance || 0);
            const addedAmount = parseFloat(transaction.amount);

            const { error: updateWalletErr } = await supabase
                .from('wallets')
                .update({ balance: currentBalance + addedAmount, updated_at: new Date() })
                .eq('id', transaction.wallet_id);

            if (updateWalletErr) throw updateWalletErr;

            console.log(`Successfully credited Wallet: ${transaction.wallet_id} with KSh ${addedAmount}`);
        } else {
            // Mark failed transaction status explicitly
            await supabase
                .from('wallet_transactions')
                .update({ status: 'FAILED', description: `Cancelled: ${ResultDesc}` })
                .eq('id', transaction.id);

            console.log(`Transaction logged as FAILED. Response returned code ${ResultCode}: ${ResultDesc}`);
        }

        // Always return an immediate clear 200 message acknowledgment to Safaricom
        return res.status(200).json({ ResultCode: 0, ResultDesc: "Callback event processed successfully." });

    } catch (err) {
        console.error("Critical error inside callback route processing routine:", err.message);
        return res.status(500).json({ error: "Internal processing tracking sequence anomaly detected." });
    }
});

app.listen(PORT, () => {
    console.log(`Wonderbakes payment infrastructure live on port execution environment target: ${PORT}`);
});